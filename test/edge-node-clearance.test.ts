import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DEdge, Diagram, DNode, Point } from "../src/core/geometry.js";
import { regressionBaseline, type RegressionMetric } from "../bench/run.js";
import { layout } from "../src/core/layout/index.js";
import { layoutConflictDiagnostics } from "../src/core/layout/pipeline.js";
import { repairEdgeNodeClearance } from "../src/core/layout/route.js";
import { endRouteMetrics } from "../src/core/layout/semantic-edges.js";
import { MIN_EDGE_NODE_CLEARANCE } from "../src/core/layout/semantic-clearance.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { interMetrics } from "../src/core/text/metrics.js";

const node = (id: string, kind: DNode["kind"] = "entity"): DNode => ({ id, kind, label: id, box: { x: 100, y: 100, w: 80, h: 40 }, double: false });
const edge = (points: Point[], id = "edge:test"): DEdge => ({ id, kind: "end", from: "source", to: "target", points, double: false });
const diagram = (nodes: DNode[], edges: DEdge[]): Diagram => ({ width: 400, height: 400, nodes, edges, labels: [], notes: [], meta: { engine: "test" } });

describe("foreign node edge clearance", () => {
  it("reports a parallel skim once per edge/node pair and emits a layout warning", () => {
    const d = diagram([node("foreign")], [edge([{ x: 60, y: 146 }, { x: 220, y: 146 }])]);
    const q = assessQuality(d);
    expect(assessQuality(diagram([node("foreign")], [edge([{ x: 110, y: 146 }, { x: 126, y: 146 }])])).edgeNodeClearanceViolations).toBe(1);
    expect(q).toMatchObject({ shapeCrossings: 0, edgeNodeClearanceViolations: 1, edgeNodeClearance: 6 });
    expect(layoutConflictDiagnostics(q, {})).toEqual([expect.objectContaining({ rule: "layout-conflict", severity: "warning", message: "edge-node-clearance: edge:test, foreign" })]);
  });

  it("accepts the band boundary and measures the nearer visible double line", () => {
    const e = edge([{ x: 60, y: 156 }, { x: 220, y: 156 }]);
    expect(assessQuality(diagram([node("foreign")], [{ ...e, double: true }]))).toMatchObject({ edgeNodeClearanceViolations: 0, edgeNodeClearance: MIN_EDGE_NODE_CLEARANCE });
    const near = edge([{ x: 60, y: 148 }, { x: 220, y: 148 }]);
    expect(assessQuality(diagram([node("foreign")], [{ ...near, double: true }]))).toMatchObject({ edgeNodeClearanceViolations: 1, edgeNodeClearance: 6 });
  });

  it("reports a crossing beside a diamond even when neither segment parallels its outline", () => {
    const diamond = { ...node("foreign", "relationship"), box: { x: 100, y: 100, w: 80, h: 80 } };
    const passing = edge([{ x: 60, y: 186 }, { x: 220, y: 186 }]);
    const attached = { ...edge([{ x: 140, y: 180 }, { x: 140, y: 260 }], "edge:attached"), from: diamond.id };
    expect(assessQuality(diagram([diamond], [passing, attached]))).toMatchObject({ shapeCrossings: 0, edgeCrossings: 1, edgeNodeClearanceViolations: 1, edgeNodeClearance: 6 });
  });

  it("exempts own endpoints, attribute spokes, isolated corners and distant crossings", () => {
    const n = node("foreign");
    const skim = edge([{ x: 60, y: 146 }, { x: 220, y: 146 }]);
    expect(assessQuality(diagram([n], [{ ...skim, to: n.id }])).edgeNodeClearanceViolations).toBe(0);
    expect(assessQuality(diagram([n], [{ ...skim, kind: "attribute", from: n.id }])).edgeNodeClearanceViolations).toBe(0);
    expect(assessQuality(diagram([n], [edge([{ x: 60, y: 146 }, { x: 95, y: 146 }])])).edgeNodeClearanceViolations).toBe(0);
    const distant = [edge([{ x: 220, y: 220 }, { x: 320, y: 220 }]), edge([{ x: 270, y: 180 }, { x: 270, y: 300 }], "edge:other")];
    expect(assessQuality(diagram([n], distant))).toMatchObject({ edgeCrossings: 1, edgeNodeClearanceViolations: 0 });
  });

  it("keeps existing shape-crossing checks", () => {
    expect(assessQuality(diagram([node("foreign")], [edge([{ x: 60, y: 120 }, { x: 220, y: 120 }])]))).toMatchObject({ shapeCrossings: 1, edgeNodeClearanceViolations: 1 });
  });

  it("clears the parcel skim within the approved four-bend budget", async () => {
    const model = parseModel(readFileSync("bench/fixtures/mid/parcel-distribution.er.yaml", "utf8")).model!;
    const result = await layout(model);
    expect(assessQuality(result.diagram)).toMatchObject({ edgeNodeClearanceViolations: 0, endBendsMax: 4, tinySegments: 0 });
    expect(result.diagnostics).toEqual([]);
  });

  it("adds at most two bends to the repaired edge without worsening other metrics", async () => {
    const model = parseModel(readFileSync("bench/fixtures/mid/parcel-distribution.er.yaml", "utf8")).model!;
    const { diagram: d } = await layout(model);
    const positions = d.nodes.map((n) => ({ ...n.box }));
    const passing = d.edges.find((e) => e.id === "edge:PLACED_IN#0")!;
    const start = passing.points[0]!, arrival = passing.points.at(-2)!, end = passing.points.at(-1)!;
    passing.points = [start, { x: arrival.x, y: start.y }, arrival, end];
    const originalBends = new Map(endRouteMetrics(d).map((e) => [e.id, e.endBends]));
    const otherRoutes = d.edges.filter((e) => e !== passing).map((e) => e.points);
    const before = assessQuality(d);
    expect(before.edgeNodeClearanceViolations).toBe(1);
    repairEdgeNodeClearance(d, model, interMetrics);
    const after = assessQuality(d);
    expect(after.edgeNodeClearanceViolations).toBe(0);
    expect(d.nodes.map((n) => n.box)).toEqual(positions);
    expect(d.edges.filter((e) => e !== passing).map((e) => e.points)).toEqual(otherRoutes);
    for (const route of endRouteMetrics(d)) {
      expect(route.endBends).toBeLessThanOrEqual(4);
      expect(route.endBends - originalBends.get(route.id)!).toBeLessThanOrEqual(2);
    }
    for (const key of Object.keys(regressionBaseline["parcel-distribution"]!) as RegressionMetric[]) if (key !== "endBendsMax") expect(after[key]).toBeLessThanOrEqual(before[key]);
    for (const key of ["shapeCrossings", "tinySegments", "labelLoose", "edgeOverlap"] as const) expect(after[key]).toBeLessThanOrEqual(before[key]);
  });

  it("leaves a four-bend route unresolved when clearing it needs more bends", async () => {
    const model = parseModel(readFileSync("bench/fixtures/mid/parcel-distribution.er.yaml", "utf8")).model!;
    const { diagram: d } = await layout(model);
    const passing = d.edges.find((e) => e.id === "edge:PLACED_IN#0")!;
    const start = passing.points[0]!, arrival = passing.points.at(-2)!, end = passing.points.at(-1)!;
    passing.points = [start, { x: arrival.x, y: start.y }, { x: arrival.x, y: arrival.y - 38 },
      { x: arrival.x - 20, y: arrival.y - 38 }, { x: arrival.x - 20, y: arrival.y }, end];
    const original = passing.points;
    expect(assessQuality(d)).toMatchObject({ edgeNodeClearanceViolations: 1, endBendsMax: 4, tinySegments: 0 });
    const after = repairEdgeNodeClearance(d, model, interMetrics);
    expect(after.edgeNodeClearanceViolations).toBe(1);
    expect(passing.points).toEqual(original);
    expect(layoutConflictDiagnostics(after, {})).toEqual([expect.objectContaining({ rule: "layout-conflict" })]);
  });

  it.each(["middle", "arrival"])("clears a movable %s corridor while preserving bend count and benchmark metrics", (corridor) => {
    const model = normalize({ version: 1, entities: { Target: {}, Observer: {} }, relationships: {
      LINK: { ends: [{ entity: "Target", card: "0..N" }, { entity: "Observer", card: "0..N" }] },
    } });
    const source = { ...node("R:LINK", "relationship"), box: { x: 0, y: 100, w: 80, h: 40 } };
    const target = { ...node("E:Target"), box: { x: 300, y: 240, w: 80, h: 40 } };
    const foreign = { ...node("E:Observer"), box: corridor === "middle" ? { x: 208, y: 140, w: 80, h: 20 } : { x: 220, y: 268, w: 70, h: 40 } };
    const passing = { ...edge([{ x: 80, y: 120 }, { x: 200, y: 120 }, { x: 200, y: 260 }, { x: 300, y: 260 }]), from: source.id, to: target.id, end: "LINK#0" };
    const d = diagram([source, target, foreign], [passing]);
    const positions = d.nodes.map((n) => ({ ...n.box }));
    const before = assessQuality(d);
    expect(before.edgeNodeClearanceViolations).toBe(1);
    const after = repairEdgeNodeClearance(d, model, interMetrics);
    expect(after).toMatchObject({ edgeNodeClearanceViolations: 0, endBendsMax: 2, endBendsMean: 2, tinySegments: 0 });
    expect(d.nodes.map((n) => n.box)).toEqual(positions);
    for (const key of Object.keys(regressionBaseline["parcel-distribution"]!) as RegressionMetric[]) expect(after[key]).toBeLessThanOrEqual(before[key]);
  });
});
