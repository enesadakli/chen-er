import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { semanticPlacements } from "../src/core/layout/semantic.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const load = (path: string) => parseModel(readFileSync(path, "utf8")).model!;
const hard = (q: ReturnType<typeof assessQuality>) => ({ overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, labelAmbiguity: q.labelAmbiguity, pinDrift: q.pinDrift, attributeEdgeBends: q.attributeEdgeBends, edgeOverlap: q.edgeOverlap, tinySegments: q.tinySegments, endPortCrowding: q.endPortCrowding, diamondVertexViolations: q.diamondVertexViolations, doubleEdgeArtifacts: q.doubleEdgeArtifacts });
const clear = { overlaps: 0, shapeCrossings: 0, labelCollisions: 0, labelAmbiguity: 0, pinDrift: 0, attributeEdgeBends: 0, edgeOverlap: 0, tinySegments: 0, endPortCrowding: 0, diamondVertexViolations: 0, doubleEdgeArtifacts: 0 };

describe("semantic default layout", () => {
  it.skipIf(!existsSync("examples/private/university-curriculum.er.yaml"))("satisfies the university hierarchy, midpoint, axis, crossing and compactness acceptance", async () => {
    const m = load("examples/private/university-curriculum.er.yaml"), first = await layout(m), q = assessQuality(first.diagram, {}, m);
    expect(hard(q)).toEqual(clear);
    for (const id of ["edge:A:DEPT.DOffice", "edge:A:STUDENT.Addr"]) expect(first.diagram.edges.find((e) => e.id === id)!.points).toHaveLength(2);
    expect(q.hierarchyViolations).toBe(0);
    expect(q.diamondOffset).toBeLessThanOrEqual(0.15);
    expect(q.axisAligned).toBeGreaterThanOrEqual(0.6);
    expect(q.edgeCrossings).toBeLessThanOrEqual(2);
    expect(q.aspect).toBeGreaterThanOrEqual(0.6);
    expect(q.aspect).toBeLessThanOrEqual(1.8);
    expect(q.meanEdgeRatio).toBeLessThanOrEqual(3.5);
    expect(q.longestEdgeRatio).toBeLessThanOrEqual(7);
    expect(Math.max(first.diagram.width, first.diagram.height)).toBeLessThanOrEqual(2800);
    const y = (id: string) => center(first.diagram.nodes.find((n) => n.id === `E:${id}`)!.box).y;
    for (const [parent, child] of [["COLLEGE", "DEPT"], ["DEPT", "COURSE"], ["COURSE", "SECTION"], ["DEPT", "CURRICULUM"], ["CURRICULUM", "ELECTIVE_GROUP"]]) expect(y(parent!)).toBeLessThan(y(child!) - 20);
    expect(await layout(m)).toEqual(first);
  }, 30000);
  it("keeps library diamonds between adjacent entities with no hierarchy violations", async () => {
    const m = load("examples/library.er.yaml"), d = (await layout(m)).diagram, q = assessQuality(d, {}, m);
    expect(hard(q)).toEqual(clear);
    expect(q.hierarchyViolations).toBe(0);
    expect(q.diamondOffset).toBeLessThanOrEqual(0.2);
    expect(q.axisAligned).toBeGreaterThanOrEqual(0.6);
  });
  it("reports the unavoidable company hierarchy cycle once while keeping diamonds close", async () => {
    const m = load("bench/fixtures/hub-company.er.yaml"), d = (await layout(m)).diagram, q = assessQuality(d, {}, m);
    expect(hard(q)).toEqual(clear);
    // WORKS_FOR and MANAGES impose opposite orders on the same two entities.
    expect(q.hierarchyViolations).toBe(1);
    expect(q.diamondOffset).toBeLessThanOrEqual(0.2);
  }, 15000);
  it("uses longest-path ranks for weak-owner chains regardless of declaration order", () => {
    const m = parseModel("version: 1\nentities: {C: {weak: true}, A: {}, B: {weak: true}}\nrelationships:\n  BC: {identifies: C, ends: [{entity: B, card: 1..N}, {entity: C, card: 1..1}]}\n  AB: {identifies: B, ends: [{entity: A, card: 1..N}, {entity: B, card: 1..1}]}\n").model!;
    const placements = semanticPlacements(m);
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) expect([p.ranks.get("E:A"), p.ranks.get("E:B"), p.ranks.get("E:C")]).toEqual([0, 1, 2]);
  });
  it("preserves absolute entity, diamond and attribute pins through semantic compaction", async () => {
    const m = load("examples/library.er.yaml");
    const pins = { "E:BOOK": { x: 700, y: 500 }, "R:COPY_OF": { x: 900, y: 800 }, "A:BOOK.ISBN": { x: 750, y: 300 } };
    const { diagram } = await layout(m, { pins });
    for (const [id, pin] of Object.entries(pins)) expect(center(diagram.nodes.find((n) => n.id === id)!.box)).toEqual(pin);
    expect(hard(assessQuality(diagram, pins, m))).toEqual(clear);
  }, 15000);
});
