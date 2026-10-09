import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardFailures, guardInputs, hierarchyMinimumOf, loadPins, regressionBaseline, stabilityOf } from "../bench/run.js";
import type { Diagram } from "../src/core/geometry.js";
import { DEFAULT_ENGINE, layout } from "../src/core/layout/index.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const PRIVATE = "examples/private/university-curriculum.er.yaml";
const privateAbsent = !existsSync(PRIVATE);

async function failuresOf(input: string): Promise<string[]> {
  const parsed = parseModel(readFileSync(input, "utf8"));
  if (!parsed.model) throw new Error(`${input}: ${JSON.stringify(parsed.diagnostics)}`);
  const model = parsed.model, pins = loadPins(input);
  const start = performance.now();
  const { diagram } = await layout(model, { engine: DEFAULT_ENGINE, pins });
  const elapsed = performance.now() - start;
  const q = assessQuality(diagram, pins, model);
  const stability = await stabilityOf(model, diagram, DEFAULT_ENGINE, pins);
  return guardFailures({ input, diagram, q, hierarchyMinimum: hierarchyMinimumOf(model), elapsed: process.env.CHEN_PERF === "1" ? elapsed : 0, stabilityMax: stability.max, stabilityMedian: stability.median });
}

// The same per-fixture guards `npm run bench` applies to the default engine.
describe("bench regression guards", () => {
  const inputs = guardInputs().filter((input) => input !== PRIVATE);

  it("covers the campus fixture and every bench fixture and public example", () => {
    expect(inputs).toContain("bench/fixtures/campus.er.yaml");
    expect(inputs).toContain("bench/fixtures/hub-company.er.yaml");
    expect(inputs).toContain("examples/library.er.yaml");
    expect(Object.keys(regressionBaseline)).toContain("campus");
  });

  it("rejects diagonal ends independently of the fixture baselines", () => {
    const diagram: Diagram = { width: 400, height: 400, nodes: [], edges: [{ id: "end", from: "R", to: "E", kind: "end", double: false, points: [{ x: 100, y: 100 }, { x: 200, y: 200 }] }], labels: [], notes: [], meta: { engine: DEFAULT_ENGINE } };
    const q = assessQuality(diagram);
    expect(guardFailures({ input: "examples/library.er.yaml", diagram, q, hierarchyMinimum: 0, elapsed: 0, stabilityMax: 0, stabilityMedian: 0 })).toContain("diagonalEnds: 1");
  });

  for (const input of inputs) it(input, async () => {
    expect(await failuresOf(input)).toEqual([]);
  }, 180000);

  it.skipIf(privateAbsent)(privateAbsent ? "university-curriculum (private model absent)" : "university-curriculum", async () => {
    expect(await failuresOf(PRIVATE)).toEqual([]);
  }, 180000);
});
