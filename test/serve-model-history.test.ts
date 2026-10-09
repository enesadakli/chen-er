import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve, type ViewerState } from "../src/app/serve.js";
import { layoutPathFor, STARTER_MODEL } from "../src/app/render.js";
import { revision } from "../src/app/model-mutations.js";
import * as mutations from "../src/app/model-mutations.js";
import * as layoutService from "../src/core/layout/index.js";
import * as lintService from "../src/core/lint/index.js";

let dir: string, model: string, viewer: Awaited<ReturnType<typeof serve>>;
const initialYaml = `# Preserve these exact bytes on undo\n${STARTER_MODEL}`;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "chen-history-")); model = join(dir, "sample.er.yaml"); writeFileSync(model, initialYaml); viewer = await serve(model, { port: 0 }); });
afterEach(async () => { vi.restoreAllMocks(); await viewer?.close(); rmSync(dir, { recursive: true, force: true }); });
const get = async () => await (await fetch(`${viewer.url}/api/state`)).json() as ViewerState;
const post = (path: string, value: unknown) => fetch(viewer.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const refs = (s: ViewerState) => ({ expectedRevision: s.modelRevision, expectedLayoutRevision: s.layoutRevision });
const add = (s: ViewerState, name = "Email", ownerId = "E:STUDENT") => post("/api/model/attributes", { expectedRevision: s.modelRevision, ownerId, attribute: { name } });

describe("viewer model edits and server-session history", () => {
  it("publishes byte revisions/JSON-safe metadata and saves an attribute without dropping comments", async () => {
    const before = await get(); expect(before.modelRevision).toBe(revision(readFileSync(model)));
    expect(before.layoutRevision).toBe(revision(readFileSync(layoutPathFor(model))));
    expect(before.selection.owners.find((o) => o.id === "R:ENROLLS")).toMatchObject({ kind: "relationship" });
    expect(before.selection.relationships[0]!.entityIds).toEqual(["E:STUDENT", "E:COURSE"]);
    const response = await add(before); expect(response.status).toBe(200);
    const after = await response.json() as ViewerState;
    expect(after.diagram!.nodes.some((n) => n.id === "A:STUDENT.Email")).toBe(true);
    expect(after.yaml).toContain("# Preserve these exact bytes on undo"); expect(after.history).toEqual({ canUndo: true, canRedo: false });
    expect(after.modelRevision).not.toBe(before.modelRevision);
  });
  it("restores exact model and layout bytes, including comments, through undo and redo", async () => {
    const before = await get(), beforeModel = readFileSync(model), beforeLayout = readFileSync(layoutPathFor(model));
    const edited = await (await add(before)).json() as ViewerState;
    const afterModel = readFileSync(model), afterLayout = readFileSync(layoutPathFor(model));
    const undone = await post("/api/history/undo", refs(edited)); expect(undone.status).toBe(200);
    const state = await undone.json() as ViewerState;
    expect(readFileSync(model)).toEqual(beforeModel); expect(readFileSync(layoutPathFor(model))).toEqual(beforeLayout);
    expect(state.history).toEqual({ canUndo: false, canRedo: true });
    expect((await post("/api/history/redo", refs(state))).status).toBe(200);
    expect(readFileSync(model)).toEqual(afterModel); expect(readFileSync(layoutPathFor(model))).toEqual(afterLayout);
  });
  it("coherently records pin, reset, relayout and engine edits, but refresh alone creates no history", async () => {
    const before = await get(); expect(before.history.canUndo).toBe(false);
    const pinned = await (await post("/api/pins", { ...refs(before), pins: { "E:STUDENT": { x: 80, y: 120 } } })).json() as ViewerState;
    const pinBytes = readFileSync(layoutPathFor(model));
    const reset = await (await fetch(`${viewer.url}/api/pins`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(refs(pinned)) })).json() as ViewerState;
    expect(reset.pins).toEqual({});
    const undoReset = await (await post("/api/history/undo", refs(reset))).json() as ViewerState;
    expect(undoReset.pins["E:STUDENT"]).toEqual({ x: 80, y: 120 }); expect(readFileSync(layoutPathFor(model))).toEqual(pinBytes);
    const engine = await (await post("/api/engine", { ...refs(undoReset), engine: "stress" })).json() as ViewerState;
    expect(engine.engine).toBe("stress"); expect(engine.history.canRedo).toBe(false);
    const undoEngine = await (await post("/api/history/undo", refs(engine))).json() as ViewerState;
    expect(undoEngine.engine).toBe(undoReset.engine); expect(readFileSync(layoutPathFor(model))).toEqual(pinBytes);
    const fresh = await (await post("/api/relayout", refs(undoEngine))).json() as ViewerState;
    expect((await post("/api/history/undo", refs(fresh))).status).toBe(200);
    expect(readFileSync(layoutPathFor(model))).toEqual(pinBytes);
  });
  it("rejects stale concurrent model writes and validates new errors without rejecting course/warning findings", async () => {
    const before = await get();
    const responses = await Promise.all([add(before, "Email"), add(before, "Age")]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await get(), bytes = readFileSync(model);
    vi.spyOn(lintService, "lint").mockImplementation((m) => m.entities[0]!.attrs.some((a) => a.name === "Rejected") ? [{ rule: "test", severity: "error", message: "New error" }] : []);
    expect((await add(current, "Rejected")).status).toBe(422); expect(readFileSync(model)).toEqual(bytes);
    vi.spyOn(lintService, "lint").mockReturnValue([{ rule: "test", severity: "warning", message: "Accepted warning" }]);
    expect((await add(await get(), "Accepted")).status).toBe(200);
  });
  it.each(["model", "layout"])("never undoes over an external %s write even before the watcher runs", async (which) => {
    const edited = await (await add(await get())).json() as ViewerState;
    const path = which === "model" ? model : layoutPathFor(model);
    const text = which === "model" ? readFileSync(model, "utf8") + "# external edit\n" : JSON.stringify({ version: 1, pins: { "E:COURSE": { x: 300, y: 100 } } });
    writeFileSync(path, text);
    expect((await post("/api/history/undo", refs(edited))).status).toBe(409);
    const latest = await get(); expect(latest.history).toEqual({ canUndo: false, canRedo: false });
    if (which === "model") expect(readFileSync(path, "utf8")).toBe(text);
    else expect(JSON.parse(readFileSync(path, "utf8")).pins).toEqual({ "E:COURSE": { x: 300, y: 100 } });
    expect((await post("/api/history/undo", refs(latest))).status).toBe(409);
  });
  it("signals asynchronous computation and does not record an edit across an external change during layout", async () => {
    const original = layoutService.layout;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(layoutService, "layout").mockImplementationOnce(async (...args) => { entered(); await waiting; return original(...args); });
    const before = await get();
    const abort = new AbortController(); const stream = await fetch(`${viewer.url}/api/events`, { signal: abort.signal });
    const reader = stream.body!.getReader(); let text = "";
    let sawComputing!: () => void; const computing = new Promise<void>((resolve) => { sawComputing = resolve; });
    const reading = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); if (text.includes('"computing":true')) sawComputing(); } } catch { /* aborted */ } })();
    const response = add(before);
    await started;
    await computing;
    const external = readFileSync(model, "utf8") + "# edited during layout\n"; writeFileSync(model, external);
    release(); expect((await response).status).toBe(409);
    abort.abort(); await reading;
    expect(text).toContain('"computing":true'); expect(readFileSync(model, "utf8")).toBe(external);
    expect((await get()).history.canUndo).toBe(false);
  });
  it("preserves an external layout write if two-file undo can only restore the model", async () => {
    const edited = await (await add(await get())).json() as ViewerState;
    const original = mutations.replaceBytes;
    const externalLayout = JSON.stringify({ version: 1, pins: { "E:COURSE": { x: 333, y: 222 } } });
    vi.spyOn(mutations, "replaceBytes").mockImplementationOnce((...args) => {
      original(...args); writeFileSync(layoutPathFor(model), externalLayout);
    });
    expect((await post("/api/history/undo", refs(edited))).status).toBe(409);
    expect(readFileSync(model, "utf8")).toBe(initialYaml);
    expect(readFileSync(layoutPathFor(model), "utf8")).toBe(externalLayout);
    expect((await get()).history).toEqual({ canUndo: false, canRedo: false });
  });
  it("rejects a replaced symlink model, stale history revisions and unknown request fields", async () => {
    const state = await get();
    expect((await post("/api/history/undo", { expectedRevision: state.modelRevision })).status).toBe(400);
    expect((await post("/api/model/attributes", { expectedRevision: state.modelRevision, ownerId: "E:STUDENT", attribute: { name: "Email" }, path: "other" })).status).toBe(400);
    const external = join(dir, "external.yaml"); writeFileSync(external, initialYaml); unlinkSync(model); symlinkSync(external, model);
    expect((await add(state)).status).toBe(403); expect(readFileSync(external, "utf8")).toBe(initialYaml);
  });
});
