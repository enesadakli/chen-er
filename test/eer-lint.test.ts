import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { lint } from "../src/core/lint/index.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import type { ModelInput, SpecializationInput } from "../src/core/schema.js";

const spec = (overrides: Partial<SpecializationInput> = {}): SpecializationInput => ({
  supertype: "A", subtypes: ["B"], disjointness: "disjoint", completeness: "partial", ...overrides,
});
const input = (specializations: SpecializationInput[]): ModelInput => ({ version: 1, entities: {
  A: { attrs: ["Id", "Kind", { name: "Details", parts: ["Nested", "Other"] }], keys: [["Id"]] }, B: {}, C: {},
}, specializations });
const findings = (rule: string, specs: SpecializationInput[]) => lint(normalize(input(specs))).filter((d) => d.rule === rule);

describe("EER lint", () => {
  it.each([
    { rule: "specialization-self", bad: spec({ subtypes: ["A"] }), good: spec(), path: "subtypes.0", severity: "error" },
    { rule: "duplicate-subtype", bad: spec({ subtypes: ["B", { entity: "B", predicate: "x" }] }), good: spec({ subtypes: ["B", "C"] }), path: "subtypes.1", severity: "error" },
    { rule: "unknown-defining-attribute", bad: spec({ attribute: "Nested" }), good: spec({ attribute: "Kind" }), path: "attribute", severity: "error" },
    { rule: "attribute-defined-overlap", bad: spec({ attribute: "Kind", disjointness: "overlapping" }), good: spec({ attribute: "Kind" }), path: "attribute", severity: "course" },
  ])("checks $rule and source positions", ({ rule, bad, good, path, severity }) => {
    const parsed = parseModel(stringify(input([bad])));
    expect(parsed.diagnostics).toEqual([]);
    const found = lint(parsed.model!).filter((d) => d.rule === rule);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity, path: `specializations.0.${path}`, ...parsed.model!.locate(`specializations.0.${path}`) });
    expect(found[0]!.line).toBeGreaterThan(1);
    expect(findings(rule, [good])).toEqual([]);
  });

  it("rejects repeated ids and checks normalized names", () => {
    expect(findings("duplicate-specialization-id", [spec({ id: "shared" }), spec({ id: "shared" })]))
      .toMatchObject([{ path: "specializations.1.id", severity: "error" }]);
    const model = normalize(input([spec(), spec()]));
    model.specializations[1]!.name = model.specializations[0]!.name;
    expect(lint(model).filter((d) => d.rule === "duplicate-specialization-id")).toHaveLength(1);
    expect(findings("duplicate-specialization-id", [spec(), spec(), spec({ id: "named" })])).toEqual([]);
  });

  it("reports every simple cycle once at its closing edge in source order", () => {
    const specs = [spec({ subtypes: ["B", "C"] }), spec({ supertype: "B", subtypes: ["C"] }), spec({ supertype: "C", subtypes: ["A", "A"] })];
    const found = findings("specialization-cycle", specs);
    expect(found.map((d) => d.message)).toEqual([
      "Specialization cycle: A → B → C → A.", "Specialization cycle: A → C → A.",
    ]);
    expect(found.every((d) => d.path === "specializations.2.subtypes.0")).toBe(true);
    expect(findings("specialization-cycle", specs.slice(0, 2))).toEqual([]);
    expect(findings("specialization-cycle", [spec({ subtypes: ["A"] })])).toEqual([]);
    expect(findings("specialization-cycle", specs)).toEqual(found);
  });

  it("skips unknown supertypes and accepts multivalued or absent defining attributes", () => {
    expect(findings("unknown-defining-attribute", [spec({ supertype: "Missing", attribute: "Kind" })])).toEqual([]);
    const model = normalize(input([spec({ attribute: "Kind", disjointness: "overlapping" })]));
    model.entities[0]!.attrs.find((a) => a.name === "Kind")!.multivalued = true;
    expect(lint(model).filter((d) => d.rule === "attribute-defined-overlap")).toEqual([]);
    expect(findings("attribute-defined-overlap", [spec({ disjointness: "overlapping" })])).toEqual([]);
    expect(findings("unknown-defining-attribute", [spec({ attribute: "Missing" })])).toHaveLength(1);
  });

  it("exempts subclasses but keeps key findings for plain entities and supertypes", () => {
    const model = normalize(input([spec()]));
    model.entities[0]!.keys = [];
    expect(lint(model).filter((d) => d.rule === "entity-without-key").map((d) => d.path)).toEqual(["entities.A.keys", "entities.C.keys"]);
    expect(lint(model).some((d) => d.rule === "unsupported-eer")).toBe(false);
  });
});
