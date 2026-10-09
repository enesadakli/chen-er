import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hierarchyMinimumOf } from "../bench/run.js";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { endRouteMetrics } from "../src/core/layout/semantic-edges.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const CAMPUS = "bench/fixtures/campus.er.yaml";
const load = () => parseModel(readFileSync(CAMPUS, "utf8")).model!;
const clear = { overlaps: 0, shapeCrossings: 0, labelCollisions: 0, labelAmbiguity: 0, labelLoose: 0, pinDrift: 0, attributeEdgeBends: 0, edgeOverlap: 0, tinySegments: 0, endPortCrowding: 0, diamondVertexViolations: 0, doubleEdgeArtifacts: 0 };

// The same acceptance the private university model gets, on a public hospital model of equal structural difficulty.
describe("public acceptance on the campus fixture", () => {
  it("meets the hierarchy, midpoint, axis, crossing, route and compactness acceptance", async () => {
    const model = load();
    const started = performance.now();
    const first = await layout(model);
    const firstMs = performance.now() - started;
    const { diagram: d } = first;
    const q = assessQuality(d, {}, model);

    expect({ overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, labelAmbiguity: q.labelAmbiguity, labelLoose: q.labelLoose, pinDrift: q.pinDrift, attributeEdgeBends: q.attributeEdgeBends, edgeOverlap: q.edgeOverlap, tinySegments: q.tinySegments, endPortCrowding: q.endPortCrowding, diamondVertexViolations: q.diamondVertexViolations, doubleEdgeArtifacts: q.doubleEdgeArtifacts }).toEqual(clear);
    expect(q.diagonalEnds).toBe(0);
    expect(q.zRoutes).toBeLessThanOrEqual(1);
    expect(q.hierarchyViolations).toBe(hierarchyMinimumOf(model));
    expect(q.diamondOffset).toBeLessThanOrEqual(0.15);
    expect(q.axisAligned).toBeGreaterThanOrEqual(0.6);
    expect(q.edgeCrossings).toBeLessThanOrEqual(2);
    expect(q.routeDetourMax).toBeLessThanOrEqual(1.6);
    expect(q.endBendsMax).toBeLessThanOrEqual(2);
    expect(endRouteMetrics(d).filter((r) => r.endBends > 2)).toEqual([]);
    expect(q.aspect).toBeGreaterThanOrEqual(0.6);
    expect(q.aspect).toBeLessThanOrEqual(1.8);

    // The 1:N chain reads top-down.
    const y = (id: string) => center(d.nodes.find((n) => n.id === `E:${id}`)!.box).y;
    for (const [parent, child] of [["HOSPITAL", "WARD"], ["WARD", "ROOM"], ["ROOM", "BED"], ["WARD", "ADMISSION"]]) expect(y(parent!)).toBeLessThan(y(child!) - 20);

    // Compact ranks and spacing: v0.2 drew this model at 1700x2162 with 9821px of end edges and a 6.8 longest end.
    expect(q.longEdgeMax).toBeLessThanOrEqual(4);
    expect(d.width * d.height).toBeLessThanOrEqual(1700 * 2162 * 0.75);
    expect(q.edgeLength).toBeLessThanOrEqual(9821 * 0.75);
    // The patient sinks next to the staff hub it shares TREATS with, still above its admissions.
    expect(Math.abs(y("PATIENT") - y("STAFF"))).toBeLessThan(20);
    expect(y("PATIENT")).toBeLessThan(y("ADMISSION") - 20);

    // Layout is deterministic; time the faster of the two runs so a cold start does not decide the result.
    const again = performance.now();
    expect(await layout(model)).toEqual(first);
    if (process.env.CHEN_PERF === "1") expect(Math.min(firstMs, performance.now() - again)).toBeLessThan(2000);
  }, 30000);

  it("keeps the structural difficulty of the private model", () => {
    const model = load();
    expect(model.entities).toHaveLength(8);
    expect(model.relationships.length).toBeGreaterThanOrEqual(12);
    expect(model.relationships.length).toBeLessThanOrEqual(14);
    expect(model.entities.filter((e) => e.weak)).toHaveLength(1);
    expect(model.relationships.some((r) => r.identifies)).toBe(true);
    expect(model.relationships.some((r) => r.ends.length === 2 && r.ends[0]!.entity === r.ends[1]!.entity)).toBe(true);
    expect(model.relationships.some((r) => r.attrs.length > 0 && r.ends.every((e) => e.max === "N"))).toBe(true);
    const attrs = model.entities.flatMap((e) => e.attrs);
    expect(attrs.some((a) => a.parts.length > 0)).toBe(true);
    expect(attrs.some((a) => a.multivalued)).toBe(true);
    const pairs = model.relationships.filter((r) => r.ends.length === 2 && r.ends[0]!.entity !== r.ends[1]!.entity).map((r) => r.ends.map((e) => e.entity).sort().join("|"));
    expect(pairs.length).toBeGreaterThan(new Set(pairs).size);
  });
});
