import { describe, expect, it } from "vitest";
import { addAttribute } from "../src/app/model-mutations.js";
import { lintText } from "../src/app/render.js";

const yaml = `# modeling assumptions
version: 1
entities:
  PERSON: # keep owner comment
    attrs: [Id, {name: Address, parts: [Street, City]}] # keep attrs comment
    keys: [[Id]]
    note: "Don't drop this"
  TEAM: {}
relationships:
  JOINS: # relationship comment
    ends:
      - {entity: PERSON, card: 0..N}
      - {entity: TEAM, card: 0..N}
notes: [Keep this note]
`;
describe("attribute tree mutation", () => {
  it("supports existing flow/string/object/composite attrs and preserves comments and untouched data", () => {
    const next = addAttribute(yaml, "E:PERSON", { name: "Emails", label: "Email addresses", multivalued: true, derived: true });
    for (const comment of ["# modeling assumptions", "# keep owner comment", "# keep attrs comment", "# relationship comment"]) expect(next).toContain(comment);
    const parsed = lintText(next).model!;
    expect(parsed.entities[0]!.attrs.at(-1)).toMatchObject({ name: "Emails", label: "Email addresses", multivalued: true, derived: true });
    expect(parsed.entities[0]!.attrs[1]!.parts.map((a) => a.name)).toEqual(["Street", "City"]);
    expect(parsed.entities[0]!.keys).toEqual([["Id"]]); expect(parsed.entities[0]!.note).toBe("Don't drop this");
    expect(parsed.notes).toEqual(["Keep this note"]);
  });
  it("adds missing attrs to an empty entity and a relationship", () => {
    const next = addAttribute(addAttribute(yaml, "E:TEAM", { name: "Title" }), "R:JOINS", { name: "Since" });
    const parsed = lintText(next).model!;
    expect(parsed.entities[1]!.attrs[0]!.id).toBe("A:TEAM.Title");
    expect(parsed.relationships[0]!.attrs[0]!.id).toBe("A:JOINS.Since");
  });
  it("rejects invalid names, extra fields, invalid owners, duplicate names and structural errors", () => {
    for (const bad of [{ name: "bad name" }, { name: "Age", parts: ["A", "B"] }, { name: "Age", derived: "yes" }]) expect(() => addAttribute(yaml, "E:PERSON", bad)).toThrow();
    expect(() => addAttribute(yaml, "E:PERSON", { name: "Id" })).toThrow(/already exists/);
    expect(() => addAttribute(yaml, "E:PERSON", { name: "Street" })).toThrow(/already exists/);
    expect(() => addAttribute(yaml, "E:MISSING", { name: "Age" })).toThrow(/no longer exists/);
    expect(() => addAttribute(yaml, "A:PERSON.Id", { name: "Age" })).toThrow(/Select/);
    expect(() => addAttribute("version: [", "E:PERSON", { name: "Age" })).toThrow(/structural/);
  });
  it("keeps accepted course findings and does not expand aliases implicitly", () => {
    const next = addAttribute(yaml, "E:TEAM", { name: "Title" });
    expect(lintText(next).diagnostics.some((d) => d.severity === "course")).toBe(true);
    const aliased = yaml.replace("  TEAM: {}", "  TEAM: &team {}\n  SECOND: *team");
    expect(() => addAttribute(aliased, "E:SECOND", { name: "Name" })).toThrow(/alias/);
  });
});
