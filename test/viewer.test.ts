import { describe, expect, it } from "vitest";
import { parseModel } from "../src/core/normalize.js";
import { diagnosticTarget } from "../src/app/targets.js";
import { findings, snap, targetBox, yamlExcerpt } from "../src/viewer/logic.js";
import { renderText, STARTER_MODEL } from "../src/app/render.js";

describe("viewer pure logic", () => {
  it("snaps diagram centers to 8px and allows free movement", () => {
    expect(snap({ x: 11, y: -11 })).toEqual({ x: 8, y: -8 });
    expect(snap({ x: 11.25, y: 19.5 }, true)).toEqual({ x: 11.25, y: 19.5 });
  });
  it("orders severity groups stably and assigns matching mark numbers", () => {
    const list = findings([
      { rule: "a", severity: "info", message: "info" },
      { rule: "b", severity: "error", message: "first error" },
      { rule: "c", severity: "heuristic", message: "heuristic" },
      { rule: "d", severity: "course", message: "course" },
      { rule: "e", severity: "error", message: "second error" },
    ]);
    expect(list.map((f) => [f.rule, f.number])).toEqual([["b", 1], ["e", 2], ["d", 3], ["c", 4], ["a", 5]]);
  });
  it("maps normalized attributes, composite parts and stable end ids precisely", () => {
    const parsed = parseModel(`version: 1
entities:
  PERSON:
    attrs:
      - name: Address
        parts: [Street, City]
relationships:
  KNOWS:
    attrs: [Since]
    ends:
      - {id: source, entity: PERSON, card: 0..N}
      - {id: target, entity: PERSON, card: 0..N}
`);
    expect(parsed.model).toBeDefined();
    const target = (path?: string) => diagnosticTarget(path, parsed.model);
    expect(target("entities.PERSON.weak")).toBe("E:PERSON");
    expect(target("entities.PERSON.attrs.0.name")).toBe("A:PERSON.Address");
    expect(target("entities.PERSON.attrs.0.parts.1.label")).toBe("A:PERSON.Address.City");
    expect(target("relationships.KNOWS.ends.1.card")).toBe("edge:KNOWS#target");
    expect(target("relationships.KNOWS.attrs.0")).toBe("A:KNOWS.Since");
    expect(target("relationships.KNOWS.note")).toBe("R:KNOWS");
    expect(target("entities.PERSON.attrs.9")).toBeUndefined();
    expect(target("relationships.KNOWS.ends.9")).toBeUndefined();
    expect(target("entities.PERSONA")).toBeUndefined();
    expect(target("notes.0")).toBeUndefined();
    expect(target()).toBeUndefined();
    expect(diagnosticTarget("entities.PERSON", undefined)).toBeUndefined();
  });
  it("returns a numbered ±3-line excerpt and clips it at file boundaries", () => {
    const yaml = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const excerpt = yamlExcerpt(yaml, 5);
    expect(excerpt.map((l) => l.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(excerpt.filter((l) => l.target)).toEqual([{ text: "line 5", line: 5, target: true }]);
    expect(yamlExcerpt(yaml, 1).map((l) => l.line)).toEqual([1, 2, 3, 4]);
    expect(yamlExcerpt(yaml, 10).map((l) => l.line)).toEqual([7, 8, 9, 10]);
    expect(yamlExcerpt(yaml, undefined)).toEqual([]);
    expect(yamlExcerpt(yaml, 99)).toEqual([]);
  });
  it("locates nodes and relationship edges in final geometry", async () => {
    const { diagram } = await renderText(STARTER_MODEL);
    expect(targetBox(diagram!, "E:STUDENT")).toEqual(diagram!.nodes.find((n) => n.id === "E:STUDENT")!.box);
    expect(targetBox(diagram!, "edge:ENROLLS#0")).toHaveProperty("x");
    expect(targetBox(diagram!, "unknown")).toBeUndefined();
    expect(targetBox(null, "E:STUDENT")).toBeUndefined();
  });
});
