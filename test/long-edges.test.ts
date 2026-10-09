import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { boxGap, parallelGap } from "../src/core/layout/semantic-clearance.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const model = parseModel(readFileSync("bench/fixtures/campus.er.yaml", "utf8")).model!;

describe("long edge metrics", () => {
  it("reports the longest and mean end edge relative to the median entity width", async () => {
    const { diagram } = await layout(model);
    const q = assessQuality(diagram, {}, model);
    expect(q.longEdgeMax).toBeGreaterThan(0);
    expect(q.longEdgeMax).toBeGreaterThanOrEqual(q.longEdgeMean);
    expect(q.longEdgeMax).toBeCloseTo(q.longestEdgeRatio, 9);
    expect(q.longEdgeMean).toBeCloseTo(q.meanEdgeRatio, 9);
  });

  it("keeps the recursive diamond within two entity heights of its entity", async () => {
    const { diagram } = await layout(model);
    const entity = diagram.nodes.find((n) => n.id === "E:STAFF")!, diamond = diagram.nodes.find((n) => n.id === "R:SUPERVISES")!;
    const arm = Math.abs(center(entity.box).y - center(diamond.box).y) - entity.box.h / 2 - diamond.box.h / 2;
    expect(arm).toBeLessThanOrEqual(entity.box.h * 2);
  });
});

describe("attribute clearance metrics", () => {
  it("measures the gap of nearly parallel segments that overlap along their direction", () => {
    expect(parallelGap({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 10, y: 20 }, { x: 10, y: 120 })).toBe(10);
    expect(parallelGap({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 10, y: 200 }, { x: 10, y: 300 })).toBeUndefined();
    expect(parallelGap({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 50 }, { x: 100, y: 50 })).toBeUndefined();
  });

  it("measures the gap between boxes", () => {
    expect(boxGap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(10);
    expect(boxGap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(0);
  });

  it("keeps the campus spokes clear of end edges and ovals clear of labels", async () => {
    const q = assessQuality((await layout(model)).diagram, {}, model);
    expect(q.spokeEdgeViolations).toBe(0);
    expect(q.spokeLabelViolations).toBe(0);
  });
});
