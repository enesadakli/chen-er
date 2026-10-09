import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxAround, type DEdge, type Diagram, type DNode } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { endRouteMetrics, nearestBorderDistance } from "../src/core/layout/semantic-edges.js";
import { semanticRoute } from "../src/core/layout/semantic-route.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

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

it.skipIf(!existsSync("examples/private/university-curriculum.er.yaml"))("keeps university routes short with at most two bends and two crossings", async () => {
  const model = parseModel(readFileSync("examples/private/university-curriculum.er.yaml", "utf8")).model!;
  const { diagram: d } = await layout(model);
  const q = assessQuality(d, {}, model);
  expect(q.routeDetourMax).toBeLessThanOrEqual(1.6);
  expect(q.routeDetourMean).toBeLessThanOrEqual(1.2);
  expect(endRouteMetrics(d).filter((r) => r.endBends > 2)).toEqual([]);
  expect(q.edgeCrossings).toBeLessThanOrEqual(2);
  expect(q.diamondOffset).toBeLessThanOrEqual(0.15);
}, 10000);
