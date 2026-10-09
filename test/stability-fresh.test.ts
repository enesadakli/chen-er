import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { parseModel, type NModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { LayoutFile } from "../src/core/schema.js";

const fixtures = readdirSync("bench/fixtures").filter((f) => f.endsWith(".er.yaml")).sort().map((f) => `bench/fixtures/${f}`);
fixtures.push("examples/library.er.yaml");
if (existsSync("examples/private/university-curriculum.er.yaml")) fixtures.push("examples/private/university-curriculum.er.yaml");
const hardMetrics = ["overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const;

describe("fresh attribute edit stability", () => {
  it.each(fixtures)("keeps entity cells and local displacement within budget: %s", async (file) => {
    const model = parseModel(readFileSync(file, "utf8")).model!;
    const pins = file === "bench/fixtures/pinned.er.yaml" ? LayoutFile.parse(JSON.parse(readFileSync(file.replace(".er.yaml", ".er.layout.json"), "utf8"))).pins : {};
    const original = (await layout(model, { pins })).diagram;
    const centers = new Map(original.nodes.filter((n) => n.kind === "entity").map((n) => [n.id, center(n.box)]));
    const displacement: number[] = [];
    for (const owner of model.entities) {
      const modified: NModel = { ...model, entities: model.entities.map((e) => e !== owner ? e : { ...e, attrs: [...e.attrs, {
        id: `A:${e.name}.Extra`, name: "Extra", label: "Extra", owner: e.name, ownerKind: "entity", parts: [], multivalued: false, derived: false, key: false, partial: false, path: "test.extra",
      }] }) };
      const next = (await layout(modified, { pins })).diagram;
      const q = assessQuality(next, pins, modified);
      for (const metric of hardMetrics) expect(q[metric], `${owner.id}: ${metric}`).toBe(0);
      const positions = new Map(next.nodes.filter((n) => n.kind === "entity").map((n) => [n.id, center(n.box)]));
      for (const [id, before] of centers) {
        const after = positions.get(id)!;
        displacement.push(Math.hypot(after.x - before.x, after.y - before.y));
        for (const [other, point] of centers) {
          const target = positions.get(other)!;
          expect(Math.sign(after.x - target.x), `${owner.id}: column order`).toBe(Math.sign(before.x - point.x));
          expect(Math.sign(after.y - target.y), `${owner.id}: rank order`).toBe(Math.sign(before.y - point.y));
        }
      }
    }
    displacement.sort((a, b) => a - b);
    expect(Math.max(0, ...displacement)).toBeLessThanOrEqual(60);
    const median = displacement.length ? (displacement[Math.floor(displacement.length / 2)]! + displacement[Math.floor((displacement.length - 1) / 2)]!) / 2 : 0;
    expect(median).toBeLessThanOrEqual(20);
  }, 30000);
});
