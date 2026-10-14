import { describe, expect, it } from "vitest";
import { center, type Pins } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { normalize } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

// The two long spokes block opposite label slots while both ovals remain well clear.
const positions = {
  "E:SOURCE": { x: 200, y: 300 },
  "E:TARGET": { x: 700, y: 300 },
  "R:LINK": { x: 450, y: 300 },
  "A:TARGET.Upper": { x: 490, y: 250 },
  "A:TARGET.Lower": { x: 490, y: 350 },
};
const model = (role?: string) => normalize({
  version: 1,
  entities: { SOURCE: {}, TARGET: { attrs: ["Upper", "Lower"] } },
  relationships: { LINK: { ends: [{ entity: "SOURCE", card: "0..N" }, { entity: "TARGET", card: "0..N", role }] } },
});

const clear = { labelOnAnyEdge: 0, labelCollisions: 0, labelLoose: 0, labelAmbiguity: 0, spokeLabelViolations: 0,
  overlaps: 0, shapeCrossings: 0, pinDrift: 0 };

describe("participation labels beside saved attribute spokes", () => {
  it.each(["simple", "layered", "stress"] as const)("clears saved spokes without moving the %s skeleton", async (engine) => {
    const m = model();
    const saved = structuredClone(positions);
    const { diagram, diagnostics } = await layout(m, { engine, positions: saved });
    expect(assessQuality(diagram, {}, m)).toMatchObject(clear);
    expect(diagnostics).toEqual([]);
    for (const node of diagram.nodes) {
      if (node.kind !== "attribute") expect(center(node.box)).toEqual(positions[node.id as keyof typeof positions]);
      expect(node.pinned).toBe(false);
    }
    expect(saved).toEqual(positions);
    expect(assessQuality((await layout(m, { engine })).diagram, {}, m)).toMatchObject(clear);
  });

  it.each([{ x: 490, y: 250 }, { dx: -210, dy: -50 }])("keeps real pin %j exact while freeing the opposite label slot", async (pin) => {
    const m = model();
    const pins: Pins = { "A:TARGET.Upper": pin, "E:SOURCE": positions["E:SOURCE"] };
    const { diagram } = await layout(m, { positions, pins });
    expect(assessQuality(diagram, pins, m)).toMatchObject(clear);
    for (const node of diagram.nodes) if (pins[node.id] || node.kind !== "attribute") {
      expect(center(node.box)).toEqual(positions[node.id as keyof typeof positions]);
    }
  });

  it("clears both cardinality and role labels", async () => {
    const m = model("receiver");
    const { diagram, diagnostics } = await layout(m, { positions });
    expect(assessQuality(diagram, {}, m)).toMatchObject(clear);
    expect(diagnostics).toEqual([]);
    expect(diagram.labels.some((label) => label.kind === "role")).toBe(true);
  });

  it("keeps hard-pinned blockers and reports the remaining conflict", async () => {
    const m = model();
    const pins = { ...positions };
    const { diagram, diagnostics } = await layout(m, { positions, pins });
    const q = assessQuality(diagram, pins, m);
    expect(q).toMatchObject({ labelOnAnyEdge: 1, labelCollisions: 1, spokeLabelViolations: 0, pinDrift: 0 });
    expect(q.issues.find((issue) => issue.kind === "label-on-any-edge")?.ids)
      .toEqual(["label:edge:LINK#1:cardinality", "edge:A:TARGET.Upper"]);
    expect(diagnostics.some((d) => d.message.includes("label-on-any-edge"))).toBe(true);
    for (const node of diagram.nodes) expect(center(node.box)).toEqual(positions[node.id as keyof typeof positions]);
  });
});
