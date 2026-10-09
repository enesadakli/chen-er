import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anchor, center } from "../src/core/geometry.js";
import { DEFAULT_ENGINE, engines, layout } from "../src/core/layout/index.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { LayoutFile } from "../src/core/schema.js";

const inputs = ["bench/fixtures", "examples", "examples/private"].flatMap((dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".er.yaml")).sort().map((f) => `${dir}/${f}`) : []);
if (process.env.CHEN_ER_PRIVATE_MODEL && !inputs.includes(process.env.CHEN_ER_PRIVATE_MODEL)) inputs.push(process.env.CHEN_ER_PRIVATE_MODEL);
const load = (input: string) => {
  const parsed = parseModel(readFileSync(input, "utf8"));
  if (!parsed.model) throw new Error(JSON.stringify(parsed.diagnostics));
  const path = input.replace(/\.er\.yaml$/, ".er.layout.json");
  const pins = input === "bench/fixtures/pinned.er.yaml" && existsSync(path) ? LayoutFile.parse(JSON.parse(readFileSync(path, "utf8"))).pins : {};
  return { model: parsed.model, pins };
};

describe.each(Object.keys(engines) as (keyof typeof engines)[])("%s layout", (engine) => {
  it.each(inputs)("satisfies quality and deterministic geometry: %s", async (input) => {
    const { model, pins } = load(input);
    const first = await layout(model, { engine, pins });
    expect(JSON.stringify(await layout(model, { engine, pins }))).toBe(JSON.stringify(first));
    const q = assessQuality(first.diagram, pins);
    expect({ overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, pinDrift: q.pinDrift }).toEqual({ overlaps: 0, shapeCrossings: 0, labelCollisions: 0, pinDrift: 0 });
    if (engine === DEFAULT_ENGINE) {
      expect(q.labelAmbiguity).toBe(0);
      expect(q.labelLoose).toBe(0);
      for (const entity of first.diagram.nodes.filter((n) => n.kind === "entity")) {
        const ends = first.diagram.edges.filter((e) => e.kind === "end" && e.to === entity.id);
        for (let i = 0; i < ends.length; i++) for (const other of ends.slice(i + 1)) {
          const a = ends[i]!.points.at(-1)!, b = other.points.at(-1)!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(28 - 1e-7);
        }
        for (const attr of first.diagram.edges.filter((e) => e.kind === "attribute" && e.from === entity.id)) {
          for (const end of ends) {
            const a = attr.points[0]!, b = end.points.at(-1)!;
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(14 - 1e-7);
          }
        }
      }
      expect(q.aspect).toBeGreaterThanOrEqual(0.5);
      expect(q.aspect).toBeLessThanOrEqual(2);
      expect(q.meanEdgeRatio).toBeLessThanOrEqual(3.5);
      if (input.endsWith("/university-curriculum.er.yaml")) {
        expect(q.aspect).toBeGreaterThanOrEqual(0.6);
        expect(q.aspect).toBeLessThanOrEqual(1.8);
        expect(q.longestEdgeRatio).toBeLessThanOrEqual(7);
        expect(Math.max(first.diagram.width, first.diagram.height)).toBeLessThanOrEqual(2800);
        expect(q.edgeCrossings).toBeLessThanOrEqual(2);
      }
    }
    if (!Object.keys(pins).length) expect(q.issues.filter((i) => i.kind === "out-of-canvas")).toEqual([]);
    for (const [id, pin] of Object.entries(pins)) expect(center(first.diagram.nodes.find((n) => n.id === id)!.box)).toEqual(pin);
    for (const e of first.diagram.edges) {
      const from = first.diagram.nodes.find((n) => n.id === e.from)!;
      const to = first.diagram.nodes.find((n) => n.id === e.to)!;
      expect(e.points[0]!.x).toBeCloseTo(anchor(from, e.points[0]!).x, 5);
      expect(e.points[0]!.y).toBeCloseTo(anchor(from, e.points[0]!).y, 5);
      expect(e.points.at(-1)!.x).toBeCloseTo(anchor(to, e.points.at(-1)!).x, 5);
      expect(e.points.at(-1)!.y).toBeCloseTo(anchor(to, e.points.at(-1)!).y, 5);
    }
  }, 60000);
  it("keeps recursive ends distinct and labels each role", async () => {
    const { model } = load("bench/fixtures/recursive.er.yaml");
    const { diagram } = await layout(model, { engine });
    const ends = diagram.edges.filter((e) => e.from === "R:SUPERVISION");
    expect(ends).toHaveLength(2);
    expect(ends[0]!.points).not.toEqual(ends[1]!.points);
    expect(diagram.labels.filter((l) => l.kind === "role").map((l) => l.text)).toEqual(["supervisor", "supervisee"]);
    expect(assessQuality({ ...diagram, edges: ends }).edgeCrossings).toBe(0);
  });
  it("marks only the identifying weak-entity end as double", async () => {
    const { model } = load("examples/library.er.yaml");
    const { diagram } = await layout(model, { engine });
    expect(diagram.edges.filter((e) => e.double).map((e) => e.end)).toEqual(["COPY_OF#1"]);
  });
  it("retains conflicting pins and reports them", async () => {
    const model = parseModel("version: 1\nentities:\n  A: {}\n  B: {}\n").model!;
    const pins = { "E:A": { x: 200, y: 200 }, "E:B": { x: 200, y: 200 } };
    const res = await layout(model, { engine, pins });
    expect(assessQuality(res.diagram, pins).pinDrift).toBe(0);
    expect(assessQuality(res.diagram, pins).overlaps).toBe(1);
    expect(res.diagnostics.some((d) => d.rule === "pin-conflict" && d.severity === "warning")).toBe(true);
  });
  it("routes pinned ends around a foreign shape", async () => {
    const model = parseModel("version: 1\nentities:\n  A: {}\n  B: {}\n  OBSTACLE: {}\nrelationships:\n  LINKS:\n    ends: [{entity: A, card: 1..1}, {entity: B, card: 0..N}]\n").model!;
    const pins = { "E:A": { x: 250, y: 300 }, "E:B": { x: 1100, y: 300 }, "E:OBSTACLE": { x: 750, y: 300 }, "R:LINKS": { x: 500, y: 300 } };
    const result = await layout(model, { engine, pins });
    const q = assessQuality(result.diagram, pins);
    expect(q.shapeCrossings).toBe(0);
    expect(q.labelCollisions).toBe(0);
    expect(q.pinDrift).toBe(0);
    expect(result.diagram.edges.find((e) => e.to === "E:B")!.points.length).toBeGreaterThan(2);
  });
  it("honors attribute and composite-part pins and moves an unpinned owner away", async () => {
    const model = parseModel("version: 1\nentities:\n  A:\n    attrs: [{name: Name, parts: [First, Last]}]\n").model!;
    const pins = { "A:A.Name": { x: 237, y: 300 }, "A:A.Name.First": { x: 50, y: 150 } };
    const result = await layout(model, { engine, pins });
    const q = assessQuality(result.diagram, pins);
    expect(q.overlaps).toBe(0);
    expect(q.shapeCrossings).toBe(0);
    expect(q.pinDrift).toBe(0);
    for (const [id, pin] of Object.entries(pins)) expect(center(result.diagram.nodes.find((n) => n.id === id)!.box)).toEqual(pin);
  });
  it("keeps negative pins without producing a negative canvas", async () => {
    const model = parseModel("version: 1\nentities:\n  A: {}\n").model!;
    const pins = { "E:A": { x: -300, y: -300 } };
    const result = await layout(model, { engine, pins });
    expect(center(result.diagram.nodes[0]!.box)).toEqual(pins["E:A"]);
    expect(result.diagram.width).toBeGreaterThan(0);
    expect(result.diagram.height).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.rule === "pin-conflict")).toBe(true);
  });
  it("supports empty and disconnected graphs", async () => {
    const empty = await layout(parseModel("version: 1\nentities: {}\n").model!, { engine });
    expect(empty.diagram.nodes).toEqual([]);
    expect(empty.diagram.width).toBeGreaterThan(0);
    expect(empty.diagram.height).toBeGreaterThan(0);
    const disconnected = await layout(parseModel("version: 1\nentities:\n  A: {attrs: [Code]}\n  B: {attrs: [Name]}\n").model!, { engine });
    expect(assessQuality(disconnected.diagram).issues).toEqual([]);
  });
});

it("registers all engines and selects the bench winner", () => {
  expect(Object.keys(engines).sort()).toEqual(["layered", "simple", "stress"]);
  expect(DEFAULT_ENGINE).toBe("layered");
});
