import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync, readdirSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import * as lintService from "../src/core/lint/index.js";
import { serve, type ViewerState } from "../src/app/serve.js";
import { center } from "../src/core/geometry.js";
import { layoutPathFor, STARTER_MODEL } from "../src/app/render.js";

let dir: string, model: string, viewer: Awaited<ReturnType<typeof serve>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chen-serve-")); model = join(dir, "sample.er.yaml");
  writeFileSync(model, STARTER_MODEL);
  viewer = await serve(model, { port: 0 });
}, 20000);
afterEach(async () => { await viewer?.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const getState = async () => await (await fetch(`${viewer.url}/api/state`)).json() as ViewerState;
const post = (path: string, value: unknown) => fetch(viewer.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
/** Polls for an expected state; the ceiling is generous because file watchers lag under machine load. */
async function eventually(test: () => Promise<boolean>, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await test()) return; await new Promise((done) => setTimeout(done, 20)); }
  throw new Error(`No state update within ${ms / 1000} seconds.`);
}

describe("local viewer server", () => {
  it("binds loopback and serves clean SVG, geometry, quality, YAML and targeted findings", async () => {
    expect(viewer.server.address()).toMatchObject({ address: "127.0.0.1" });
    vi.spyOn(lintService, "lint").mockReturnValue([{ rule: "test-finding", severity: "course", path: "entities.STUDENT.weak", message: "Review the weak entity.", line: 5 }]);
    writeFileSync(model, STARTER_MODEL.replace("  STUDENT:", "  STUDENT:\n    weak: true"));
    await eventually(async () => (await getState()).yaml.includes("weak: true"));
    const state = await getState();
    expect(state.modelPath).toBe(model);
    expect(state.svg).toContain('<g data-id="E:STUDENT"');
    expect(state.diagram!.nodes.length).toBeGreaterThan(0);
    expect(state.quality).toHaveProperty("implemented");
    expect(state.diagnostics.some((d) => d.target === "E:STUDENT")).toBe(true);
    expect((await fetch(viewer.url)).status).toBe(200);
  });
  it("merges pin centers, preserves the engine, unpins one node and clears all", async () => {
    const initial = await getState();
    expect((await post("/api/engine", { engine: "stress" })).status).toBe(200);
    expect((await post("/api/pins", { pins: { "E:STUDENT": { x: 400, y: 240 } } })).status).toBe(200);
    expect((await post("/api/pins", { pins: { "E:COURSE": { x: 640, y: 240 } } })).status).toBe(200);
    const file = JSON.parse(readFileSync(layoutPathFor(model), "utf8"));
    expect(file.engine).toBe("stress");
    expect(Object.keys(file.pins)).toHaveLength(2);
    const state = await getState();
    expect(state.engine).toBe("stress");
    expect(state.pins["E:STUDENT"]).toEqual({ x: 400, y: 240 });
    expect(state.diagram!.nodes.find((n) => n.id === "E:STUDENT")?.pinned).toBe(true);
    const before = state.diagram!.nodes.find((n) => n.id === "E:STUDENT")!.box;
    const course = state.diagram!.nodes.find((n) => n.id === "E:COURSE")!.box;
    expect(course.x + course.w / 2 - before.x - before.w / 2).toBeCloseTo(240);
    expect(state.diagram).not.toEqual(initial.diagram);
    expect((await fetch(`${viewer.url}/api/pins/${encodeURIComponent("E:STUDENT")}`, { method: "DELETE" })).status).toBe(200);
    expect(Object.keys((await getState()).pins)).toEqual(["E:COURSE"]);
    expect((await fetch(`${viewer.url}/api/pins`, { method: "DELETE" })).status).toBe(200);
    expect((await getState()).pins).toEqual({});
    expect(JSON.parse(readFileSync(layoutPathFor(model), "utf8")).engine).toBe("stress");
    expect(readFileSync(model, "utf8")).toBe(STARTER_MODEL);
  });
  it("stores attribute offsets, follows owner drops, preserves pins in history and unpins by Delete's route", async () => {
    const pins = { "A:COURSE.Title": { dx: 120.123456, dy: -85.654321 } };
    const response = await post("/api/pins", { pins }); expect(response.status).toBe(200);
    const initial = await response.json() as ViewerState;
    expect(initial.pins).toEqual(pins); expect(initial.quality!.pinDrift).toBe(0);
    const move = await post("/api/pins", { pins: { "E:COURSE": { x: 1200, y: 800 } } });
    expect(move.status).toBe(200);
    const next = await move.json() as ViewerState;
    const attribute = next.diagram!.nodes.find((n) => n.id === "A:COURSE.Title")!;
    expect(center(attribute.box)).toEqual({ x: 1320.123456, y: 714.345679 });
    expect(attribute.pinned).toBe(true); expect(next.quality!.pinDrift).toBe(0);
    expect((await post("/api/history/undo", { expectedLayoutRevision: next.layoutRevision })).status).toBe(200);
    expect((await getState()).pins).toEqual(pins);
    expect((await post("/api/history/redo", { expectedLayoutRevision: (await getState()).layoutRevision })).status).toBe(200);
    expect((await getState()).pins["A:COURSE.Title"]).toEqual(pins["A:COURSE.Title"]);
    expect((await fetch(`${viewer.url}/api/pins/${encodeURIComponent("A:COURSE.Title")}`, { method: "DELETE" })).status).toBe(200);
    const unpinned = await getState();
    expect(unpinned.pins["A:COURSE.Title"]).toBeUndefined();
    expect(unpinned.diagram!.nodes.find((n) => n.id === "A:COURSE.Title")!.pinned).toBe(false);
  });
  it("converts an absolute attribute centre sent by an older viewer against current geometry", async () => {
    const state = await getState(), parent = center(state.diagram!.nodes.find((n) => n.id === "E:COURSE")!.box);
    const response = await post("/api/pins", { pins: { "A:COURSE.Title": { x: parent.x + 123.456789, y: parent.y - 80.123456 } } });
    expect(response.status).toBe(200);
    const next = await response.json() as ViewerState;
    expect(next.pins["A:COURSE.Title"]).toEqual({ dx: parent.x + 123.456789 - parent.x, dy: parent.y - 80.123456 - parent.y });
    expect(next.quality!.pinDrift).toBe(0);
    expect((await post("/api/pins", { pins: { "E:COURSE": { dx: 1, dy: 2 } } })).status).toBe(400);
  });
  it("emits full SSE states after model edits, layout edits and API writes", async () => {
    const abort = new AbortController();
    const response = await fetch(`${viewer.url}/api/events`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    const reading = (async () => {
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } }
      catch { /* Aborting the SSE request ends the test stream. */ }
    })();
    try {
      await eventually(async () => text.includes("event: state"));
      writeFileSync(model, STARTER_MODEL.replace("Course enrollment", "Edited notebook"));
      await eventually(async () => text.includes('"title":"Edited notebook"'));
      await post("/api/pins", { pins: { "E:STUDENT": { x: 408, y: 248 } } });
      await eventually(async () => text.includes('"x":408,"y":248'));
      writeFileSync(layoutPathFor(model), JSON.stringify({ version: 1, engine: "layered", pins: {} }));
      await eventually(async () => text.includes('"engine":"layered"'));
    } finally { abort.abort(); await reading; }
  });
  it("picks up edits through the stat poll when fs.watch reports nothing, without idle state events", async () => {
    await viewer.close();
    viewer = await serve(model, { port: 0, watch: false });
    const abort = new AbortController();
    const response = await fetch(`${viewer.url}/api/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    let text = "";
    const reading = (async () => {
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } }
      catch { /* Aborting the SSE request ends the test stream. */ }
    })();
    const states = () => text.split("event: state").length - 1;
    try {
      await eventually(async () => states() > 0);
      const idle = states();
      await new Promise((done) => setTimeout(done, 2500));
      expect(states()).toBe(idle);
      writeFileSync(model, STARTER_MODEL.replace("Course enrollment", "Polled notebook"));
      await eventually(async () => text.includes('"title":"Polled notebook"'), 5000);
      expect((await getState()).title).toBe("Polled notebook");
    } finally { abort.abort(); await reading; }
  }, 20_000);
  it("returns null figures and diagnostics for invalid models, then recovers", async () => {
    writeFileSync(model, "version: [\n");
    await eventually(async () => { const s = await getState(); return s.yaml === "version: [\n" && s.svg === null; });
    const state = await getState();
    expect(state.diagram).toBeNull(); expect(state.diagnostics[0]?.severity).toBe("error");
    expect(state.yaml).toBe("version: [\n");
    expect((await fetch(`${viewer.url}/api/export.svg`)).status).toBe(409);
    writeFileSync(model, STARTER_MODEL);
    await eventually(async () => { const s = await getState(); return s.yaml === STARTER_MODEL && !!s.svg; });
    expect((await getState()).diagram).not.toBeNull();
  }, 30_000);
  it("exports a clean SVG and PNG without screen overlays", async () => {
    const svg = await fetch(`${viewer.url}/api/export.svg`);
    expect(svg.headers.get("content-disposition")).toContain("attachment");
    const text = await svg.text(); expect(text).toBe((await getState()).svg);
    expect(text).not.toMatch(/minor-grid|major-grid|class="mark"/);
    const png = await fetch(`${viewer.url}/api/export.png?scale=2`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect((await fetch(`${viewer.url}/api/export.png?scale=-1`)).status).toBe(400);
  });
  it("rejects non-JSON, oversized and malformed requests and arbitrary write paths", async () => {
    expect((await fetch(`${viewer.url}/api/pins`, { method: "POST", body: '{}' })).status).toBe(415);
    expect((await fetch(`${viewer.url}/api/pins`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{' })).status).toBe(400);
    expect((await post("/api/pins", { pins: {}, padding: "a".repeat(1_048_576) })).status).toBe(413);
    expect((await fetch(`${viewer.url}/api/pins`, { method: "DELETE", body: '{}' })).status).toBe(415);
    expect((await fetch(`${viewer.url}/api/pins`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ padding: "a".repeat(1_048_576) }) })).status).toBe(413);
    expect((await post("/api/pins", { pins: { "E:STUDENT": { x: "8", y: 8 } } })).status).toBe(400);
    expect((await post("/api/pins", { pins: { "../outside": { x: 8, y: 8 } } })).status).toBe(400);
    expect((await post("/api/pins", { pins: {}, path: join(dir, "outside.json") })).status).toBe(400);
    expect((await post("/api/engine", { engine: "unknown" })).status).toBe(400);
    expect((await post("/api/write", { path: model, yaml: "" })).status).toBe(404);
    expect((await fetch(`${viewer.url}/api/pins`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.invalid" }, body: '{"pins":{}}' })).status).toBe(403);
    const wrongHost = await new Promise<number>((done, reject) => {
      const req = request(`${viewer.url}/api/state`, { headers: { Host: "elsewhere.invalid" } }, (res) => { res.resume(); done(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    expect(wrongHost).toBe(403);
    // The server only ever writes the model's own layout file (soft positions are saved on startup).
    expect(readdirSync(dir).sort()).toEqual(["sample.er.layout.json", "sample.er.yaml"]);
    expect(readFileSync(model, "utf8")).toBe(STARTER_MODEL);
  });
  it("rejects layout symlinks, dangling symlinks and hardlinks without modifying their targets", async () => {
    const external = join(dir, "external.json"); writeFileSync(external, '{"version":1,"pins":{}}');
    for (const make of [() => symlinkSync(external, layoutPathFor(model)), () => symlinkSync(join(dir, "missing.json"), layoutPathFor(model)), () => linkSync(external, layoutPathFor(model))]) {
      if (existsSync(layoutPathFor(model))) unlinkSync(layoutPathFor(model));
      make();
      expect((await post("/api/pins", { pins: {} })).status).toBe(403);
      unlinkSync(layoutPathFor(model));
    }
    expect(readFileSync(external, "utf8")).toBe('{"version":1,"pins":{}}');
  });
  it("serializes simultaneous pin writes without losing pins and emits monotonic states", async () => {
    const responses = await Promise.all([
      post("/api/pins", { pins: { "E:STUDENT": { x: 320, y: 200 } } }),
      post("/api/pins", { pins: { "E:COURSE": { x: 640, y: 200 } } }),
    ]);
    const states = await Promise.all(responses.map(async (response) => await response.json() as ViewerState));
    expect(states[0]!.updatedAt).not.toBe(states[1]!.updatedAt);
    expect(Object.keys((await getState()).pins).sort()).toEqual(["E:COURSE", "E:STUDENT"]);
  });
  it("does not overwrite an invalid layout file during a write", async () => {
    writeFileSync(layoutPathFor(model), "bad layout");
    expect((await post("/api/pins", { pins: {} })).status).toBe(409);
    expect(readFileSync(layoutPathFor(model), "utf8")).toBe("bad layout");
  });
  it("moves only the dragged node and keeps the drawing after a restart; relayout starts fresh", async () => {
    const centers = (st: ViewerState) => Object.fromEntries(st.diagram!.nodes.map((n) => [n.id, { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h / 2 }]));
    const before = centers(await getState());
    const target = { x: before["E:STUDENT"]!.x - 240, y: before["E:STUDENT"]!.y };
    const after = centers(await (await post("/api/pins", { pins: { "E:STUDENT": target } })).json() as ViewerState);
    expect(after["E:STUDENT"]).toEqual(target);
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 0.1;
    for (const id of ["E:COURSE", "R:ENROLLS"]) expect(near(after[id]!, before[id]!)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(layoutPathFor(model), "utf8")).positions)).toContain("E:COURSE");

    await viewer.close();
    viewer = await serve(model, { port: 0 });
    expect(near(centers(await getState())["E:COURSE"]!, after["E:COURSE"]!)).toBe(true);

    const fresh = await (await post("/api/relayout", {})).json() as ViewerState;
    expect(fresh.pins).toEqual({ "E:STUDENT": target });
    expect(centers(fresh)["E:STUDENT"]).toEqual(target);
  }, 20000);
});
