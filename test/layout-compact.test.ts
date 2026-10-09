import { describe, expect, it } from "vitest";
import type { DEdge, DNode, Diagram } from "../src/core/geometry.js";
import { layoutScore } from "../src/core/layout/compact.js";
import { orthogonalPath } from "../src/core/layout/semantic-edges.js";
import { routeEdge } from "../src/core/layout/route.js";
import { assessQuality } from "../src/core/quality.js";

const empty: Diagram = { width: 600, height: 600, nodes: [], edges: [], labels: [], notes: [], meta: { engine: "test" } };

describe("compact candidate selection", () => {
  it.each(["overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "pinDrift"] as const)("rejects %s even with an otherwise better score", (metric) => {
    const q = { ...assessQuality(empty), density: 0.9, meanEdgeRatio: 0.1, [metric]: 1 };
    expect(layoutScore(q)).toBe(Infinity);
  });
  it("balances crossings, edge lengths, page aspect and density", () => {
    const q = { ...assessQuality(empty), meanEdgeRatio: 3, density: 0.1 };
    expect(layoutScore(q)).toBeCloseTo(2.6);
    expect(layoutScore({ ...q, edgeCrossings: 1 })).toBeGreaterThan(layoutScore({ ...q, meanEdgeRatio: 4 }));
    expect(layoutScore({ ...q, aspect: 2.8 })).toBeCloseTo(8.6);
    expect(layoutScore({ ...q, density: 0.2 })).toBeLessThan(layoutScore(q));
  });
  it("routes a clear diagonal pair orthogonally around a foreign diamond", () => {
    const nodes: DNode[] = [
      { id: "r", kind: "relationship", label: "r", box: { x: 0, y: 150, w: 40, h: 40 }, double: false },
      { id: "e", kind: "entity", label: "e", box: { x: 200, y: -50, w: 40, h: 40 }, double: false },
      { id: "foreign", kind: "relationship", label: "foreign", box: { x: 100, y: 50, w: 100, h: 100 }, double: false },
    ];
    const edge: DEdge = { id: "end", kind: "end", from: "r", to: "e", points: [], double: false };
    edge.points = routeEdge(edge, nodes, []);
    expect(orthogonalPath(edge.points)).toBe(true);
    expect(assessQuality({ ...empty, nodes, edges: [edge] }).shapeCrossings).toBe(0);
  });
});
