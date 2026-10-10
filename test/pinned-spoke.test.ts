import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPins, renderFile } from "../src/app/render.js";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { boxSegmentDistance } from "../src/core/layout/label-geometry.js";
import { boxGap, MIN_OVAL_LABEL_CLEARANCE } from "../src/core/layout/semantic-clearance.js";
import { hierarchyPairs, modelRelations } from "../src/core/layout/semantic-graph.js";
import { parseModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const file = "test/fixtures/pinned-spoke/university.er.yaml";
const source = readFileSync(file, "utf8");
const model = parseModel(source).model!;
const options = readPins(file).options;

const badPairs = (positions: NonNullable<typeof options.positions>) => hierarchyPairs(modelRelations(model)).filter(({ parent, child }) => {
  const p = positions[parent]!, c = positions[child]!;
  return !(p.y < c.y - 20 || (Math.abs(p.y - c.y) <= 20 && p.x < c.x - 20));
});

describe("fixed attribute label clearance", () => {
  it("renders the saved layout with exact real pins and releases only the blocking soft attribute", async () => {
    const layoutBytes = readFileSync(file.replace(".yaml", ".layout.json"), "utf8");
    const result = await renderFile(file);
    const diagram = result.diagram!, q = assessQuality(diagram, options.pins, model);
    expect(q).toMatchObject({ spokeLabelViolations: 0, labelOnAnyEdge: 0, labelCollisions: 0, labelLoose: 0, labelAmbiguity: 0,
      labelOnOwnEdge: 0, overlaps: 0, shapeCrossings: 0, pinDrift: 0, edgeCrossings: 0 });
    for (const node of diagram.nodes) {
      if (node.id !== "A:COURSE.Code") expect(center(node.box)).toEqual(options.positions![node.id]);
      expect(node.pinned).toBe(!!options.pins?.[node.id]);
    }
    expect(center(diagram.nodes.find((n) => n.id === "A:COURSE.Code")!.box)).not.toEqual(options.positions!["A:COURSE.Code"]);
    const label = diagram.labels.find((l) => l.edge === "edge:OFFERS#1")!;
    const spoke = diagram.edges.find((e) => e.id === "edge:A:COURSE.Title")!;
    expect(boxSegmentDistance(label.box, spoke.points[0]!, spoke.points[1]!)).toBeGreaterThan(2);
    expect(diagram.nodes.filter((n) => n.kind === "attribute").every((n) => boxGap(label.box, n.box) >= MIN_OVAL_LABEL_CLEARANCE)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(readFileSync(file.replace(".yaml", ".layout.json"), "utf8")).toBe(layoutBytes);
  });

  it("never releases the blocking attribute when it is also a real pin", async () => {
    const pins = { ...options.pins, "A:COURSE.Code": options.positions!["A:COURSE.Code"]! };
    const { diagram } = await layout(model, { ...options, pins });
    for (const [id, position] of Object.entries(pins)) expect(center(diagram.nodes.find((n) => n.id === id)!.box)).toEqual(position);
    expect(assessQuality(diagram, pins, model).pinDrift).toBe(0);
  });

  it("preserves all geometry of a clear saved layout on the next restore", async () => {
    const first = (await layout(model, options)).diagram;
    const positions = Object.fromEntries(first.nodes.map((n) => [n.id, center(n.box)]));
    const second = (await layout(model, { ...options, positions })).diagram;
    expect({ ...second, nodes: Object.fromEntries(second.nodes.map((n) => [n.id, n])) }).toEqual({ ...first, nodes: Object.fromEntries(first.nodes.map((n) => [n.id, n])) });
  });

  it("clears restored attribute geometry without real pins too", async () => {
    const { diagram } = await layout(model, { positions: options.positions });
    expect(assessQuality(diagram, {}, model)).toMatchObject({ spokeLabelViolations: 0, labelOnAnyEdge: 0, pinDrift: 0 });
    expect(diagram.nodes.every((n) => !n.pinned)).toBe(true);
  });

  it("keeps a pinned attribute clear when its relationship end also has a role", async () => {
    const withRole = parseModel(source).model!;
    withRole.relationships.find((r) => r.id === "R:OFFERS")!.ends[1]!.role = "course";
    const { diagram } = await layout(withRole, options);
    expect(diagram.labels.some((l) => l.edge === "edge:OFFERS#1" && l.kind === "role")).toBe(true);
    expect(assessQuality(diagram, options.pins, withRole)).toMatchObject({ spokeLabelViolations: 0, labelOnAnyEdge: 0, labelCollisions: 0, pinDrift: 0 });
  });

  it("attributes all three hierarchy violations to the saved coordinates, not the attribute pins", async () => {
    expect(badPairs(options.positions!)).toEqual([
      { parent: "E:DEAN", child: "E:DEPARTMENT" },
      { parent: "E:DEAN", child: "E:INSTRUCTOR" },
      { parent: "E:INSTRUCTOR", child: "E:COURSE" },
    ]);
    for (const pins of [options.pins, {}]) {
      const { diagram } = await layout(model, { ...options, pins });
      const positions = Object.fromEntries(diagram.nodes.map((n) => [n.id, center(n.box)]));
      expect(badPairs(positions)).toEqual(badPairs(options.positions!));
      expect(assessQuality(diagram, pins, model).hierarchyViolations).toBe(3);
    }
    const fresh = await renderFile(file, { positions: {} });
    expect(assessQuality(fresh.diagram!, options.pins, model)).toMatchObject({ hierarchyViolations: 0, spokeLabelViolations: 0, pinDrift: 0 });
  });
});
