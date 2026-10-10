import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve, type ViewerState } from "../src/app/serve.js";
import { diagramPositions, layoutPathFor, quality, readPins } from "../src/app/render.js";
import { center } from "../src/core/geometry.js";
import * as layoutService from "../src/core/layout/index.js";
import { parseModel } from "../src/core/normalize.js";

const fixture = "test/fixtures/pinned-spoke/university.er.yaml";
const source = readFileSync(fixture, "utf8");
const grown = source.replace("relationships:", "  CAMPUS:\n    attrs: [CampusId]\n    keys: [[CampusId]]\nrelationships:")
  + "  LOCATED_IN:\n    ends:\n      - {entity: DEPARTMENT, card: 1..1}\n      - {entity: CAMPUS, card: 0..N}\n";
let dir: string, model: string, viewer: Awaited<ReturnType<typeof serve>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-auto-")); model = join(dir, "university.er.yaml");
  copyFileSync(fixture, model); copyFileSync(layoutPathFor(fixture), layoutPathFor(model));
});
afterEach(async () => { vi.restoreAllMocks(); await viewer?.close(); viewer = undefined; rmSync(dir, { recursive: true, force: true }); });
const get = async () => await (await fetch(`${viewer!.url}/api/state`)).json() as ViewerState;
async function changed(text: string) {
  const before = await get(); writeFileSync(model, text);
  for (const end = Date.now() + 10000; Date.now() < end;) {
    const state = await get(); if (state.updatedAt > before.updatedAt && state.yaml === text && !state.computing) return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("Model was not refreshed");
}
const post = (path: string, body: unknown) => fetch(viewer!.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function removeAttributePins() {
  const saved = JSON.parse(readFileSync(layoutPathFor(model), "utf8"));
  delete saved.pins["A:COURSE.Title"]; delete saved.pins["A:ENROLLS.Semester"];
  writeFileSync(layoutPathFor(model), JSON.stringify(saved));
}

describe("automatic viewer re-layout", () => {
  it("keeps incremental for CAMPUS/LOCATED_IN when fixed attribute spokes would cross shapes and edges", async () => {
    viewer = await serve(model, { port: 0 });
    const before = readPins(model).options, beforePins = before.pins!;
    const spy = vi.spyOn(layoutService, "layout");
    const next = await changed(grown);
    expect(spy).toHaveBeenCalledTimes(2);
    const incremental = await spy.mock.results[0]!.value as Awaited<ReturnType<typeof layoutService.layout>>;
    const fresh = await spy.mock.results[1]!.value as Awaited<ReturnType<typeof layoutService.layout>>;
    expect(quality(incremental.diagram, beforePins)).toMatchObject({ hierarchyViolations: 4, shapeCrossings: 0, spokeEdgeViolations: 0, edgeCrossings: 0, pinDrift: 0 });
    expect(quality(fresh.diagram, beforePins)).toMatchObject({ hierarchyViolations: 0, shapeCrossings: 3, spokeEdgeViolations: 2, edgeCrossings: 3, pinDrift: 0 });
    expect(next).toMatchObject({ autoRelayout: false, history: { canUndo: false, canRedo: false }, quality: { hierarchyViolations: 4, shapeCrossings: 0, spokeEdgeViolations: 0 } });
    expect(next.diagram).toEqual(incremental.diagram);
    expect(readPins(model).options.pins).toEqual(beforePins);
    for (const id of ["E:COURSE", "R:ENROLLS"]) expect(readPins(model).options.positions![id]).toEqual(before.positions![id]);
    for (const [id, p] of Object.entries(beforePins)) expect(center(next.diagram!.nodes.find((n) => n.id === id)!.box)).toEqual(p);
  });
  it("accepts clean fresh for CAMPUS/LOCATED_IN without the two attribute pins and restores exact previous layout bytes on undo", async () => {
    removeAttributePins();
    viewer = await serve(model, { port: 0 });
    const beforeBytes = readFileSync(layoutPathFor(model)), beforePins = readPins(model).options.pins!;
    expect((await get()).quality!.hierarchyViolations).toBe(3);
    const spy = vi.spyOn(layoutService, "layout");
    const next = await changed(grown);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![1]!.positions).toBeDefined();
    expect(spy.mock.calls[1]![1]!.positions).toBeUndefined();
    const incremental = await spy.mock.results[0]!.value as Awaited<ReturnType<typeof layoutService.layout>>;
    expect(quality(incremental.diagram, beforePins)).toMatchObject({ hierarchyViolations: 4, shapeCrossings: 0, spokeEdgeViolations: 0, edgeCrossings: 0, pinDrift: 0 });
    expect(next).toMatchObject({ autoRelayout: true, history: { canUndo: true, canRedo: false }, quality: {
      hierarchyViolations: 0, overlaps: 0, shapeCrossings: 0, labelCollisions: 0, labelAmbiguity: 0, labelLoose: 0,
      labelOnOwnEdge: 0, labelOnAnyEdge: 0, spokeEdgeViolations: 0, spokeLabelViolations: 0, diagonalEnds: 0,
      attributeEdgeBends: 0, edgeOverlap: 0, tinySegments: 0, endPortCrowding: 0, diamondVertexViolations: 0,
      doubleEdgeArtifacts: 0, edgeCrossings: 0, pinDrift: 0,
    } });
    expect(next.quality!.issues).toEqual([]);
    const accepted = readFileSync(layoutPathFor(model));
    expect(accepted).not.toEqual(beforeBytes);
    expect(readPins(model).options.pins).toEqual(beforePins);
    const saved = readPins(model).options.positions!;
    for (const [id, p] of Object.entries(diagramPositions(next.diagram!))) expect(saved[id]).toEqual({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    for (const [id, p] of Object.entries(beforePins)) expect(center(next.diagram!.nodes.find((n) => n.id === id)!.box)).toEqual(p);
    const res = await post("/api/history/undo", { expectedLayoutRevision: next.layoutRevision });
    expect(res.status).toBe(200);
    const undone = await res.json() as ViewerState;
    expect(undone.autoRelayout).toBe(false); expect(undone.history.canRedo).toBe(true);
    expect(readFileSync(layoutPathFor(model))).toEqual(beforeBytes); expect(readFileSync(model, "utf8")).toBe(grown);
    expect((await post("/api/history/redo", { expectedLayoutRevision: undone.layoutRevision })).status).toBe(200);
    expect(readFileSync(layoutPathFor(model))).toEqual(accepted);
  });
  it("runs only incremental for attribute and label edits", async () => {
    viewer = await serve(model, { port: 0 });
    const before = await get(), spy = vi.spyOn(layoutService, "layout");
    const next = await changed(source.replace("- Name", "- Name\n      - Email").replace("title: University", "title: Campus"));
    expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0]![1]!.positions).toBeDefined();
    expect(next.autoRelayout).toBe(false); expect(next.history.canUndo).toBe(false);
    for (const n of before.diagram!.nodes.filter((n) => n.kind === "entity")) expect(center(next.diagram!.nodes.find((other) => other.id === n.id)!.box)).toEqual(center(n.box));
  });
  it("keeps incremental when both candidates tie", async () => {
    viewer = await serve(model, { port: 0 });
    const original = layoutService.layout;
    const incremental = await original(parseModel(grown).model!, readPins(model).options);
    const spy = vi.spyOn(layoutService, "layout").mockResolvedValue(incremental);
    const next = await changed(grown);
    expect(spy).toHaveBeenCalledTimes(2); expect(next.autoRelayout).toBe(false); expect(next.history.canUndo).toBe(false);
    expect(next.diagram).toEqual(incremental.diagram);
  });
  it("compares endpoint changes against the last good model even after an invalid intermediate edit", async () => {
    viewer = await serve(model, { port: 0 });
    const spy = vi.spyOn(layoutService, "layout");
    await changed("version: [invalid]\n");
    expect(spy).not.toHaveBeenCalled();
    await changed(source.replace("entity: STUDENT", "id: student, entity: INSTRUCTOR"));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![1]!.positions).toBeUndefined();
  });
  it("preserves pin precision through automatic position writes", async () => {
    const saved = readPins(model).options;
    const pins = { ...saved.pins, "A:COURSE.Title": { x: 552.123456, y: 276.654321 } };
    writeFileSync(layoutPathFor(model), JSON.stringify({ version: 1, ...saved, pins }));
    viewer = await serve(model, { port: 0 });
    expect(readPins(model).options.pins).toEqual(pins);
    await changed(grown);
    expect(readPins(model).options.pins).toEqual(pins);
  });
  it("keeps computing visible while the second sequential candidate is pending", async () => {
    removeAttributePins();
    viewer = await serve(model, { port: 0 });
    const original = layoutService.layout;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const waiting = new Promise<void>((done) => { release = done; });
    let calls = 0;
    vi.spyOn(layoutService, "layout").mockImplementation(async (...args) => {
      if (++calls === 2) { entered(); await waiting; }
      return original(...args);
    });
    const abort = new AbortController();
    const stream = await fetch(`${viewer.url}/api/events`, { signal: abort.signal });
    const reader = stream.body!.getReader();
    const events: ViewerState[] = [];
    let sawComputing!: () => void;
    const computing = new Promise<void>((done) => { sawComputing = done; });
    const reading = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          buffer += new TextDecoder().decode(part.value);
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = /^data: (.+)$/m.exec(event)?.[1];
            if (event.includes("event: state") && data) {
              const state = JSON.parse(data) as ViewerState; events.push(state);
              if (state.computing) sawComputing();
            }
          }
        }
      } catch { /* stream aborted */ }
    })();
    const next = changed(grown);
    try {
      await started; await computing;
      expect(calls).toBe(2); expect(events.at(-1)!.computing).toBe(true);
      expect(events.filter((s) => !s.computing)).toHaveLength(1);
    } finally { release(); }
    expect((await next).autoRelayout).toBe(true);
    abort.abort(); await reading;
  });
  it("defers the structural comparison and all automatic writes until a running turn finishes", async () => {
    removeAttributePins();
    const bin = join(dir, "wait.mjs"), release = join(dir, "finish");
    writeFileSync(bin, `#!/usr/bin/env node
import { existsSync } from "node:fs";
setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);
`);
    chmodSync(bin, 0o755);
    viewer = await serve(model, { port: 0, agent: { kind: "claude", bin, persist: false } });
    const beforeBytes = readFileSync(layoutPathFor(model));
    const start = await fetch(viewer.url + "/api/agent/turns", { method: "POST", headers: { "Content-Type": "application/json", "X-Chen-Token": viewer.token! }, body: JSON.stringify({ text: "Wait", selection: [] }) });
    expect(start.status).toBe(202);
    await start.json();
    const spy = vi.spyOn(layoutService, "layout");
    const mid = await changed(grown);
    expect(spy).toHaveBeenCalledTimes(1); expect(mid.autoRelayout).toBe(false);
    expect(readFileSync(layoutPathFor(model))).toEqual(beforeBytes);
    writeFileSync(release, "finish");
    let after = await get();
    for (const end = Date.now() + 5000; !after.autoRelayout && Date.now() < end;) {
      await new Promise((done) => setTimeout(done, 20)); after = await get();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(after).toMatchObject({ autoRelayout: true, history: { canUndo: true }, quality: { hierarchyViolations: 0, pinDrift: 0 } });
    expect(readFileSync(layoutPathFor(model))).not.toEqual(beforeBytes);
  });
});
