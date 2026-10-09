import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve, type ViewerState } from "../src/app/serve.js";
import { layoutPathFor, STARTER_MODEL } from "../src/app/render.js";
import { revision } from "../src/app/file-guard.js";
import * as layoutService from "../src/core/layout/index.js";

let dir: string, model: string, viewer: Awaited<ReturnType<typeof serve>>;
const initialYaml = `# Preserve these exact bytes on undo\n${STARTER_MODEL}`;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "chen-history-")); model = join(dir, "sample.er.yaml"); writeFileSync(model, initialYaml); viewer = await serve(model, { port: 0 }); });
afterEach(async () => { vi.restoreAllMocks(); await viewer?.close(); rmSync(dir, { recursive: true, force: true }); });
const get = async () => await (await fetch(`${viewer.url}/api/state`)).json() as ViewerState;
const post = (path: string, value: unknown) => fetch(viewer.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const refs = (s: ViewerState) => ({ expectedLayoutRevision: s.layoutRevision });
const pin = (s: ViewerState, id = "E:STUDENT", x = 80) => post("/api/pins", { ...refs(s), pins: { [id]: { x, y: 120 } } });

describe("viewer layout history and the read-only model", () => {
  it("publishes a layout revision and selection metadata, but no model revision", async () => {
    const before = await get();
    expect(before.layoutRevision).toBe(revision(readFileSync(layoutPathFor(model))));
    expect("modelRevision" in before).toBe(false);
    expect(before.selection.owners.find((o) => o.id === "R:ENROLLS")).toMatchObject({ kind: "relationship" });
    expect(before.selection.relationships[0]!.entityIds).toEqual(["E:STUDENT", "E:COURSE"]);
  });
  it("no route writes the model file, and the removed attribute route is gone", async () => {
    const bytes = readFileSync(model);
    const state = await get();
    expect((await post("/api/model/attributes", { ownerId: "E:STUDENT", attribute: { name: "Email" } })).status).toBe(404);
    const calls: Array<[string, string]> = [["POST", "/api/pins"], ["DELETE", "/api/pins"], ["POST", "/api/engine"], ["POST", "/api/relayout"], ["POST", "/api/history/undo"], ["POST", "/api/history/redo"], ["POST", "/api/model"], ["PUT", "/api/model"]];
    for (const [method, path] of calls) {
      await fetch(viewer.url + path, { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify({ ...refs(state), pins: { "E:STUDENT": { x: 1, y: 2 } }, engine: "stress" }) });
      expect(readFileSync(model)).toEqual(bytes);
    }
    // Model bytes also survive undo/redo of layout edits.
    const pinned = await (await pin(await get())).json() as ViewerState;
    const undone = await (await post("/api/history/undo", refs(pinned))).json() as ViewerState;
    await post("/api/history/redo", refs(undone));
    expect(readFileSync(model)).toEqual(bytes);
  });
  it("restores exact layout bytes through undo and redo", async () => {
    const before = await get(), beforeLayout = readFileSync(layoutPathFor(model));
    const pinned = await (await pin(before)).json() as ViewerState;
    const afterLayout = readFileSync(layoutPathFor(model));
    const state = await (await post("/api/history/undo", refs(pinned))).json() as ViewerState;
    expect(readFileSync(layoutPathFor(model))).toEqual(beforeLayout);
    expect(state.history).toEqual({ canUndo: false, canRedo: true });
    expect((await post("/api/history/redo", refs(state))).status).toBe(200);
    expect(readFileSync(layoutPathFor(model))).toEqual(afterLayout);
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
  it.each(["model", "layout"])("never undoes over an external %s write even before the watcher runs", async (which) => {
    const edited = await (await pin(await get())).json() as ViewerState;
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
    const response = pin(before);
    await started;
    await computing;
    const external = readFileSync(model, "utf8") + "# edited during layout\n"; writeFileSync(model, external);
    release(); expect((await response).status).toBe(409);
    abort.abort(); await reading;
    expect(text).toContain('"computing":true'); expect(readFileSync(model, "utf8")).toBe(external);
    expect((await get()).history.canUndo).toBe(false);
  });
  it("rejects history requests without a layout revision, unknown fields and a stale pin write", async () => {
    const state = await get();
    expect((await post("/api/history/undo", {})).status).toBe(400);
    expect((await post("/api/pins", { ...refs(state), pins: { "E:STUDENT": { x: 1, y: 2 } }, path: "other" })).status).toBe(400);
    await pin(state);
    expect((await pin(state, "E:COURSE", 200)).status).toBe(409);
  });
});
