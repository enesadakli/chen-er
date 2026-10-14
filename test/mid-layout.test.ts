import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { DEdge, DNode } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { placeLabels } from "../src/core/layout/labels.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { renderSvg } from "../src/core/render/svg.js";
import { interMetrics } from "../src/core/text/metrics.js";

it("renders a fresh distribution network without shape crossings or loose labels", async () => {
  const parsed = parseModel(readFileSync("bench/fixtures/mid/parcel-distribution.er.yaml", "utf8"));
  expect(parsed.diagnostics).toEqual([]);
  const model = parsed.model!;
  expect(model.entities).toHaveLength(8);
  expect(model.relationships).toHaveLength(8);
  expect(model.relationships.filter((r) => r.ends.length === 3)).toHaveLength(2);
  expect(model.entities.filter((e) => e.weak)).toHaveLength(1);
  expect(model.relationships.filter((r) => r.identifies)).toHaveLength(1);
  expect(model.entities.some((e) => e.attrs.some((a) => a.multivalued && a.parts.length > 1))).toBe(true);
  const result = await layout(model);
  expect(renderSvg(result.diagram)).toContain("<svg");
  expect(result.diagnostics.filter((d) => d.rule === "layout-conflict")).toEqual([]);
  expect(assessQuality(result.diagram, {}, model)).toMatchObject({
    overlaps: 0, shapeCrossings: 0, labelLoose: 0, labelCollisions: 0,
    labelAmbiguity: 0, labelOnOwnEdge: 0, labelOnAnyEdge: 0,
    edgeOverlap: 0, tinySegments: 0, endBendsMax: 4, edgeNodeClearanceViolations: 0,
  });
}, 10000);

it("uses the finite end of a short segment when intermediate label slots are blocked", () => {
  const model = normalize({ version: 1, entities: { HUB: {} }, relationships: {
    LINK: { ends: [{ entity: "HUB", card: "0..N" }, { entity: "HUB", card: "0..N" }] },
  } });
  const entity: DNode = { id: "E:HUB", kind: "entity", label: "Hub", double: false,
    box: { x: 200, y: 200, w: 110, h: 46 } };
  const edge: DEdge = { id: "edge:LINK#0", kind: "end", from: "R:LINK", to: entity.id,
    end: "LINK#0", double: false,
    points: [{ x: 358, y: 252 }, { x: 334, y: 252 }, { x: 334, y: 223 }, { x: 310, y: 223 }] };
  const labels = placeLabels(model, [entity], [edge], interMetrics);
  const q = assessQuality({ width: 500, height: 500, nodes: [entity], edges: [edge], labels,
    notes: [], meta: { engine: "test" } });
  expect(q).toMatchObject({ labelLoose: 0, labelOnOwnEdge: 0, labelCollisions: 0 });
  expect(labels[0]!.box.x + labels[0]!.box.w / 2).toBe(334);
});
