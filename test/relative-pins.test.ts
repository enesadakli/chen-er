import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagramPositions, formatLayoutFile, layoutPathFor, readPins, renderFile, writeLayoutFile } from "../src/app/render.js";
import { center, type Diagram, type Pins } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { LayoutFile } from "../src/core/schema.js";
import { pinPoint, relativeAttributePins } from "../src/core/pins.js";

const text = `version: 1
entities:
  PERSON: {attrs: [{name: Name, parts: [First, Last]}]}
  TEAM: {}
relationships:
  JOINS:
    ends: [{entity: PERSON, card: 0..N}, {entity: TEAM, card: 0..N}]
    attrs: [Since]
`;
const model = parseModel(text).model!;
const point = (diagram: Diagram, id: string) => center(diagram.nodes.find((n) => n.id === id)!.box);
const pins: Pins = {
  "A:PERSON.Name": { dx: -180.123456, dy: -120.654321 },
  "A:PERSON.Name.First": { dx: -130.25, dy: -80.75 },
  "A:JOINS.Since": { dx: 110.5, dy: 100.5 },
};
function check(diagram: Diagram, pins: Pins) {
  for (const [id, pin] of Object.entries(pins)) {
    const edge = diagram.edges.find((e) => e.kind !== "end" && e.to === id)!;
    expect(point(diagram, id)).toEqual(pinPoint(pin, point(diagram, edge.from)));
    expect(diagram.nodes.find((n) => n.id === id)!.pinned).toBe(true);
  }
  expect(assessQuality(diagram, pins).pinDrift).toBe(0);
}
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("parent-relative attribute pins", () => {
  it.each(["simple", "layered", "stress"] as const)("follows entity, relationship and composite parent centres with %s", async (engine) => {
    const first = await layout(model, { engine, pins });
    check(first.diagram, pins);
    const positions = diagramPositions(first.diagram);
    const moved: Pins = { ...pins, "E:PERSON": { x: 1250, y: 800 }, "R:JOINS": { x: 1900, y: 1100 } };
    const next = await layout(model, { engine, pins: moved, positions });
    check(next.diagram, pins);
    expect(point(next.diagram, "E:PERSON")).toEqual(moved["E:PERSON"]);
    expect(point(next.diagram, "R:JOINS")).toEqual(moved["R:JOINS"]);
    const fresh = await layout(model, { engine, pins: moved });
    check(fresh.diagram, pins);
    expect(point(next.diagram, "A:PERSON.Name")).not.toEqual(positions["A:PERSON.Name"]);
  });
  it.each(["simple", "layered", "stress"] as const)("resolves a relative part of an unpinned composite after final rounding with %s", async (engine) => {
    const parts: Pins = { "A:PERSON.Name.First": { dx: -120.123456, dy: -85.654321 } };
    const { diagram } = await layout(model, { engine, pins: parts });
    check(diagram, parts);
    expect(diagram.nodes.find((n) => n.id === "A:PERSON.Name")!.pinned).toBe(false);
  });
  it("measures drift against the actual parent, independently of the parent's own pin", async () => {
    const { diagram } = await layout(model, { pins });
    const copy = structuredClone(diagram);
    copy.nodes.find((n) => n.id === "E:PERSON")!.box.x += 2;
    const drift = assessQuality(copy, pins).issues.filter((i) => i.kind === "pin-drift");
    expect(drift.map((i) => i.ids)).toEqual([["A:PERSON.Name"]]);
    copy.nodes.find((n) => n.id === "A:PERSON.Name")!.box.x += 2;
    expect(assessQuality(copy, pins).issues.filter((i) => i.kind === "pin-drift").map((i) => i.ids)).toEqual([["A:PERSON.Name.First"]]);
  });
  it("accepts mixed version 1 pins and rejects mixed coordinates, relative shape pins and nonfinite offsets", () => {
    expect(LayoutFile.parse({ version: 1, pins: { ...pins, "E:PERSON": { x: 40, y: -90 } } }).pins).toEqual({ ...pins, "E:PERSON": { x: 40, y: -90 } });
    for (const value of [{ "E:PERSON": { dx: 1, dy: 2 } }, { "R:JOINS": { dx: 1, dy: 2 } },
      { "A:PERSON.Name": { dx: Infinity, dy: 2 } }, { "A:PERSON.Name": { x: 1, dy: 2 } },
      { "A:PERSON.Name": { x: 1, y: 2, dx: 3, dy: 4 } }]) {
      expect(LayoutFile.safeParse({ version: 1, pins: value }).success).toBe(false);
    }
  });
  it.each(["pin", "position", "engine"])("honours legacy centres on read and converts all attributes without a jump on a %s write", async (kind) => {
    dir = mkdtempSync(join(tmpdir(), "chen-relative-"));
    const path = join(dir, "model.er.yaml"); writeFileSync(path, text);
    const before = (await layout(model, { pins })).diagram;
    const centres = diagramPositions(before);
    const legacy = Object.fromEntries([...Object.keys(pins), "E:PERSON", "R:JOINS"].map((id) => [id, centres[id]!]));
    const bytes = JSON.stringify({ version: 1, pins: legacy, positions: centres });
    writeFileSync(layoutPathFor(path), bytes);
    const current = await renderFile(path);
    expect(readPins(path).options.pins).toEqual(legacy);
    expect(readFileSync(layoutPathFor(path), "utf8")).toBe(bytes);
    for (const [id, pin] of Object.entries(legacy)) expect(point(current.diagram!, id)).toEqual(pin);
    const patch = kind === "pin" ? { pins: legacy } : kind === "position" ? { positions: centres } : { engine: "layered" as const };
    writeLayoutFile(path, patch, current.diagram!);
    const saved = readPins(path).options;
    expect(saved.pins).toEqual(relativeAttributePins(legacy, current.diagram!));
    expect(saved.pins!["E:PERSON"]).toEqual(legacy["E:PERSON"]);
    expect(saved.pins!["R:JOINS"]).toEqual(legacy["R:JOINS"]);
    const next = await renderFile(path);
    for (const id of Object.keys(legacy)) {
      const a = point(next.diagram!, id), b = point(current.diagram!, id);
      expect(a.x).toBeCloseTo(b.x, 10); expect(a.y).toBeCloseTo(b.y, 10);
    }
  });
  it("requires displayed geometry instead of guessing a legacy attribute parent's centre", () => {
    expect(() => formatLayoutFile({ pins: { "A:PERSON.Name": { x: 1, y: 2 } } }, {})).toThrow("Current diagram required");
  });
});
