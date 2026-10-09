import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { center, type Diagram, type Point } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { parseModel, type NModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const fixtures = [
  ...readdirSync("bench/fixtures").filter((f) => f.endsWith(".er.yaml") && f !== "pinned.er.yaml").map((f) => `bench/fixtures/${f}`),
  "examples/library.er.yaml",
];

const model = (path: string): NModel => parseModel(readFileSync(path, "utf8")).model!;
const centers = (d: Diagram): Record<string, Point> => Object.fromEntries(d.nodes.map((n) => [n.id, center(n.box)]));
const shapes = (d: Diagram) => d.nodes.filter((n) => n.kind !== "attribute");

describe("incremental layout", () => {
  it.each(fixtures)("moving one entity leaves the rest of %s in place", async (path) => {
    const m = model(path);
    const first = (await layout(m)).diagram;
    const before = centers(first);
    const target = m.entities[0]!.id;
    const pin = { x: before[target]!.x + 160, y: before[target]!.y + 96 };
    const next = (await layout(m, { pins: { [target]: pin }, positions: before })).diagram;
    const after = centers(next);

    expect(after[target]!.x).toBeCloseTo(pin.x, 5);
    expect(after[target]!.y).toBeCloseTo(pin.y, 5);
    const others = shapes(next).filter((n) => n.id !== target);
    const moves = others.map((n) => Math.hypot(after[n.id]!.x - before[n.id]!.x, after[n.id]!.y - before[n.id]!.y));
    // Only shapes the moved entity collides with may move: at most two, or a quarter of a larger diagram.
    const movedCount = moves.filter((d) => d >= 0.5).length;
    expect(movedCount).toBeLessThanOrEqual(Math.max(2, Math.floor(others.length / 4)));
    expect(next.nodes.filter((n) => n.pinned).map((n) => n.id)).toEqual([target]);

    const q = assessQuality(next, { [target]: pin });
    expect([q.overlaps, q.shapeCrossings, q.pinDrift]).toEqual([0, 0, 0]);
  });

  it("keeps old entities in place when a new entity is added to the model", async () => {
    const text = readFileSync("examples/library.er.yaml", "utf8");
    const before = centers((await layout(parseModel(text).model!)).diagram);
    const grown = text.replace(
      "relationships:",
      "  BRANCH:\n    attrs: [BranchNo, City]\n    keys: [[BranchNo]]\nrelationships:\n  HOLDS:\n    ends: [{entity: BRANCH, card: 0..N}, {entity: COPY, card: 1..1}]",
    );
    const m = parseModel(grown).model!;
    const next = (await layout(m, { positions: before })).diagram;
    const after = centers(next);
    for (const e of ["E:BOOK", "E:COPY", "E:MEMBER", "E:PUBLISHER"]) {
      expect(Math.hypot(after[e]!.x - before[e]!.x, after[e]!.y - before[e]!.y)).toBeLessThan(0.5);
    }
    expect(after["E:BRANCH"]).toBeDefined();
    expect(assessQuality(next).overlaps).toBe(0);
  });
});
