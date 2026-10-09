import { describe, expect, it } from "vitest";
import { parseCard, parseModel } from "../src/core/normalize.js";

describe("parseModel", () => {
  it("normalizes entities, keys, partial keys and ends", () => {
    const { model, diagnostics } = parseModel(`
version: 1
entities:
  DEPT: {attrs: [DName, DCode], keys: [[DName], [DCode]]}
  CURRICULUM: {weak: true, attrs: [EffectiveYear, {name: Info, parts: [A, B]}], partialKey: [EffectiveYear]}
relationships:
  DEFINES:
    identifies: CURRICULUM
    ends: [{entity: DEPT, card: 1..N}, {entity: CURRICULUM, card: 1..1}]
`);
    expect(diagnostics).toEqual([]);
    const cur = model!.entities.find((e) => e.name === "CURRICULUM")!;
    expect(cur.id).toBe("E:CURRICULUM");
    expect(cur.attrs[0]).toMatchObject({ id: "A:CURRICULUM.EffectiveYear", partial: true, key: false });
    expect(cur.attrs[1]!.parts.map((p) => p.id)).toEqual(["A:CURRICULUM.Info.A", "A:CURRICULUM.Info.B"]);
    const dept = model!.entities[0]!;
    expect(dept.attrs.every((a) => a.key)).toBe(true);
    const rel = model!.relationships[0]!;
    expect(rel.ends.map((e) => [e.id, e.min, e.max])).toEqual([
      ["DEFINES#0", 1, "N"],
      ["DEFINES#1", 1, 1],
    ]);
  });

  it("uses explicit end ids for recursive relationships", () => {
    const { model } = parseModel(`
version: 1
entities: {EMPLOYEE: {attrs: [Id]}}
relationships:
  SUPERVISION:
    ends:
      - {id: boss, entity: EMPLOYEE, role: supervisor, card: 0..N}
      - {id: sub, entity: EMPLOYEE, role: supervisee, card: 0..1}
`);
    expect(model!.relationships[0]!.ends.map((e) => e.id)).toEqual(["SUPERVISION#boss", "SUPERVISION#sub"]);
  });

  it("reports schema errors with a source line", () => {
    const { model, diagnostics } = parseModel(`version: 1
entities:
  A:
    attrs: [X]
relationships:
  R:
    ends:
      - {entity: A, card: one}
      - {entity: A, card: 0..1}
`);
    expect(model).toBeUndefined();
    expect(diagnostics[0]).toMatchObject({ rule: "schema", severity: "error", path: "relationships.R.ends.0.card", line: 8 });
  });

  it("reports duplicate keys as duplicate-id", () => {
    const { diagnostics } = parseModel(`version: 1
entities:
  A: {attrs: [X]}
  A: {attrs: [Y]}
`);
    expect(diagnostics[0]).toMatchObject({ rule: "duplicate-id", severity: "error", line: 4 });
  });

  it("parses cardinalities", () => {
    expect(parseCard("5..N")).toEqual({ min: 5, max: "N" });
    expect(parseCard("1..3")).toEqual({ min: 1, max: 3 });
  });
});
