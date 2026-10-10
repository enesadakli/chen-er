import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Box, DEdge, DLabel, DNode, Diagram, Point } from "../src/core/geometry.js";
import { layoutScore } from "../src/core/layout/compact.js";
import { layout } from "../src/core/layout/index.js";
import { boxSegmentDistance, labelGeometry, labelLooseReasons } from "../src/core/layout/label-geometry.js";
import { placeLabels } from "../src/core/layout/labels.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { interMetrics } from "../src/core/text/metrics.js";

const entity: DNode = { id: "E:HUB", kind: "entity", label: "Hub", box: { x: 400, y: 180, w: 110, h: 120 }, double: false };
const edge = (id = "edge:LINK#0", points: Point[] = [{ x: 100, y: 220 }, { x: 400, y: 220 }]): DEdge =>
  ({ id, kind: "end", from: "R:LINK", to: entity.id, end: id.slice(5), points, double: false });
const label = (box: Box, own = "edge:LINK#0", id = "label"): DLabel => ({ id, edge: own, text: "(0,N)", kind: "cardinality", box });
const diagram = (nodes: DNode[], edges: DEdge[], labels: DLabel[]): Diagram => ({ width: 1000, height: 1000, nodes, edges, labels, notes: [], meta: { engine: "test" } });
const reasons = (box: Box, edges = [edge()], nodes = [entity]) => labelLooseReasons(label(box), edges[0]!, labelGeometry(nodes, edges));
const model = normalize({ version: 1, entities: { HUB: {} }, relationships: { LINK: { ends: [{ entity: "HUB", card: "0..N" }, { entity: "HUB", card: "0..N" }] } } });

function repaired(edges: DEdge[], nodes = [entity]): DLabel[] {
  const labels = placeLabels(model, nodes, edges, interMetrics);
  expect(assessQuality(diagram(nodes, edges, labels))).toMatchObject({ labelLoose: 0, labelOnOwnEdge: 0, labelOnAnyEdge: 0, labelAmbiguity: 0, labelCollisions: 0 });
  return labels;
}

describe("entity-end label ownership", () => {
  it("keeps labels within 48px of the entity border", () => {
    expect(reasons({ x: 330, y: 224, w: 30, h: 18 })).toContain("outside first 48px of entity-end segment");
    expect(reasons({ x: 337, y: 224, w: 30, h: 18 })).toEqual([]);
    repaired([edge()]);
  });
  it("limits perpendicular separation to eight pixels", () => {
    expect(reasons({ x: 355, y: 229, w: 30, h: 18 })).toContain("more than 8px from entity-end segment");
    expect(reasons({ x: 350, y: 228, w: 30, h: 18 })).toEqual([]);
    repaired([edge()]);
  });
  it("rejects boxes across the segment and beyond its entity endpoint", () => {
    expect(reasons({ x: 355, y: 215, w: 30, h: 18 })).toContain("straddles entity-end segment");
    expect(reasons({ x: 410, y: 224, w: 30, h: 18 })).toContain("outside first 48px of entity-end segment");
    repaired([edge()]);
  });
  it("requires a foreign end to be at least twice as distant", () => {
    const edges = [edge(), edge("edge:OTHER#0", [{ x: 100, y: 250 }, { x: 400, y: 250 }])];
    expect(reasons({ x: 350, y: 226, w: 30, h: 18 }, edges)).toContain("another end edge is less than twice as far away");
    expect(reasons({ x: 350, y: 224, w: 30, h: 18 }, edges)).toEqual([]);
    repaired(edges);
  });
  it("also measures the entity shape, using box rather than text-center distance", () => {
    expect(reasons({ x: 365, y: 226, w: 30, h: 18 })).toContain("a shape is less than twice as far away");
    expect(reasons({ x: 358, y: 226, w: 30, h: 18 })).toEqual([]);
    repaired([edge()]);
  });
  it("uses actual diamond and ellipse outlines instead of their bounding boxes", () => {
    for (const kind of ["relationship", "attribute"] as const) {
      const foreign: DNode = { id: "foreign", kind, label: "", double: false, box: { x: 353, y: 242, w: 100, h: 100 } };
      expect(reasons({ x: 340, y: 224, w: 30, h: 18 }, [edge()], [entity, foreign])).toEqual([]);
    }
  });
  it("requires ten pixels between every pair of labels of the same entity", () => {
    const own = edge();
    const a = label({ x: 340, y: 224, w: 30, h: 18 });
    const b = { ...label({ x: 340, y: 251, w: 30, h: 18 }, own.id, "role"), kind: "role" as const };
    const context = labelGeometry([entity], [own]);
    expect(labelLooseReasons(a, own, context, [a, b])).toContain("another label of the entity is less than 10px away");
    b.box.y++;
    expect(labelLooseReasons(a, own, context, [a, b])).toEqual([]);
    const withRoles = normalize({ version: 1, entities: { HUB: {} }, relationships: { LINK: { ends: [{ entity: "HUB", card: "0..N", role: "parent" }, { entity: "HUB", card: "0..1", role: "child" }] } } });
    const labels = placeLabels(withRoles, [entity], [own], interMetrics);
    expect(labels).toHaveLength(2);
    expect(assessQuality(diagram([entity], [own], labels))).toMatchObject({ labelLoose: 0, labelOnOwnEdge: 0, labelCollisions: 0, labelAmbiguity: 0 });
  });
  it("only accepts the first segment from the entity, including its finite extent", () => {
    const bent = edge(undefined, [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 180 }]);
    expect(reasons({ x: 350, y: 104, w: 30, h: 18 }, [bent])).not.toEqual([]);
    repaired([bent]);
    expect(reasons({ x: 350, y: 224, w: 30, h: 18 }, [edge(undefined, [{ x: 390, y: 220 }, { x: 400, y: 220 }])])).toContain("outside first 48px of entity-end segment");
  });
  it("compares both drawn lines of double ends", () => {
    const own = { ...edge(), double: true };
    expect(reasons({ x: 350, y: 230, w: 30, h: 18 }, [own])).toEqual([]);
    expect(reasons({ x: 350, y: 231, w: 30, h: 18 }, [own])).toContain("more than 8px from entity-end segment");
    const other = { ...edge("edge:OTHER#0", [{ x: 100, y: 252 }, { x: 400, y: 252 }]), double: true };
    expect(reasons({ x: 350, y: 226, w: 30, h: 18 }, [edge(), other])).toContain("another end edge is less than twice as far away");
    repaired([own]);
  });
  it("separates labels of two ends attached 28px apart", () => {
    const edges = [edge(), edge("edge:LINK#1", [{ x: 100, y: 248 }, { x: 400, y: 248 }])];
    const close = [label({ x: 350, y: 224, w: 30, h: 18 }), label({ x: 350, y: 246, w: 30, h: 18 }, edges[1]!.id, "second")];
    expect(assessQuality(diagram([entity], edges, close)).labelLoose).toBe(2);
    expect(repaired(edges)).toHaveLength(2);
  });
  it.each([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]])("places labels on an outward segment with direction (%i,%i)", (dx, dy) => {
    const end = { x: dx > 0 ? 510 : dx < 0 ? 400 : 455, y: dy > 0 ? 300 : dy < 0 ? 180 : 240 };
    const own = edge(undefined, [{ x: end.x + dx * 150, y: end.y + dy * 150 }, end]);
    repaired([own]);
  });
  it("counts each violating label once and does not assess attribute labels", () => {
    const bad = label({ x: 280, y: 250, w: 30, h: 18 });
    expect(assessQuality(diagram([entity], [edge()], [bad])).labelLoose).toBe(1);
    expect(assessQuality(diagram([entity], [{ ...edge(), kind: "attribute" }], [bad])).labelLoose).toBe(0);
  });
  it("reports impossible slots rather than hiding a short entity-end segment", () => {
    const blocked = edge(undefined, [{ x: 399, y: 220 }, { x: 400, y: 220 }]);
    const labels = placeLabels(model, [entity], [blocked], interMetrics);
    expect(labels).toHaveLength(1);
    expect(assessQuality(diagram([entity], [blocked], labels)).labelLoose).toBe(1);
  });
  it("rejects a label on its own bend and places it away from the turn", () => {
    const bent = edge(undefined, [{ x: 100, y: 250 }, { x: 370, y: 250 }, { x: 370, y: 220 }, { x: 400, y: 220 }]);
    const bad = label({ x: 360, y: 224, w: 30, h: 18 });
    const q = assessQuality(diagram([entity], [bent], [bad]));
    expect(q).toMatchObject({ labelOnOwnEdge: 1, labelCollisions: 0, labelAmbiguity: 0 });
    expect(q.issues.filter((issue) => issue.kind === "label-on-own-edge")).toHaveLength(1);
    expect(labelLooseReasons(bad, bent, labelGeometry([entity], [bent]))).toEqual(["intersects own edge within 2px"]);
    expect(layoutScore(q)).toBe(Infinity);
    const labels = repaired([bent]);
    expect(labels[0]!.box.y + labels[0]!.box.h).toBeLessThan(220 - 2);
  });
  it("prefers the opposite side when a nearby route turns above the end segment", () => {
    const bent = edge(undefined, [{ x: 100, y: 190 }, { x: 370, y: 190 }, { x: 370, y: 220 }, { x: 400, y: 220 }]);
    const labels = repaired([bent]);
    expect(labels[0]!.box.y).toBeGreaterThan(220 + 2);
  });
  it.each(["cardinality", "role"] as const)("counts %s once across multiple own segments with inclusive 2px clearance", (kind) => {
    const bent = edge(undefined, [{ x: 100, y: 220 }, { x: 370, y: 220 }, { x: 370, y: 250 }, { x: 400, y: 250 }]);
    const bad = { ...label({ x: 355, y: 222, w: 30, h: 18 }), kind };
    expect(assessQuality(diagram([], [bent], [bad])).labelOnOwnEdge).toBe(1);
    const straight = edge();
    expect(assessQuality(diagram([], [straight], [{ ...bad, box: { x: 330, y: 222, w: 30, h: 18 } }])).labelOnOwnEdge).toBe(1);
    expect(assessQuality(diagram([], [straight], [{ ...bad, box: { x: 330, y: 222.01, w: 30, h: 18 } }])).labelOnOwnEdge).toBe(0);
    expect(assessQuality(diagram([], [{ ...bent, kind: "attribute" }], [bad])).labelOnOwnEdge).toBe(0);
  });
  it("checks both drawn lines of a double own edge", () => {
    const own = { ...edge(), double: true };
    const bad = label({ x: 330, y: 224, w: 30, h: 18 });
    expect(assessQuality(diagram([], [edge()], [bad])).labelOnOwnEdge).toBe(0);
    expect(assessQuality(diagram([], [own], [bad])).labelOnOwnEdge).toBe(1);
    repaired([own]);
  });
  it("changes a label slot when its preferred box is crossed by an attribute spoke", () => {
    const own = edge();
    const preferred = placeLabels(model, [entity], [own], interMetrics)[0]!;
    const x = preferred.box.x + preferred.box.w / 2;
    const spoke: DEdge = { id: "spoke", kind: "attribute", from: entity.id, to: "oval", double: false,
      points: [{ x, y: preferred.box.y - 20 }, { x, y: preferred.box.y + preferred.box.h + 20 }] };
    expect(assessQuality(diagram([entity], [own, spoke], [preferred])).labelOnAnyEdge).toBe(1);
    const placed = placeLabels(model, [entity], [own, spoke], interMetrics);
    expect(placed[0]!.box).not.toEqual(preferred.box);
    expect(assessQuality(diagram([entity], [own, spoke], placed)).labelOnAnyEdge).toBe(0);
  });

  it.each(["cardinality", "role"] as const)("counts %s crossed by any end, attribute or part line once", (kind) => {
    const own = edge();
    const bad = { ...label({ x: 330, y: 224, w: 30, h: 18 }), kind };
    const foreign = (kind: DEdge["kind"], id: string): DEdge => ({ ...edge(id, [{ x: 340, y: 210 }, { x: 340, y: 260 }]), kind });
    const q = assessQuality(diagram([], [own, foreign("end", "other"), foreign("attribute", "spoke"), foreign("part", "part")], [bad]));
    expect(q.labelOnOwnEdge).toBe(0);
    expect(q.labelOnAnyEdge).toBe(1);
    expect(q.issues.find((i) => i.kind === "label-on-any-edge")!.ids).toEqual([bad.id, "other", "spoke", "part"]);
    expect(layoutScore(q)).toBe(Infinity);
    const double = { ...foreign("end", "double"), double: true, points: [{ x: 364, y: 210 }, { x: 364, y: 260 }] };
    expect(assessQuality(diagram([], [own, double], [bad])).labelOnAnyEdge).toBe(1);
  });

  it("adds any-edge clearance coverage beyond label collisions and oval clearance", () => {
    const own = edge();
    const near = label({ x: 350, y: 224, w: 30, h: 18 });
    const oval: DNode = { id: "oval", kind: "attribute", label: "Title", double: false, box: { x: 500, y: 230, w: 60, h: 30 } };
    const spoke: DEdge = { id: "spoke", kind: "attribute", from: "owner", to: oval.id, double: false,
      points: [{ x: 200, y: 243.5 }, { x: 500, y: 243.5 }] };
    const q = assessQuality(diagram([oval], [own, spoke], [near]));
    expect(q).toMatchObject({ labelOnOwnEdge: 0, labelCollisions: 0, spokeLabelViolations: 0, labelLoose: 0, labelOnAnyEdge: 1 });
    expect(layoutScore(q)).toBe(Infinity);
  });

  it("measures finite diagonal, horizontal, vertical and degenerate segments", () => {
    const b = { x: 10, y: 10, w: 10, h: 10 };
    expect(boxSegmentDistance(b, { x: 0, y: 0 }, { x: 30, y: 30 })).toBe(0);
    expect(boxSegmentDistance(b, { x: 0, y: 5 }, { x: 30, y: 5 })).toBe(5);
    expect(boxSegmentDistance(b, { x: 5, y: 0 }, { x: 5, y: 30 })).toBe(5);
    expect(boxSegmentDistance(b, { x: 0, y: 0 }, { x: 5, y: 5 })).toBeCloseTo(Math.sqrt(50));
    expect(boxSegmentDistance(b, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(Math.sqrt(200));
  });
});

const fixtures = [...readdirSync("bench/fixtures").filter((file) => file.endsWith(".er.yaml")).map((file) => `bench/fixtures/${file}`), ...readdirSync("examples").filter((file) => file.endsWith(".er.yaml")).map((file) => `examples/${file}`)];
if (existsSync("examples/private/university-curriculum.er.yaml")) fixtures.push("examples/private/university-curriculum.er.yaml");

it.each(fixtures)("keeps hard label and geometry metrics at zero for %s", async (file) => {
  const parsed = parseModel(readFileSync(file, "utf8"));
  expect(parsed.model).toBeDefined();
  const pins = file === "bench/fixtures/pinned.er.yaml" ? JSON.parse(readFileSync(file.replace(".er.yaml", ".er.layout.json"), "utf8")).pins : {};
  const { diagram } = await layout(parsed.model!, { pins });
  const q = assessQuality(diagram, pins, parsed.model!);
  expect(q.issues.filter((issue) => issue.kind === "label-loose")).toEqual([]);
  expect(q).toMatchObject({ labelLoose: 0, labelOnOwnEdge: 0, labelOnAnyEdge: 0, labelAmbiguity: 0, labelCollisions: 0, overlaps: 0, shapeCrossings: 0, pinDrift: 0,
    attributeEdgeBends: 0, edgeOverlap: 0, tinySegments: 0, endPortCrowding: 0, diamondVertexViolations: 0, doubleEdgeArtifacts: 0 });
}, 30000);

const university = `version: 1
title: University
entities:
  DEPARTMENT: { attrs: [Name], keys: [[Name]] }
  COURSE: { attrs: [Code, Title], keys: [[Code]] }
  STUDENT: { attrs: [StudentId], keys: [[StudentId]] }
relationships:
  OFFERS:
    ends: [ { entity: DEPARTMENT, card: 1..N }, { entity: COURSE, card: 1..1 } ]
  ENROLLS:
    ends: [ { entity: STUDENT, card: 1..N }, { entity: COURSE, card: 0..N } ]
    attrs: [Grade, Semester]
`;

it("keeps University participation labels clear of attribute spokes", async () => {
  const model = parseModel(university).model!;
  const { diagram } = await layout(model);
  expect(assessQuality(diagram, {}, model)).toMatchObject({ labelOnAnyEdge: 0, labelOnOwnEdge: 0, labelCollisions: 0, labelLoose: 0 });
  const course = diagram.labels.find((l) => l.edge === "edge:OFFERS#1")!;
  const spoke = diagram.edges.find((e) => e.id === "edge:A:COURSE.Title")!;
  expect(spoke.points).toHaveLength(2);
  expect(boxSegmentDistance(course.box, spoke.points[0]!, spoke.points[1]!)).toBeGreaterThan(2);
});

it("keeps transit participation labels clear of all edges and spokes", async () => {
  const model = parseModel(readFileSync("bench/fixtures/large/transit-network.er.yaml", "utf8")).model!;
  const { diagram } = await layout(model);
  expect(assessQuality(diagram, {}, model).labelOnAnyEdge).toBe(0);
}, 30000);
