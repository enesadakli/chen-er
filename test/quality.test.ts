import { describe, expect, it } from "vitest";
import type { DEdge, DLabel, DNode, Diagram, Point } from "../src/core/geometry.js";
import { assessQuality } from "../src/core/quality.js";

const node = (id: string, x: number, y: number, kind: DNode["kind"] = "entity", w = 40, h = 40): DNode => ({ id, kind, label: id, box: { x, y, w, h }, double: false });
const edge = (id: string, points: Point[], from = "a", to = "b"): DEdge => ({ id, kind: "end", from, to, points, double: false });
const label = (id: string, x: number, y: number, own = "e"): DLabel => ({ id, kind: "cardinality", text: "(0,N)", box: { x, y, w: 30, h: 18 }, edge: own });
const diagram = (nodes: DNode[] = [], edges: DEdge[] = [], labels: DLabel[] = []): Diagram => ({ width: 600, height: 600, nodes, edges, labels, notes: [], meta: { engine: "test" } });

describe("exact diagram quality", () => {
  it("implements the contract and accepts empty diagrams", () => {
    expect(assessQuality(diagram())).toEqual({ routeDetourMax: 0, routeDetourMean: 0, endBendsMax: 0, endBendsMean: 0, attributeEdgeBends: 0, edgeOverlap: 0, tinySegments: 0, endPortCrowding: 0, diamondVertexViolations: 0, doubleEdgeArtifacts: 0, hierarchyViolations: 0, diamondOffset: 0, relatedDistance: 0, proximityInversions: 0, axisAligned: 1, centralityOffset: 0, gridMisalignment: 0, attributeInwardRatio: 0, implemented: true, overlaps: 0, shapeCrossings: 0, labelCollisions: 0, labelAmbiguity: 0, labelLoose: 0, edgeCrossings: 0, pinDrift: 0, aspect: 1, edgeLength: 0, meanEdgeLength: 0, meanEdgeRatio: 0, longestEdgeRatio: 0, density: 0, issues: [] });
  });
  it("measures end polylines once and normalizes by the median entity width", () => {
    const ns = [node("a", 0, 0, "entity", 40, 20), node("b", 100, 100, "entity", 60, 20), node("r", 200, 200, "relationship", 200, 30)];
    const es = [edge("e1", [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 30, y: 90 }]), { ...edge("e2", [{ x: 0, y: 0 }, { x: 60, y: 80 }]), double: true }, { ...edge("attr", [{ x: 0, y: 0 }, { x: 500, y: 0 }]), kind: "attribute" as const }];
    const q = assessQuality({ ...diagram(ns, es), width: 600, height: 300 });
    expect(q.aspect).toBe(2);
    expect(q.edgeLength).toBe(200);
    expect(q.meanEdgeLength).toBe(100);
    expect(q.meanEdgeRatio).toBe(2);
    expect(q.longestEdgeRatio).toBe(2);
    expect(q.density).toBeCloseTo(8000 / 180000);
  });
  it("uses the middle width for an odd entity count and handles missing entities", () => {
    const es = [edge("e", [{ x: 0, y: 0 }, { x: 300, y: 0 }])];
    const ns = [node("a", 0, 0, "entity", 200), node("b", 0, 100, "entity", 50), node("c", 0, 200, "entity", 100)];
    expect(assessQuality(diagram(ns, es)).meanEdgeRatio).toBe(3);
    expect(assessQuality(diagram([], es)).meanEdgeRatio).toBe(0);
    expect(assessQuality({ ...diagram(), width: 0, height: 0 })).toMatchObject({ aspect: 0, density: 0 });
  });
  it.each(["entity", "relationship", "attribute"] as const)("finds overlapping %s shapes", (kind) => {
    const q = assessQuality(diagram([node("a", 20, 20, kind), node("b", 30, 30, kind)]));
    expect(q.overlaps).toBe(1);
    expect(q.issues[0]!.ids).toEqual(["a", "b"]);
  });
  it("measures four-pixel clearance using Euclidean shape distance", () => {
    expect(assessQuality(diagram([node("a", 20, 20), node("b", 63, 20)])).overlaps).toBe(1);
    expect(assessQuality(diagram([node("a", 20, 20), node("b", 64, 20)])).overlaps).toBe(0);
    expect(assessQuality(diagram([node("a", 20, 20), node("b", 63, 63)])).overlaps).toBe(0);
  });
  it.each(["relationship", "attribute"] as const)("does not mistake %s bounding-box corners for shape intersections", (kind) => {
    const q = assessQuality(diagram([node("round", 50, 50, kind, 100, 100), node("corner", 50, 50, "entity", 8, 8)]));
    expect(q.overlaps).toBe(0);
  });
  it.each(["entity", "relationship", "attribute"] as const)("detects a polyline through a foreign %s once", (kind) => {
    const q = assessQuality(diagram([node("foreign", 50, 50, kind)], [edge("e", [{ x: 20, y: 70 }, { x: 70, y: 70 }, { x: 120, y: 70 }])]));
    expect(q.shapeCrossings).toBe(1);
    expect(q.issues.find((i) => i.kind === "shape-crossing")!.ids).toEqual(["e", "foreign"]);
  });
  it("excludes endpoints and tangent segments from shape crossings", () => {
    const ns = [node("a", 50, 50), node("foreign", 150, 50, "attribute")];
    expect(assessQuality(diagram(ns, [edge("e", [{ x: 20, y: 50 }, { x: 230, y: 50 }])])).shapeCrossings).toBe(0);
  });
  it("uses ellipse and diamond boundaries when checking segments", () => {
    for (const kind of ["relationship", "attribute"] as const) {
      expect(assessQuality(diagram([node("foreign", 50, 50, kind, 100, 100)], [edge("e", [{ x: 45, y: 55 }, { x: 60, y: 55 }])])).shapeCrossings).toBe(0);
    }
  });
  it("detects label/node collisions", () => {
    expect(assessQuality(diagram([node("a", 40, 40)], [], [label("l", 50, 50)])).labelCollisions).toBe(1);
    expect(assessQuality(diagram([node("a", 40, 40)], [], [label("l", 100, 50)])).labelCollisions).toBe(0);
  });
  it("checks label shape geometry rather than node boxes", () => {
    expect(assessQuality(diagram([node("d", 50, 50, "relationship", 200, 200)], [], [label("l", 50, 50)])).labelCollisions).toBe(0);
    expect(assessQuality(diagram([node("d", 50, 50, "relationship", 200, 200)], [], [label("l", 135, 140)])).labelCollisions).toBe(1);
  });
  it("allows labels to touch without positive-area overlap", () => {
    expect(assessQuality(diagram([node("n", 20, 20)], [], [label("l", 60, 20)])).labelCollisions).toBe(0);
    expect(assessQuality(diagram([], [], [label("l1", 20, 20), label("l2", 50, 20)])).labelCollisions).toBe(0);
  });
  it("measures both rendered lines of double edges", () => {
    const e = edge("double", [{ x: 20, y: 50 }, { x: 120, y: 50 }]);
    const d = diagram([node("n", 50, 51, "entity", 20, 20)], [e]);
    expect(assessQuality(d).shapeCrossings).toBe(0);
    e.double = true;
    expect(assessQuality(d).shapeCrossings).toBe(1);
    const canvas = diagram([], [{ ...e, points: [{ x: 20, y: 1 }, { x: 120, y: 1 }] }]);
    expect(assessQuality(canvas).issues.some((i) => i.kind === "out-of-canvas")).toBe(true);
  });
  it("counts each label pair once", () => {
    expect(assessQuality(diagram([], [], [label("l1", 50, 50), label("l2", 60, 60)])).labelCollisions).toBe(1);
    expect(assessQuality(diagram([], [], [label("l1", 50, 50), label("l2", 100, 50)])).labelCollisions).toBe(0);
  });
  it("checks foreign edges while allowing the label's own edge", () => {
    const e = edge("e", [{ x: 20, y: 60 }, { x: 120, y: 60 }]);
    expect(assessQuality(diagram([], [e], [label("l", 50, 50, "e")])).labelCollisions).toBe(0);
    expect(assessQuality(diagram([], [e], [label("l", 50, 50, "other")])).labelCollisions).toBe(1);
  });
  it("counts each intersecting edge pair once", () => {
    const a = edge("e1", [{ x: 20, y: 100 }, { x: 180, y: 100 }]);
    const b = edge("e2", [{ x: 50, y: 20 }, { x: 50, y: 180 }, { x: 150, y: 180 }, { x: 150, y: 20 }], "c", "d");
    expect(assessQuality(diagram([], [a, b])).edgeCrossings).toBe(1);
    b.points = [{ x: 20, y: 200 }, { x: 180, y: 200 }];
    expect(assessQuality(diagram([], [a, b])).edgeCrossings).toBe(0);
  });
  it("ignores shared touching endpoints but detects collinear overlap", () => {
    const a = edge("e1", [{ x: 20, y: 100 }, { x: 100, y: 100 }]);
    const b = edge("e2", [{ x: 100, y: 100 }, { x: 100, y: 180 }], "b", "c");
    expect(assessQuality(diagram([], [a, b])).edgeCrossings).toBe(0);
    b.points = [{ x: 80, y: 100 }, { x: 140, y: 100 }];
    expect(assessQuality(diagram([], [a, b])).edgeCrossings).toBe(1);
  });
  it("counts crossings away from a shared node", () => {
    const a = edge("e1", [{ x: 40, y: 40 }, { x: 180, y: 140 }]);
    const b = edge("e2", [{ x: 40, y: 40 }, { x: 50, y: 150 }, { x: 150, y: 50 }], "a", "c");
    expect(assessQuality(diagram([node("a", 20, 20)], [a, b])).edgeCrossings).toBe(1);
  });
  it("measures pin drift with a half-pixel tolerance", () => {
    const d = diagram([node("p", 20, 20)]);
    expect(assessQuality(d, { p: { x: 40.5, y: 40 } }).pinDrift).toBe(0);
    expect(assessQuality(d, { p: { x: 40.51, y: 40 } }).pinDrift).toBe(1);
    expect(assessQuality(d).pinDrift).toBe(0);
  });
  it("reports nodes, labels and edge bends outside the canvas", () => {
    const d = diagram([node("n", -1, 20)], [edge("e", [{ x: 20, y: 20 }, { x: 700, y: 100 }, { x: 40, y: 40 }])], [label("l", 590, 20)]);
    expect(assessQuality(d).issues.filter((i) => i.kind === "out-of-canvas").map((i) => i.ids)).toEqual([["n"], ["l"], ["e"]]);
    expect(assessQuality(diagram([node("n", 0, 0)], [edge("e", [{ x: 0, y: 0 }, { x: 600, y: 600 }])], [label("l", 570, 582)])).issues.filter((i) => i.kind === "out-of-canvas")).toEqual([]);
  });
});

describe("end label ambiguity", () => {
  const own = edge("e", [{ x: 100, y: 100 }, { x: 300, y: 100 }]);
  it.each(["cardinality", "role"] as const)("detects a %s more than 14px from its entity-end segment", (kind) => {
    const q = assessQuality(diagram([], [own], [{ ...label("l", 250, 115), kind }]));
    expect(q.labelAmbiguity).toBe(1);
    expect(q.issues.find((i) => i.kind === "label-ambiguity")?.message).toContain("14px");
  });
  it("detects a closer foreign end without a collision", () => {
    const other = edge("other", [{ x: 100, y: 135 }, { x: 300, y: 135 }]);
    const q = assessQuality(diagram([], [own, other], [label("l", 250, 110)]));
    expect(q.labelCollisions).toBe(0);
    expect(q.labelAmbiguity).toBe(1);
    expect(q.issues.find((i) => i.kind === "label-ambiguity")?.message).toContain("closer");
  });
  it("detects labels beyond 60px along the end", () => {
    const q = assessQuality(diagram([], [own], [label("l", 200, 106)]));
    expect(q.labelAmbiguity).toBe(1);
    expect(q.issues.find((i) => i.kind === "label-ambiguity")?.message).toContain("60px");
  });
  it("accepts exact distance limits and ignores foreign attribute edges", () => {
    const other = { ...edge("attr", [{ x: 100, y: 134 }, { x: 300, y: 134 }]), kind: "attribute" as const };
    expect(assessQuality(diagram([], [own, other], [label("l", 225, 114)])).labelAmbiguity).toBe(0);
  });
  it("uses only the entity-end segment, even beside an earlier bend", () => {
    const bent = { ...own, points: [{ x: 100, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 100 }] };
    expect(assessQuality(diagram([], [bent], [label("l", 200, 26)])).labelAmbiguity).toBe(1);
  });
  it("counts a label once when multiple ambiguity conditions fail", () => {
    expect(assessQuality(diagram([], [own], [label("l", 100, 150)])).labelAmbiguity).toBe(1);
  });
  it("compares the rendered lines of double ends", () => {
    const other = edge("other", [{ x: 100, y: 131 }, { x: 300, y: 131 }]);
    expect(assessQuality(diagram([], [own, { ...other, double: true }], [label("l", 250, 106)])).labelAmbiguity).toBe(1);
    const closer = edge("other", [{ x: 100, y: 129 }, { x: 300, y: 129 }]);
    expect(assessQuality(diagram([], [{ ...own, double: true }, closer], [label("l", 250, 106)])).labelAmbiguity).toBe(0);
  });
});
