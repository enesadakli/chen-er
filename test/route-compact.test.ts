import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { endRouteMetrics, orthogonalPath } from "../src/core/layout/semantic-edges.js";
import { distance, segments } from "../src/core/layout/shapes.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const hardMetrics = ["overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const;

describe("compact textbook examples", () => {
  it("removes empty company rows while keeping readable straight ends and symmetric mentoring arms", async () => {
    const model = parseModel(readFileSync("examples/company-project.er.yaml", "utf8")).model!;
    const { diagram } = await layout(model);
    const q = assessQuality(diagram, {}, model);
    for (const metric of hardMetrics) expect(q[metric], metric).toBe(0);
    expect(q.edgeCrossings).toBe(0);
    expect(q.hierarchyViolations).toBe(0);
    expect(diagram.width * diagram.height).toBeLessThanOrEqual(1633632 * 0.7);
    expect(q.emptyAreaRatio).toBeLessThanOrEqual(0.9528637261622064);
    expect(q.plainSegmentRatio).toBeLessThanOrEqual(2);
    for (const route of endRouteMetrics(diagram)) expect(route.endBends, route.id).toBe(0);
    for (const e of diagram.edges.filter((e) => e.kind === "end")) {
      expect(orthogonalPath(e.points), e.id).toBe(true);
      expect(segments(e.points).reduce((sum, [a, b]) => sum + distance(a, b), 0), e.id).toBeGreaterThanOrEqual(60);
    }
    const employee = diagram.nodes.find((n) => n.id === "E:EMPLOYEE")!;
    const diamond = diagram.nodes.find((n) => n.id === "R:MENTORS")!, c = center(diamond.box);
    const arms = diagram.edges.filter((e) => e.kind === "end" && e.from === diamond.id);
    expect(arms).toHaveLength(2);
    for (const e of arms) {
      expect(e.points.at(-1)!.y).toBe(employee.box.y);
      expect(e.points[0]!.y).toBeGreaterThan(c.y);
      expect(Math.abs(e.points[0]!.x - c.x) / (diamond.box.w / 2) + Math.abs(e.points[0]!.y - c.y) / (diamond.box.h / 2)).toBeCloseTo(1);
    }
    expect(arms[0]!.points[0]!.x + arms[1]!.points[0]!.x).toBeCloseTo(c.x * 2);
    expect(arms[0]!.points[0]!.y).toBeCloseTo(arms[1]!.points[0]!.y);
  });

  it.each(["bench/fixtures/ternary.er.yaml", "examples/ternary.er.yaml"])("places each ternary entity on a cardinal axis with one straight end: %s", async (file) => {
    const model = parseModel(readFileSync(file, "utf8")).model!;
    const { diagram } = await layout(model);
    const q = assessQuality(diagram, {}, model);
    for (const metric of hardMetrics) expect(q[metric], metric).toBe(0);
    expect(q.edgeCrossings).toBe(0);
    expect(q.endBendsMax).toBe(0);
    expect(q.routeDetourMax).toBe(1);
    expect(q.diamondOffset).toBeLessThanOrEqual(0.2);
    const diamond = center(diagram.nodes.find((n) => n.kind === "relationship")!.box);
    const entities = diagram.nodes.filter((n) => n.kind === "entity").map((n) => center(n.box));
    expect(entities.filter((p) => p.y === diamond.y)).toHaveLength(2);
    expect(entities.filter((p) => p.x === diamond.x && p.y > diamond.y)).toHaveLength(1);
    for (const e of diagram.edges.filter((e) => e.kind === "end")) {
      expect(e.points).toHaveLength(2);
      expect(orthogonalPath(e.points)).toBe(true);
    }
  });
});
