import { describe, expect, it } from "vitest";
import { modelStructure, preferFresh } from "../src/app/auto-relayout.js";
import { parseModel } from "../src/core/normalize.js";
import { quality, renderText, STARTER_MODEL } from "../src/app/render.js";

const structure = (text: string) => modelStructure(parseModel(text).model!);
describe("automatic re-layout policy", () => {
  it("compares graph identity and endpoint entities, ignoring labels, attributes, cardinalities and map order", () => {
    const before = structure(STARTER_MODEL);
    expect(structure(STARTER_MODEL.replace("StudentId, Name", "StudentId, Name, Email"))).toBe(before);
    expect(structure(STARTER_MODEL.replace("0..N", "1..N"))).toBe(before);
    expect(structure(STARTER_MODEL.replace("title: Course enrollment", "title: Changed"))).toBe(before);
    expect(structure(STARTER_MODEL.replace("relationships:", "  ROOM: {}\nrelationships:"))).not.toBe(before);
    expect(structure(STARTER_MODEL.replace("entity: COURSE", "entity: STUDENT"))).not.toBe(before);
    expect(structure(STARTER_MODEL.replace("entity: COURSE", "id: course\n        entity: COURSE"))).not.toBe(before);
    expect(structure(STARTER_MODEL.replace("ENROLLS:", "ATTENDS:"))).not.toBe(before);
    const model = parseModel(STARTER_MODEL).model!;
    model.entities.reverse(); model.relationships.reverse();
    for (const r of model.relationships) r.ends.reverse();
    expect(modelStructure(model)).toBe(before);
  });
  it("keeps ties and small improvements, accepts the exact thresholds, and rejects pin drift or worse violations", async () => {
    const q = quality((await renderText(STARTER_MODEL)).diagram!);
    const before = { ...q, edgeCrossings: 4, longEdgeMax: 10 };
    expect(preferFresh(before, before)).toBe(false);
    expect(preferFresh(before, { ...before, edgeCrossings: 3, longEdgeMax: 8.01 })).toBe(false);
    expect(preferFresh(before, { ...before, edgeCrossings: 2 })).toBe(true);
    expect(preferFresh(before, { ...before, longEdgeMax: 8 })).toBe(true);
    expect(preferFresh({ ...before, hierarchyViolations: 1 }, before)).toBe(true);
    expect(preferFresh(before, { ...before, overlaps: before.overlaps + 1, longEdgeMax: 1, edgeCrossings: 0 })).toBe(false);
    expect(preferFresh({ ...before, hierarchyViolations: 10 }, { ...before, pinDrift: 1 })).toBe(false);
    expect(preferFresh({ ...before, longEdgeMax: 0 }, { ...before, longEdgeMax: 0 })).toBe(false);
  });
});
