import { describe, expect, it } from "vitest";
import { center, type DEdge, type Diagram, type LayoutResult } from "../src/core/geometry.js";
import { fanEndAnchors } from "../src/core/layout/anchors.js";
import { circleOf, finishSpecializations, isChildEnd, isSpecializationId, rootEndId, specializationOf, withSpecializationProxies } from "../src/core/layout/eer.js";
import { layout } from "../src/core/layout/index.js";
import { boxSegmentDistance, pointSegmentDistance } from "../src/core/layout/label-geometry.js";
import { placeLabels } from "../src/core/layout/labels.js";
import { hierarchyPairs, modelRelations } from "../src/core/layout/semantic-graph.js";
import { semanticRoute } from "../src/core/layout/semantic-route.js";
import { distance, segments } from "../src/core/layout/shapes.js";
import { normalize } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { specializationSize, style } from "../src/core/style.js";
import { interMetrics } from "../src/core/text/metrics.js";

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
  it("packs wide parallel subclass groups on a narrower grid without sacrificing hard quality", async () => {
    const m = normalize({
      version: 1,
      entities: {
        MESSAGE: { attrs: ["Format", "Transport", "Key"], keys: [["Key"]] },
        TEXT_MESSAGE: { attrs: ["Length"] }, IMAGE_MESSAGE: { attrs: ["Resolution"] }, AUDIO_MESSAGE: { attrs: ["Duration"] },
        PUSH_MESSAGE: {}, MAIL_MESSAGE: {}, FEED_MESSAGE: {}, CHANNEL: { attrs: ["Address"] },
      },
      relationships: { DELIVERED_TO: { ends: [{ entity: "MAIL_MESSAGE", card: "0..N" }, { entity: "CHANNEL", card: "1..1" }] } },
      specializations: [
        { id: "format", supertype: "MESSAGE", subtypes: [
          { entity: "TEXT_MESSAGE", predicate: "'Text'" }, { entity: "IMAGE_MESSAGE", predicate: "'Image'" }, { entity: "AUDIO_MESSAGE", predicate: "'Audio'" },
        ], attribute: "Format", disjointness: "disjoint", completeness: "total" },
        { id: "transport", supertype: "MESSAGE", subtypes: ["PUSH_MESSAGE", "MAIL_MESSAGE", "FEED_MESSAGE"], disjointness: "overlapping", completeness: "partial" },
      ],
    });
    const first = await layout(m), { diagram } = first;
    expect(await layout(m)).toEqual(first);
    const at = (id: string) => center(diagram.nodes.find((n) => n.id === id)!.box);
    const subclasses = m.specializations.flatMap((s) => s.subtypes).sort((a, b) => at(`E:${a}`).x - at(`E:${b}`).x);
    for (const spec of m.specializations) {
      const positions = spec.subtypes.map((name) => subclasses.indexOf(name)).sort((a, b) => a - b);
      expect(positions.at(-1)! - positions[0]!).toBe(spec.subtypes.length - 1);
      const points = spec.subtypes.map((name) => at(`E:${name}`)), circle = at(spec.id);
      expect(at(`E:${spec.supertype}`).y).toBeLessThan(circle.y);
      for (const p of points) expect(circle.y).toBeLessThan(p.y);
      expect(Math.abs(circle.x - points.reduce((sum, p) => sum + p.x, 0) / points.length)).toBeLessThanOrEqual(64);
    }
    expect(at(`E:${subclasses[1]}`).x - at(`E:${subclasses[0]}`).x).toBeLessThan(430);
    const q = assessQuality(diagram, {}, m);
    expect(q.aspect).toBeGreaterThanOrEqual(0.5);
    expect(q.aspect).toBeLessThanOrEqual(2);
    expect(q.meanEdgeRatio).toBeLessThanOrEqual(3.5);
    expect(q.endBendsMax).toBeLessThanOrEqual(2);
    expect(q.issues).toEqual([]);
    expect(q.diagonalEnds + q.attributeEdgeBends + q.edgeOverlap + q.tinySegments + q.endPortCrowding + q.doubleEdgeArtifacts
      + q.spokeEdgeViolations + q.spokeLabelViolations + q.hierarchyViolations).toBe(0);
  });

  it.each(["super", "LEFT"].flatMap((end) => (["end", "attribute", "part"] as const).map((kind) => ({ end, kind }))))(
    "puts the $end specialization label away from a neighbouring $kind in every orientation", ({ end, kind }) => {
    const m = withSpecializationProxies(normalize({ version: 1, entities: { ROOT: {}, LEFT: {}, RIGHT: {} }, specializations: [
      { id: "branch", supertype: "ROOT", subtypes: [{ entity: "LEFT", predicate: "'Alpha'" }, "RIGHT"], attribute: "Kind", disjointness: "disjoint", completeness: "total" },
    ] }));
    for (const horizontal of [false, true]) for (const side of [-1, 1]) {
      const transform = (x: number, y: number) => horizontal ? { x: y, y: x } : { x, y };
      const edge: DEdge = { id: `edge:S:branch#${end}`, end: `S:branch#${end}`, from: "S:branch", to: `E:${end === "super" ? "ROOT" : end}`,
        kind: "end", double: end === "super", points: [transform(250, 200), transform(250, end === "super" ? 50 : 400)] };
      // Both sides pass the existing nearest-edge and 2:1 ownership checks.
      const neighbour: DEdge = { id: "neighbour", from: "S:neighbour", to: "E:OTHER", kind, double: kind === "end",
        points: [transform(250 + side * 100, 20), transform(250 + side * 100, 450)] };
      const edges = [edge, neighbour], labels = placeLabels(m, [], edges, interMetrics);
      expect(labels).toHaveLength(1);
      const label = labels[0]!, c = center(label.box);
      expect((horizontal ? c.y - 250 : c.x - 250) * side).toBeLessThan(0);
      const reflected = horizontal ? { ...label.box, y: 500 - label.box.y - label.box.h } : { ...label.box, x: 500 - label.box.x - label.box.w };
      const clearance = (box: typeof label.box) => Math.min(...segments(neighbour.points).map(([a, b]) => boxSegmentDistance(box, a, b)));
      expect(clearance(label.box)).toBeGreaterThan(clearance(reflected));
      const diagram: Diagram = { width: 600, height: 600, nodes: [], edges, labels, notes: [], meta: { engine: "layered" } };
      expect(assessQuality(diagram).labelAmbiguity).toBe(0);
      const wrong = assessQuality({ ...diagram, labels: [{ ...label, box: reflected }] });
      expect(wrong.labelAmbiguity).toBe(1);
      expect(wrong.issues.some((i) => i.kind === "label-ambiguity" && i.message.includes("opposite side"))).toBe(true);
    }
  });

  it("places a shared subclass of a lattice under its nearest superclass without crossings", async () => {
    const m = normalize({
      version: 1,
      entities: {
        ACCOUNT: { attrs: ["Handle"], keys: [["Handle"]] }, LISTENER: {}, ARTIST: {}, FREE_LISTENER: {}, PREMIUM_LISTENER: {},
        SOLO_ARTIST: {}, BAND: {}, CURATOR: { attrs: ["Playlist_count"] }, LABEL: { attrs: ["Label_id"], keys: [["Label_id"]] },
      },
      relationships: { SIGNED_TO: { ends: [{ entity: "ARTIST", card: "0..1" }, { entity: "LABEL", card: "0..N" }] } },
      specializations: [
        { id: "role", supertype: "ACCOUNT", subtypes: ["LISTENER", "ARTIST"], disjointness: "overlapping", completeness: "total" },
        { id: "tier", supertype: "LISTENER", subtypes: ["FREE_LISTENER", "PREMIUM_LISTENER"], disjointness: "disjoint", completeness: "total" },
        { id: "act", supertype: "ARTIST", subtypes: ["SOLO_ARTIST", "BAND", "CURATOR"], disjointness: "overlapping", completeness: "partial" },
        { id: "curates", supertype: "PREMIUM_LISTENER", subtypes: ["CURATOR"], disjointness: "disjoint", completeness: "partial" },
      ],
    });
    const first = await layout(m), { diagram } = first;
    expect(await layout(m)).toEqual(first);
    const at = (id: string) => center(diagram.nodes.find((n) => n.id === id)!.box);
    // CURATOR sits below both superclasses, under the deeper one rather than at the far edge of its sibling row.
    expect(at("E:CURATOR").y).toBeGreaterThan(at("E:PREMIUM_LISTENER").y);
    expect(Math.abs(at("E:CURATOR").x - at("E:PREMIUM_LISTENER").x)).toBeLessThan(Math.abs(at("E:CURATOR").x - at("E:BAND").x));
    for (const spec of ["S:act", "S:curates"]) {
      const edge = diagram.edges.find((e) => e.end === `${spec}#CURATOR`)!;
      expect(edge.subset).toBeDefined();
      expect(edge.to).toBe("E:CURATOR");
    }
    const q = assessQuality(diagram, {}, m);
    expect(q.edgeCrossings + q.overlaps + q.shapeCrossings + q.labelCollisions + q.edgeNodeClearanceViolations + q.hierarchyViolations).toBe(0);
    expect(q.endBendsMax).toBeLessThanOrEqual(3);
    expect(q.issues).toEqual([]);
  });

  it("draws a total category under a u circle between its superclasses", async () => {
    const m = normalize({
      version: 1,
      entities: {
        ASSET: { attrs: ["Asset_tag"], keys: [["Asset_tag"]] }, BUILDING: { attrs: ["Address"] }, MACHINE: { attrs: ["Serial"] },
        FLEET_CAR: { attrs: ["Plate"], keys: [["Plate"]] }, INSURED_ITEM: { attrs: ["Premium"] }, POLICY: { attrs: ["Policy_no"], keys: [["Policy_no"]] },
      },
      relationships: { COVERED_BY: { ends: [{ entity: "INSURED_ITEM", card: "1..1" }, { entity: "POLICY", card: "1..N" }] } },
      specializations: [{ supertype: "ASSET", subtypes: ["BUILDING", "MACHINE"], disjointness: "disjoint", completeness: "partial" }],
      categories: [{ supertypes: ["BUILDING", "MACHINE", "FLEET_CAR"], subtype: "INSURED_ITEM", completeness: "total" }],
    });
    const first = await layout(m), { diagram } = first;
    expect(await layout(m)).toEqual(first);
    const circle = diagram.nodes.find((n) => n.id === "U:INSURED_ITEM.0")!;
    expect(circle).toMatchObject({ kind: "specialization", label: "", double: false, specialization: { symbol: "u" } });
    const at = (id: string) => center(diagram.nodes.find((n) => n.id === id)!.box), c = center(circle.box);
    for (const parent of ["BUILDING", "MACHINE", "FLEET_CAR"]) expect(at(`E:${parent}`).y).toBeLessThan(c.y);
    expect(c.y).toBeLessThan(at("E:INSURED_ITEM").y);
    expect(Math.abs(at("E:INSURED_ITEM").x - c.x)).toBeLessThan(1);
    const ends = diagram.edges.filter((e) => e.from === circle.id);
    expect(ends.map((e) => e.end).sort()).toEqual(["U:INSURED_ITEM.0#BUILDING", "U:INSURED_ITEM.0#FLEET_CAR", "U:INSURED_ITEM.0#MACHINE", "U:INSURED_ITEM.0#sub"]);
    for (const e of ends) {
      const own = e.end === "U:INSURED_ITEM.0#sub";
      expect(e.double).toBe(own);
      expect(!!e.subset).toBe(own);
      expect(distance(e.points[0]!, c)).toBeCloseTo(circle.box.w / 2, 5);
    }
    const sub = ends.find((e) => e.end === "U:INSURED_ITEM.0#sub")!;
    expect(sub.points.length).toBe(2);
    // The mark opens toward the circle.
    expect(sub.subset!.toward.y).toBeLessThan(0);
    expect(diagram.labels.filter((l) => ends.some((e) => e.id === l.edge))).toEqual([]);
    const q = assessQuality(diagram, {}, m);
    expect(q.edgeCrossings + q.overlaps + q.shapeCrossings + q.labelCollisions + q.edgeNodeClearanceViolations + q.hierarchyViolations).toBe(0);
    expect(q.issues).toEqual([]);
  });

  it("builds category proxies whose root end is the category", () => {
    const m = normalize({ version: 1, entities: { A: {}, B: {}, C: {} }, categories: [{ id: "union", supertypes: ["A", "B"], subtype: "C", completeness: "partial" }] });
    const r = withSpecializationProxies(m).relationships.find((r) => r.id === "U:union")!;
    expect(specializationOf(r)).toBeUndefined();
    expect(circleOf(r)).toEqual({ kind: "category", root: "C", fan: ["A", "B"], completeness: "partial" });
    expect(r.ends.map((e) => e.id)).toEqual(["U:union#sub", "U:union#A", "U:union#B"]);
    expect(rootEndId("U:union")).toBe("U:union#sub");
    expect(rootEndId("S:x")).toBe("S:x#super");
    expect(r.ends.map((e) => isChildEnd("U:union", e.id))).toEqual([true, false, false]);
    expect(isChildEnd("S:x", "S:x#super")).toBe(false);
    expect(isChildEnd("S:x", "S:x#B")).toBe(true);
    expect(hierarchyPairs(modelRelations(m))).toEqual([{ parent: "E:A", child: "E:C" }, { parent: "E:B", child: "E:C" }]);
  });

  it("uses a side port when a subclass's upper corridor hits a distant relationship diamond", () => {
    const nodes: Diagram["nodes"] = [
      { id: "S:branch", kind: "relationship", label: "", box: { x: 385, y: 285, w: 30, h: 30 }, double: false },
      { id: "E:CHILD", kind: "entity", label: "CHILD", box: { x: 745, y: 577, w: 110, h: 46 }, double: false },
      { id: "R:BLOCK", kind: "relationship", label: "BLOCK", box: { x: 720, y: 368, w: 160, h: 64 }, double: false },
    ];
    const edge: DEdge = { id: "edge:S:branch#CHILD", end: "S:branch#CHILD", kind: "end", from: "S:branch", to: "E:CHILD", points: [], double: false };
    const port = fanEndAnchors(nodes, [edge]).get(edge.id)!;
    expect(port.normal).toEqual({ x: -1, y: 0 });
    edge.points = semanticRoute(edge, nodes, [], port)!;
    expect(edge.points).toBeDefined();
    expect(edge.points.length - 2).toBeLessThanOrEqual(2);
    expect(assessQuality({ width: 1000, height: 800, nodes, edges: [edge], labels: [], notes: [], meta: { engine: "layered" } }).shapeCrossings).toBe(0);
  });

  it("measures diamond centering independently of specialization circles", async () => {
    const m = model(), { diagram } = await layout(m);
    const q = assessQuality(diagram, {}, m);
    const without = { ...diagram, nodes: diagram.nodes.filter((n) => !isSpecializationId(n.id)), edges: diagram.edges.filter((e) => !isSpecializationId(e.from)) };
    expect(q.diamondOffset).toBe(assessQuality(without).diamondOffset);
    const shifted = { ...without, nodes: without.nodes.map((n) => n.kind === "relationship" ? { ...n, box: { ...n.box, x: n.box.x + 100 } } : n) };
    expect(assessQuality(shifted).diamondOffset).toBeGreaterThan(q.diamondOffset);
  });

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
