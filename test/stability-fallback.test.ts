import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardInputs, stabilityOf } from "../bench/run.js";
import { boxAround, center, type DEdge, type DLabel, type DNode } from "../src/core/geometry.js";
import { placeAttributes } from "../src/core/layout/attributes.js";
import { measureClusters } from "../src/core/layout/clusters.js";
import { layout } from "../src/core/layout/index.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import { interMetrics } from "../src/core/text/metrics.js";

const labelFrame: DLabel[] = [
  { x: -2000, y: -55, w: 4000, h: 20 },
  { x: -2000, y: 35, w: 4000, h: 20 },
  { x: -90, y: -2000, w: 20, h: 4000 },
  { x: 70, y: -2000, w: 20, h: 4000 },
].map((box, i) => ({ id: `label:${i}`, kind: "cardinality", text: "(1,N)", edge: `edge:${i}`, box }));

function fanInput() {
  const model = normalize({ version: 1, entities: { BENCH: { attrs: ["Code"] } } });
  const clusters = measureClusters(model, interMetrics, {});
  const nodes = clusters.map((c) => c.node);
  const edges: DEdge[] = [];
  return { clusters, nodes, edges };
}

describe("attribute fallback stability", () => {
  it("retries a blocked fan while deferring provisional label lines", () => {
    const { clusters, nodes, edges } = fanInput();
    const before = center(nodes[0]!.box);
    expect(placeAttributes(clusters, nodes, edges, interMetrics, new Map(), labelFrame)).toBe(false);
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
    expect(placeAttributes(clusters, nodes, edges, interMetrics, new Map(), labelFrame, {}, true)).toBe(true);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(center(nodes[0]!.box)).toEqual(before);
  });

  it("retains shape and oval/label clearance during the retry", () => {
    const { clusters, nodes, edges } = fanInput();
    const blocked: DLabel[] = [{ ...labelFrame[0]!, box: { x: -2000, y: -2000, w: 4000, h: 4000 } }];
    expect(placeAttributes(clusters, nodes, edges, interMetrics, new Map(), blocked, {}, true)).toBe(false);
    const obstacle: DNode = { id: "E:OBSTACLE", kind: "entity", label: "Obstacle", double: false,
      box: boxAround({ x: 0, y: 0 }, 4000, 4000) };
    nodes.push(obstacle);
    expect(placeAttributes(clusters, nodes, edges, interMetrics, new Map(), [], {}, true)).toBe(false);
  });

  it("includes the mid-size fixture in the normal guards", () => {
    expect(guardInputs()).toContain("bench/fixtures/mid/parcel-distribution.er.yaml");
  });

  it("keeps a public short-label edit from selecting an expansive radial fallback", async () => {
    const parsed = parseModel(readFileSync("bench/fixtures/mid/parcel-distribution.er.yaml", "utf8")).model!;
    const model = { ...parsed, entities: parsed.entities.map((entity) => entity.name !== "AGENCY" ? entity : {
      ...entity, attrs: entity.attrs.map((attr) => attr.name !== "Region" ? attr : { ...attr, label: "ID" }),
    }) };
    const { diagram } = await layout(model);
    const stability = await stabilityOf(model, diagram, "layered", {});
    expect(stability.max).toBeLessThanOrEqual(60);
    expect(stability.median).toBeLessThanOrEqual(20);
  }, 120000);

  it.skipIf(!existsSync("examples/private/fa.er.yaml")).each(["layered", "stress"] as const)(
    "keeps fresh private attribute edits within the normal budget: %s", async (engine) => {
      const model = parseModel(readFileSync("examples/private/fa.er.yaml", "utf8")).model!;
      const { diagram } = await layout(model, { engine });
      const stability = await stabilityOf(model, diagram, engine, {});
      expect(stability.max).toBeLessThanOrEqual(60);
      expect(stability.median).toBeLessThanOrEqual(20);
    }, 120000,
  );
});
