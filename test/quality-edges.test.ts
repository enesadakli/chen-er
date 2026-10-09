import { describe, expect, it } from "vitest";
import { boxAround, type DEdge, type Diagram, type DNode, type Point } from "../src/core/geometry.js";
import { layoutScore } from "../src/core/layout/compact.js";
import { dominantVertex, visibleEdgePaths } from "../src/core/layout/semantic-edges.js";
import { semanticRoute } from "../src/core/layout/semantic-route.js";
import { assessQuality } from "../src/core/quality.js";
import { renderSvg } from "../src/core/render/svg.js";

const edge = (id: string, points: Point[], kind: DEdge["kind"] = "end", double = false): DEdge => ({ id, kind, from: "R", to: "E", points, double });
const node = (id: string, x: number, y: number, kind: DNode["kind"], w = 100, h = 40): DNode => ({ id, label: id, kind, box: boxAround({ x, y }, w, h), double: false });
const diagram = (edges: DEdge[], nodes: DNode[] = []): Diagram => ({ edges, nodes, labels: [], width: 1000, height: 1000, notes: [], meta: { engine: "test" } });
const q = (edges: DEdge[], nodes: DNode[] = []) => assessQuality(diagram(edges, nodes));

describe("visible edge quality", () => {
  it("counts diagonal ends once while leaving diagonal attribute spokes valid", () => {
    const points = [{ x: 100, y: 100 }, { x: 180, y: 180 }, { x: 250, y: 220 }];
    expect(q([edge("a", points), edge("b", points, "attribute")]).diagonalEnds).toBe(1);
    expect(q([edge("a", [{ x: 100, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 200 }])]).diagonalEnds).toBe(0);
  });
  it("counts two-bend Z routes with redundant points and zero segments", () => {
    const z = [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 200 }];
    expect(q([edge("z", z), edge("double", z, "end", true), edge("attr", z, "attribute")]).zRoutes).toBe(2);
    expect(q([edge("l", z.slice(0, -1))]).zRoutes).toBe(0);
    expect(q([edge("diagonal", [{ x: 100, y: 100 }, { x: 150, y: 150 }, { x: 150, y: 200 }, { x: 250, y: 300 }])]).zRoutes).toBe(0);
    const report = q([]);
    expect(layoutScore({ ...report, zRoutes: 1 })).toBeCloseTo(layoutScore(report) + 0.75);
  });
  it.each(["attribute", "part"] as const)("rejects bent %s spokes including triangular detours", (kind) => {
    expect(q([edge("a", [{ x: 100, y: 100 }, { x: 200, y: 200 }], kind)]).attributeEdgeBends).toBe(0);
    expect(q([edge("a", [{ x: 100, y: 100 }, { x: 160, y: 180 }, { x: 80, y: 180 }, { x: 200, y: 200 }], kind)]).attributeEdgeBends).toBe(1);
    expect(q([edge("a", [{ x: 100, y: 100 }, { x: 150, y: 150 }, { x: 200, y: 200 }], kind)]).attributeEdgeBends).toBe(1);
  });
  it("counts each collinearly overlapping edge pair once and permits endpoint touching", () => {
    const a = edge("a", [{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    const b = edge("b", [{ x: 200, y: 100 }, { x: 250, y: 100 }, { x: 400, y: 100 }], "attribute");
    expect(q([a, b]).edgeOverlap).toBe(1);
    b.points = [{ x: 300, y: 100 }, { x: 400, y: 100 }];
    expect(q([a, b]).edgeOverlap).toBe(0);
    b.points = [{ x: 200, y: 50 }, { x: 200, y: 150 }];
    expect(q([a, b]).edgeOverlap).toBe(0);
  });
  it("detects a single route retracing its own segment", () => {
    const e = edge("loop", [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 250 }]);
    expect(q([e]).edgeOverlap).toBe(1);
  });
  it("detects diagonal overlap and the visible copy of a double edge", () => {
    const a = edge("a", [{ x: 100, y: 100 }, { x: 300, y: 300 }]);
    expect(q([a, edge("b", [{ x: 200, y: 200 }, { x: 400, y: 400 }])]).edgeOverlap).toBe(1);
    const double = edge("d", [{ x: 100, y: 100 }, { x: 300, y: 100 }], "end", true);
    expect(q([double, edge("b", [{ x: 200, y: 102 }, { x: 400, y: 102 }], "attribute")]).edgeOverlap).toBe(1);
  });
  it("detects a tiny jog and accepts the exact 16px boundary", () => {
    const a = edge("a", [{ x: 100, y: 100 }, { x: 164, y: 100 }, { x: 164, y: 115 }, { x: 250, y: 115 }]);
    expect(q([a]).tinySegments).toBe(1);
    a.points[2]!.y = a.points[3]!.y = 116;
    expect(q([a]).tinySegments).toBe(0);
    expect(q([edge("d", [{ x: 100, y: 100 }, { x: 120, y: 100 }, { x: 120, y: 114 }, { x: 250, y: 114 }], "end", true)]).tinySegments).toBe(1);
  });
  it("counts a short axis-aligned attribute segment too", () => {
    expect(q([edge("a", [{ x: 100, y: 100 }, { x: 100, y: 115 }], "attribute")]).tinySegments).toBe(1);
  });
  it("detects short diagonal segments and shallow intermediate steps", () => {
    expect(q([edge("short", [{ x: 100, y: 100 }, { x: 109, y: 109 }])]).tinySegments).toBe(1);
    const step = edge("step", [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 164, y: 140 }, { x: 220, y: 140 }]);
    expect(q([step]).tinySegments).toBe(1);
    step.points[2]!.x = 166;
    expect(q([step]).tinySegments).toBe(0);
  });
  it("measures actual occupied shape area and plain segments without counting double ends twice", () => {
    const ns = [node("rect", 100, 100, "entity"), node("diamond", 300, 100, "relationship"), node("oval", 500, 100, "attribute")];
    const report = q([
      edge("a", [{ x: 100, y: 300 }, { x: 200, y: 300 }]),
      edge("b", [{ x: 100, y: 400 }, { x: 300, y: 400 }], "end", true),
      edge("c", [{ x: 100, y: 500 }, { x: 500, y: 500 }]),
    ], ns);
    expect(report.emptyAreaRatio).toBeCloseTo(1 - (4000 + 2000 + Math.PI * 1000) / 1000000);
    expect(report.plainSegmentRatio).toBe(2);
  });
  it("measures 16px end separation on a shared entity side", () => {
    const entity = node("E", 300, 300, "entity", 100, 100);
    const a = edge("a", [{ x: 100, y: 280 }, { x: 250, y: 280 }]);
    const b = edge("b", [{ x: 100, y: 295 }, { x: 250, y: 295 }]);
    expect(q([a, b], [entity]).endPortCrowding).toBe(1);
    b.points[1]!.y = 296;
    expect(q([a, b], [entity]).endPortCrowding).toBe(0);
    b.points[1] = { x: 280, y: 250 };
    expect(q([a, b], [entity]).endPortCrowding).toBe(0);
  });
  it("treats a corner as belonging to both adjoining entity sides", () => {
    const entity = node("E", 300, 300, "entity", 100, 100);
    const a = edge("a", [{ x: 250, y: 100 }, { x: 250, y: 250 }]);
    const b = edge("b", [{ x: 260, y: 100 }, { x: 260, y: 250 }]);
    expect(q([a, b], [entity]).endPortCrowding).toBe(1);
  });
  it.each([{ x: 300, y: 500 }, { x: 300, y: 100 }, { x: 100, y: 300 }, { x: 500, y: 300 }])("requires the matching dominant diamond vertex toward %j", (target) => {
    const diamond = node("R", 300, 300, "relationship"), entity = node("E", target.x, target.y, "entity");
    const vertex = dominantVertex(diamond, entity)!;
    const good = edge("a", [vertex.point, { x: vertex.point.x + vertex.normal.x * 100, y: vertex.point.y + vertex.normal.y * 100 }]);
    const other = { ...edge("other", []), to: "other-entity" };
    expect(q([good, other], [diamond, entity]).diamondVertexViolations).toBe(0);
    const bad = edge("b", [vertex.point, { x: vertex.point.x - vertex.normal.x * 24, y: vertex.point.y - vertex.normal.y * 24 }]);
    expect(q([bad, other], [diamond, entity]).diamondVertexViolations).toBe(1);
  });
  it("detects the left-vertex reversal stub on a double downward end", () => {
    const nodes = [node("R", 300, 300, "relationship"), node("E", 300, 550, "entity")];
    const bad = edge("bad", [{ x: 250, y: 300 }, { x: 226, y: 300 }, { x: 246, y: 300 }, { x: 246, y: 530 }], "end", true);
    const other = { ...edge("other", []), to: "other-entity" };
    const report = q([bad, other], nodes);
    expect(report.doubleEdgeArtifacts).toBe(1);
    expect(report.diamondVertexViolations).toBe(1);
    expect(report.tinySegments).toBe(0);
  });
  it("matches rendered miter joins and keeps clean double copies disjoint", () => {
    const e = edge("double", [{ x: 100, y: 100 }, { x: 100, y: 200 }, { x: 200, y: 200 }], "end", true);
    const paths = visibleEdgePaths(e);
    expect(paths).toEqual([[{ x: 102, y: 100 }, { x: 102, y: 198 }, { x: 200, y: 198 }], [{ x: 98, y: 100 }, { x: 98, y: 202 }, { x: 200, y: 202 }]]);
    const svg = renderSvg(diagram([e]));
    for (const ps of paths) expect(svg).toContain(ps.map((p) => `${p.x},${p.y}`).join(" "));
    expect(q([e]).doubleEdgeArtifacts).toBe(0);
  });
  it("routes a downward double end from the bottom vertex without short or reversing segments", () => {
    const nodes = [node("R", 300, 300, "relationship"), node("E", 300, 550, "entity")];
    const e = edge("double", [], "end", true), other = { ...edge("other", []), to: "other-entity" };
    const points = semanticRoute(e, nodes, [], { anchor: { x: 270, y: 530 }, normal: { x: 0, y: -1 } })!;
    expect(points[0]).toEqual({ x: 300, y: 320 });
    const report = q([{ ...e, points }, other], nodes);
    expect(report).toMatchObject({ tinySegments: 0, diamondVertexViolations: 0, doubleEdgeArtifacts: 0, edgeOverlap: 0 });
  });
  it.each(["diagonalEnds", "labelLoose", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const)("hard-rejects %s in candidate selection", (metric) => {
    const report = q([]);
    expect(layoutScore({ ...report, [metric]: 1 })).toBe(Infinity);
  });
});
