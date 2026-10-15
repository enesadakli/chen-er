import { describe, expect, it } from "vitest";
import { center, type LayoutResult } from "../src/core/geometry.js";
import { finishSpecializations, isSpecializationId, specializationOf, withSpecializationProxies } from "../src/core/layout/eer.js";
import { layout } from "../src/core/layout/index.js";
import { pointSegmentDistance } from "../src/core/layout/label-geometry.js";
import { hierarchyPairs, modelRelations } from "../src/core/layout/semantic-graph.js";
import { distance, segments } from "../src/core/layout/shapes.js";
import { normalize } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { specializationSize, style } from "../src/core/style.js";

const model = () => normalize({
  version: 1,
  entities: {
    DEVICE: { attrs: ["Class", "Serial"], keys: [["Serial"]] },
    LAPTOP: { attrs: ["Screen"] }, SERVER: { attrs: ["Rack"] }, PORTABLE: {},
    ACCOUNT: { attrs: ["Number"], keys: [["Number"]] }, PERSONAL: {}, SHARED: {},
    LOCATION: { attrs: ["Code"], keys: [["Code"]] },
  },
  relationships: { STORED_AT: { ends: [{ entity: "SERVER", card: "0..N" }, { entity: "LOCATION", card: "1..1" }] } },
  specializations: [
    { id: "device_kind", supertype: "DEVICE", subtypes: [{ entity: "LAPTOP", predicate: "'Laptop'" }, { entity: "SERVER", predicate: "Class = 'Server'" }], disjointness: "disjoint", completeness: "total", attribute: "Class" },
    { id: "portable", supertype: "DEVICE", subtypes: ["PORTABLE"], disjointness: "disjoint", completeness: "partial" },
    { id: "account_kind", supertype: "ACCOUNT", subtypes: ["PERSONAL", "SHARED"], disjointness: "overlapping", completeness: "partial" },
  ],
});

const small = () => normalize({ version: 1, entities: { ROOT: {}, LEFT: {}, RIGHT: {} }, specializations: [
  { id: "branch", supertype: "ROOT", subtypes: ["LEFT", "RIGHT"], disjointness: "disjoint", completeness: "partial" },
] });

describe("EER layout", () => {
  it("preserves plain ER identity and attaches specialization metadata only to proxies", () => {
    const plain = normalize({ version: 1, entities: { ITEM: {} } });
    expect(withSpecializationProxies(plain)).toBe(plain);
    const m = model(), proxy = withSpecializationProxies(m);
    expect(proxy.entities).toBe(m.entities);
    expect(m.relationships).toHaveLength(1);
    expect(proxy.relationships[0]).toBe(m.relationships[0]);
    for (const spec of m.specializations) {
      const r = proxy.relationships.find((r) => r.id === spec.id)!;
      expect(specializationOf(r)).toBe(spec);
      expect(r).toMatchObject({ name: spec.name, label: "", attrs: [], path: spec.path });
      expect(r.ends.map((e) => e.id)).toEqual([`${spec.id}#super`, ...spec.subtypes.map((name) => `${spec.id}#${name}`)]);
    }
    expect(specializationOf(m.relationships[0]!)).toBeUndefined();
    expect(isSpecializationId("S:branch")).toBe(true);
    expect(isSpecializationId("R:branch")).toBe(false);
    expect(hierarchyPairs(modelRelations(proxy))).toEqual(expect.arrayContaining([
      { parent: "E:DEVICE", child: "E:LAPTOP" }, { parent: "E:DEVICE", child: "E:PORTABLE" },
    ]));
    expect(hierarchyPairs(modelRelations(small()))).toHaveLength(2);
  });

  it("lays out circles, direct lines, predicates and ordinary relationships deterministically", async () => {
    const m = model(), first = await layout(m), { diagram } = first;
    const node = (id: string) => diagram.nodes.find((n) => n.id === id)!;
    expect(await layout(m)).toEqual(first);
    expect(node("S:device_kind")).toMatchObject({ kind: "specialization", double: false, specialization: { symbol: "d" }, box: specializationSize() });
    expect(node("S:account_kind").specialization).toEqual({ symbol: "o" });
    expect(node("S:portable").specialization).toEqual({});
    for (const spec of m.specializations) {
      const circle = node(spec.id), c = center(circle.box);
      expect(center(node(`E:${spec.supertype}`).box).y).toBeLessThan(c.y);
      for (const name of spec.subtypes) expect(c.y).toBeLessThan(center(node(`E:${name}`).box).y);
      const ends = diagram.edges.filter((e) => e.from === spec.id);
      expect(ends.map((e) => e.id)).toEqual([`edge:${spec.id}#super`, ...spec.subtypes.map((name) => `edge:${spec.id}#${name}`)]);
      for (const edge of ends) {
        expect(edge.kind).toBe("end");
        expect(edge.double).toBe(edge.end === `${spec.id}#super` && spec.completeness === "total");
        const start = edge.points[0]!;
        if (spec.subtypes.length === 1) expect(start).toEqual(c);
        else expect(((start.x - c.x) / (circle.box.w / 2)) ** 2 + ((start.y - c.y) / (circle.box.h / 2)) ** 2).toBeCloseTo(1, 8);
        expect(diagram.labels.some((l) => l.edge === edge.id && l.kind !== "specialization")).toBe(false);
        if (edge.end === `${spec.id}#super`) { expect(edge.subset).toBeUndefined(); continue; }
        const { at, toward } = edge.subset!;
        expect(Math.hypot(toward.x, toward.y)).toBeCloseTo(1, 10);
        const line = segments(edge.points).find(([a, b]) => pointSegmentDistance(at, a, b) < 1e-7)!;
        expect(line).toBeDefined();
        const [a, b] = line;
        expect(toward.x * (b.x - a.x) + toward.y * (b.y - a.y)).toBeCloseTo(-distance(a, b), 8);
        for (const p of edge.points) expect(distance(at, p)).toBeGreaterThanOrEqual(style.specialization.subsetRadius + 6 - 1e-6);
      }
    }
    expect(diagram.labels.filter((l) => l.kind === "specialization").map((l) => [l.id, l.text])).toEqual([
      ["label:edge:S:device_kind#super:specialization", "Class"],
      ["label:edge:S:device_kind#LAPTOP:specialization", "'Laptop'"],
      ["label:edge:S:device_kind#SERVER:specialization", "Class = 'Server'"],
    ]);
    expect(node("A:LAPTOP.Screen").kind).toBe("attribute");
    expect(node("R:STORED_AT").kind).toBe("relationship");
    const q = assessQuality(diagram, {}, m);
    expect({ overlaps: q.overlaps, shapes: q.shapeCrossings, labels: q.labelCollisions, crossings: q.edgeCrossings, hierarchy: q.hierarchyViolations }).toEqual({ overlaps: 0, shapes: 0, labels: 0, crossings: 0, hierarchy: 0 });
  });

  it("keeps absolute specialization pins and saved centres during incremental layout", async () => {
    const m = small(), pins = { "S:branch": { x: 620.5, y: 410.25 } };
    const first = await layout(m, { pins });
    const positions = Object.fromEntries(first.diagram.nodes.map((n) => [n.id, center(n.box)]));
    const next = await layout(m, { pins, positions });
    expect(center(next.diagram.nodes.find((n) => n.id === "S:branch")!.box)).toEqual(pins["S:branch"]);
    expect(next.diagram.nodes.find((n) => n.id === "S:branch")!.pinned).toBe(true);
    const restored = await layout(m, { positions });
    expect(center(restored.diagram.nodes.find((n) => n.id === "S:branch")!.box)).toEqual(pins["S:branch"]);
    expect(restored.diagram.nodes.find((n) => n.id === "S:branch")!.pinned).toBe(false);
  });

  it.each(["layered", "stress", "simple"] as const)("separates three subclass departures in the %s engine", async (engine) => {
    const m = small();
    m.entities.push({ ...m.entities[1]!, id: "E:MIDDLE", name: "MIDDLE", label: "MIDDLE" });
    m.specializations[0]!.subtypes.push("MIDDLE");
    m.specializations[0]!.completeness = "total";
    const { diagram } = await layout(m, { engine });
    const circle = diagram.nodes.find((n) => n.id === "S:branch")!;
    const y = (id: string) => center(diagram.nodes.find((n) => n.id === id)!.box).y;
    expect(y("E:ROOT")).toBeLessThan(center(circle.box).y);
    for (const name of m.specializations[0]!.subtypes) expect(center(circle.box).y).toBeLessThan(y(`E:${name}`));
    const q = assessQuality(diagram, {}, m);
    expect(q.edgeCrossings).toBe(0);
    expect(q.edgeOverlap).toBe(0);
    expect(q.shapeCrossings).toBe(0);
    expect(q.diamondVertexViolations).toBe(0);
    expect(assessQuality(diagram).hierarchyViolations).toBe(0);
  });

  it("projects offset ports onto circles and shifts midpoint subset marks clear of bends and labels", () => {
    const m = small();
    const result: LayoutResult = { diagnostics: [], diagram: {
      width: 400, height: 400, notes: [], meta: { engine: "simple" },
      nodes: [{ id: "S:branch", kind: "relationship", label: "", box: { x: 85, y: 85, w: 30, h: 30 }, double: false }],
      edges: [{ id: "edge:S:branch#LEFT", end: "S:branch#LEFT", from: "S:branch", to: "E:LEFT", kind: "end", double: false,
        points: [{ x: 105, y: 110 }, { x: 105, y: 200 }, { x: 260, y: 200 }] }],
      labels: [{ id: "label:test", kind: "specialization", edge: "edge:S:branch#LEFT", text: "left", box: { x: 140, y: 203, w: 40, h: 18 } }],
    } };
    const { diagram } = finishSpecializations(result, m), edge = diagram.edges[0]!;
    expect(edge.points[0]!.x).toBe(105);
    expect(distance(edge.points[0]!, { x: 100, y: 100 })).toBeCloseTo(15, 8);
    expect(edge.subset!.at.y).toBe(200);
    expect(edge.subset!.at.x < 127 || edge.subset!.at.x > 193).toBe(true);
    for (const bend of edge.points) expect(distance(edge.subset!.at, bend)).toBeGreaterThanOrEqual(13);
    expect(edge.subset!.toward).toEqual({ x: -1, y: -0 });
    const plain = normalize({ version: 1, entities: {} });
    expect(finishSpecializations(result, plain)).toBe(result);
  });
});
