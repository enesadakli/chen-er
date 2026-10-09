import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxAround, center, type DEdge, type Diagram, type DNode } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { layoutScore } from "../src/core/layout/compact.js";
import { routeEdge } from "../src/core/layout/route.js";
import { endRouteMetrics, nearestBorderDistance, orthogonalPath } from "../src/core/layout/semantic-edges.js";
import { semanticRoute } from "../src/core/layout/semantic-route.js";
import { flattenAttrs, parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const privateModel = "examples/private/university-curriculum.er.yaml";
// A missing private model must show up as a named skip, never as a silent pass.
const privateTitle = (title: string) => existsSync(privateModel) ? `university: ${title}` : `university (private model absent): ${title}`;

const diamond: DNode = { id: "R", kind: "relationship", label: "R", box: boxAround({ x: 100, y: 100 }, 100, 40), double: false };
const entity: DNode = { id: "E", kind: "entity", label: "E", box: boxAround({ x: 200, y: 200 }, 100, 40), double: false };
const edge: DEdge = { id: "end", kind: "end", from: "R", to: "E", points: [], double: false };
const diagram = (ends: DEdge[]): Diagram => ({ nodes: [diamond, entity], edges: ends, labels: [], width: 400, height: 400, notes: [], meta: { engine: "test" } });

describe("end route metrics", () => {
  it("uses the actual sloping diamond border instead of its bounding box", () => {
    expect(nearestBorderDistance(diamond, entity)).toBe(80);
    const d = diagram([{ ...edge, points: [{ x: 150, y: 100 }, { x: 150, y: 180 }] }]);
    expect(endRouteMetrics(d)).toEqual([{ id: "end", routeDetour: 1, endBends: 0 }]);
  });
  it("counts direction changes while ignoring collinear points and zero length segments", () => {
    const d = diagram([{ ...edge, points: [{ x: 150, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 140 }, { x: 200, y: 180 }] }]);
    expect(endRouteMetrics(d)[0]).toEqual({ id: "end", routeDetour: 1.625, endBends: 1 });
    expect(assessQuality(d)).toMatchObject({ routeDetourMax: 1.625, routeDetourMean: 1.625, endBendsMax: 1, endBendsMean: 1 });
    expect(assessQuality(diagram([]))).toMatchObject({ routeDetourMax: 0, routeDetourMean: 0, endBendsMax: 0, endBendsMean: 0 });
  });
  it("keeps a blocked fallback orthogonal and rejects its candidate", () => {
    const target: DNode = { ...entity, box: boxAround({ x: 400, y: 200 }, 100, 40) };
    const wall: DNode = { ...entity, id: "wall", box: { x: 160, y: 40, w: 100, h: 120 } };
    const nodes = [diamond, target, wall];
    const points = routeEdge(edge, nodes, [], 0, [], { endPort: { anchor: { x: 350, y: 200 }, normal: { x: -1, y: 0 } } });
    expect(orthogonalPath(points)).toBe(true);
    const report = assessQuality({ ...diagram([]), nodes, edges: [{ ...edge, points }] });
    expect(report.diagonalEnds).toBe(0);
    expect(report.shapeCrossings).toBeGreaterThan(0);
    expect(layoutScore(report)).toBe(Infinity);
  });
  it("finds a two-bend corridor next to a blocking shape", () => {
    const target: DNode = { ...entity, box: boxAround({ x: 400, y: 200 }, 100, 40) };
    const obstacle: DNode = { ...entity, id: "obstacle", box: boxAround({ x: 250, y: 100 }, 60, 60) };
    const nodes = [diamond, target, obstacle];
    const points = semanticRoute(edge, nodes, [], { anchor: { x: 350, y: 200 }, normal: { x: -1, y: 0 } });
    expect(points).toBeDefined();
    const q = assessQuality({ ...diagram([]), nodes, edges: [{ ...edge, points: points! }] });
    expect(q.shapeCrossings).toBe(0);
    expect(q.tinySegments).toBe(0);
    expect(q.endBendsMax).toBeLessThanOrEqual(2);
  });
});

it.skipIf(!existsSync(privateModel))(privateTitle("keeps routes short with at most two bends and two crossings"), async () => {
  const model = parseModel(readFileSync("examples/private/university-curriculum.er.yaml", "utf8")).model!;
  const { diagram: d } = await layout(model);
  const q = assessQuality(d, {}, model);
  expect(q.diagonalEnds).toBe(0);
  expect(q.zRoutes).toBeLessThanOrEqual(6);
  expect(q.routeDetourMax).toBeLessThanOrEqual(1.6);
  expect(q.routeDetourMean).toBeLessThanOrEqual(1.2);
  expect(endRouteMetrics(d).filter((r) => r.endBends > 2)).toEqual([]);
  expect(q.edgeCrossings).toBeLessThanOrEqual(2);
  expect(q.diamondOffset).toBeLessThanOrEqual(0.15);
  for (const e of d.edges.filter((e) => e.kind === "end" && (e.from === "R:INCLUDES" || e.from === "R:LISTS"))) {
    expect(e.points, e.id).toHaveLength(2);
    expect(orthogonalPath(e.points), e.id).toBe(true);
  }
}, 10000);

it("keeps the COMPANY block readable with symmetric recursive ends and complete short attribute fans", async () => {
  const model = parseModel(readFileSync("bench/fixtures/hub-company.er.yaml", "utf8")).model!;
  const { diagram: d } = await layout(model);
  const q = assessQuality(d, {}, model);
  for (const metric of ["overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const) expect(q[metric], metric).toBe(0);
  expect(q.diagonalEnds).toBe(0);
  expect(q.zRoutes).toBeLessThanOrEqual(5);
  expect(q.edgeCrossings).toBe(0);
  expect(q.endBendsMax).toBeLessThanOrEqual(2);
  expect(q.routeDetourMax).toBeLessThanOrEqual(1.347241);
  expect(q.attributeSpokeMax).toBeLessThanOrEqual(2.5);
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const employee = byId.get("E:EMPLOYEE")!, department = byId.get("E:DEPARTMENT")!;
  const project = byId.get("E:PROJECT")!, dependent = byId.get("E:DEPENDENT")!;
  expect(center(employee.box).y).toBe(center(department.box).y);
  expect(center(project.box).y).toBe(center(dependent.box).y);
  expect(center(employee.box).y).toBeLessThan(center(dependent.box).y);
  for (const owner of [...model.entities, ...model.relationships]) for (const attr of flattenAttrs(owner.attrs)) expect(byId.has(attr.id), attr.id).toBe(true);
  const diamond = byId.get("R:SUPERVISES")!, c = center(diamond.box);
  const recursive = d.edges.filter((e) => e.from === diamond.id && e.kind === "end").sort((a, b) => a.points[0]!.x - b.points[0]!.x);
  expect(recursive).toHaveLength(2);
  for (const e of recursive) {
    expect(orthogonalPath(e.points)).toBe(true);
    expect(e.points).toHaveLength(2);
    const first = e.points[0]!, last = e.points.at(-1)!;
    expect(first.y).toBeGreaterThan(c.y);
    expect(Math.abs(first.x - c.x) / (diamond.box.w / 2) + Math.abs(first.y - c.y) / (diamond.box.h / 2)).toBeCloseTo(1);
    expect(last.y).toBe(employee.box.y);
  }
  for (let i = 0; i < recursive[0]!.points.length; i++) {
    const left = recursive[0]!.points[i]!, right = recursive[1]!.points[i]!;
    expect(left.x + right.x).toBeCloseTo(c.x * 2);
    expect(left.y).toBeCloseTo(right.y);
  }
});
