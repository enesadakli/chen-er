import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { lint, RULES, LINT_DISCLAIMER } from "../src/core/lint/index.js";
import { normalize, parseModel, type NModel } from "../src/core/normalize.js";
import type { EntityInput, ModelInput, RelationshipInput } from "../src/core/schema.js";

const strong: EntityInput = { attrs: ["Id"], keys: [["Id"]] };
const weak: EntityInput = { weak: true, attrs: ["No"], partialKey: ["No"] };
const entities = { A: strong, B: strong, C: strong };
const end = (entity: string, card = "0..N", role?: string): RelationshipInput["ends"][number] => ({ entity, card, role });
const binary = (a = "A", b = "B", cardA = "0..N", cardB = "0..N"): RelationshipInput => ({
  ends: [end(a, cardA), end(b, cardB)],
});
const identifying: RelationshipInput = { ...binary("A", "B", "0..N", "1..1"), identifies: "B" };

function model(input: Partial<ModelInput> = {}): NModel {
  const result = parseModel(stringify({ version: 1, entities, ...input }));
  expect(result.diagnostics).toEqual([]);
  expect(result.model).toBeDefined();
  return result.model!;
}

interface RuleCase {
  id: string;
  failing: Partial<ModelInput>;
  passing: Partial<ModelInput>;
}

const cases: RuleCase[] = [
  {
    id: "unknown-entity",
    failing: { relationships: { LINKS: binary("A", "Missing") } },
    passing: { relationships: { LINKS: binary() } },
  },
  {
    id: "unknown-key-attribute",
    failing: { entities: { A: { attrs: ["Id"], keys: [["Missing"]], partialKey: ["Other"] } } },
    passing: { entities: { A: { attrs: ["Id"], keys: [["Id"]], partialKey: ["Id"] } } },
  },
  {
    id: "duplicate-attribute",
    failing: { entities: { A: { attrs: ["Name", "Name"] } } },
    passing: { entities: { A: { attrs: ["Name", { name: "Address", parts: ["Name", "City"] }] } } },
  },
  {
    id: "invalid-cardinality",
    failing: { relationships: { LINKS: binary("A", "B", "2..1", "0..0") } },
    passing: { relationships: { LINKS: binary("A", "B", "2..2", "5..N") } },
  },
  {
    id: "duplicate-end-id",
    failing: { relationships: { LINKS: { ends: [{ ...end("A"), id: "same" }, { ...end("B"), id: "same" }] } } },
    passing: { relationships: { LINKS: { ends: [{ ...end("A"), id: "left" }, { ...end("B"), id: "right" }] } } },
  },
  {
    id: "recursive-missing-role",
    failing: { relationships: { SUPERVISES: { ends: [end("A", "0..N", "supervisor"), end("A")] } } },
    passing: { relationships: { SUPERVISES: { ends: [end("A", "0..N", "supervisor"), end("A", "0..1", "report")] } } },
  },
  {
    id: "identifies-not-an-end",
    failing: { entities: { ...entities, C: weak }, relationships: { OWNS: { ...binary(), identifies: "C" } } },
    passing: { entities: { A: strong, B: weak }, relationships: { OWNS: identifying } },
  },
  {
    id: "identifies-not-weak",
    failing: { relationships: { OWNS: identifying } },
    passing: { entities: { A: strong, B: weak }, relationships: { OWNS: identifying } },
  },
  {
    id: "weak-without-identifying",
    failing: { entities: { A: strong, B: weak } },
    passing: { entities: { A: strong, B: weak }, relationships: { OWNS: identifying } },
  },
  {
    id: "weak-end-not-total",
    failing: { entities: { A: strong, B: weak }, relationships: { OWNS: { ...identifying, ends: [end("A"), end("B", "1..N")] } } },
    passing: { entities: { A: strong, B: weak }, relationships: { OWNS: identifying } },
  },
  {
    id: "identification-cycle",
    failing: { entities: { A: weak, B: weak }, relationships: {
      OWNS_A: { ...binary("B", "A", "0..N", "1..1"), identifies: "A" }, OWNS_B: identifying,
    } },
    passing: { entities: { A: strong, B: weak, C: weak }, relationships: {
      OWNS_B: identifying, OWNS_C: { ...binary("B", "C", "0..N", "1..1"), identifies: "C" },
    } },
  },
  {
    id: "unsupported-eer",
    failing: { specializations: [{ supertype: "A", subtypes: ["B"], disjointness: "disjoint", completeness: "total" }] },
    passing: { specializations: [] },
  },
  {
    id: "weak-without-partial-key",
    failing: { entities: { B: { weak: true, attrs: ["No"] } } },
    passing: { entities: { B: weak } },
  },
  {
    id: "entity-without-key",
    failing: { entities: { A: { attrs: ["Id"] } } },
    passing: { entities: { A: strong, B: weak } },
  },
  {
    id: "generic-relationship-name",
    failing: { relationships: { bElOnGs_To: binary() } },
    passing: { relationships: { EMPLOYMENT: binary() } },
  },
  {
    id: "parallel-relationships",
    failing: { relationships: { FIRST: binary(), SECOND: binary("B", "A") } },
    passing: { relationships: { FIRST: binary(), SECOND: binary("A", "C") } },
  },
  {
    id: "redundant-functional-path",
    failing: { relationships: {
      DIRECT: binary("A", "C", "0..1"), FIRST: binary("A", "B", "1..1"), SECOND: binary("B", "C", "1..1"),
    } },
    passing: { relationships: {
      DIRECT: binary("A", "C", "0..1"), FIRST: binary("A", "B", "1..N"), SECOND: binary("B", "C", "1..1"),
    } },
  },
  {
    id: "attribute-names-entity",
    failing: { entities: { A: { attrs: ["bCODE"] }, B: strong } },
    passing: { entities: { A: { attrs: ["ACode", "BCount"] }, B: strong } },
  },
  {
    id: "movable-relationship-attribute",
    failing: { relationships: { JOINS: { ...binary("A", "B", "0..1"), attrs: ["Since"] } } },
    passing: { relationships: { JOINS: { ...binary(), attrs: ["Since"] } } },
  },
];

describe("lint rules", () => {
  it("registers every rule once, with severity and description but no exposed check function", () => {
    expect(RULES.map((rule) => rule.id).sort()).toEqual(cases.map((entry) => entry.id).sort());
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(19);
    for (const rule of RULES) {
      expect(Object.keys(rule).sort()).toEqual(["description", "id", "severity"]);
      expect(rule.description.length).toBeGreaterThan(10);
    }
    expect(LINT_DISCLAIMER).toContain("0 errors does not mean the model is right");
  });

  describe.each(cases)("$id", ({ id, failing, passing }) => {
    it("reports a failing model with actionable, located diagnostics", () => {
      const findings = lint(model(failing)).filter((diagnostic) => diagnostic.rule === id);
      expect(findings.length).toBeGreaterThan(0);
      for (const diagnostic of findings) {
        expect(diagnostic.severity).toBe(RULES.find((rule) => rule.id === id)?.severity);
        expect(diagnostic.message.length).toBeGreaterThan(15);
        expect(diagnostic.hint?.length).toBeGreaterThan(15);
        expect(diagnostic.path).toBeTruthy();
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.column).toBeGreaterThan(0);
      }
    });
    it("accepts a passing model", () => {
      expect(lint(model(passing)).filter((diagnostic) => diagnostic.rule === id)).toEqual([]);
    });
  });
});

describe("structural edge cases", () => {
  it("checks identifies, supertypes, subtypes and ends independently", () => {
    const findings = lint(model({ relationships: { LINKS: { ...binary("A", "MissingEnd"), identifies: "MissingWeak" } },
      specializations: [{ supertype: "MissingSuper", subtypes: ["B", "MissingSub"], disjointness: "overlapping", completeness: "partial" }],
    })).filter((diagnostic) => diagnostic.rule === "unknown-entity");
    expect(findings.map((diagnostic) => diagnostic.path)).toEqual([
      "relationships.LINKS.ends.1.entity", "relationships.LINKS.identifies",
      "specializations.0.supertype", "specializations.0.subtypes.1",
    ]);
  });

  it("rejects a composite part as a key while accepting the top-level composite", () => {
    const findings = lint(model({ entities: { A: { attrs: [{ name: "FullName", parts: ["First", "Last"] }],
      keys: [["FullName"], ["First"]], partialKey: ["Last"] } } }))
      .filter((diagnostic) => diagnostic.rule === "unknown-key-attribute");
    expect(findings.map((diagnostic) => diagnostic.path)).toEqual(["entities.A.keys.1.0", "entities.A.partialKey.0"]);
  });

  it("checks duplicate siblings in relationship attributes and nested composite parts", () => {
    const findings = lint(model({ relationships: { LINKS: { ...binary(), attrs: ["Since", "Since",
      { name: "Place", parts: ["City", "City", { name: "Address", parts: ["Street", "Street"] }] }] } } }))
      .filter((diagnostic) => diagnostic.rule === "duplicate-attribute");
    expect(findings.map((diagnostic) => diagnostic.path)).toEqual([
      "relationships.LINKS.attrs.1", "relationships.LINKS.attrs.2.parts.1", "relationships.LINKS.attrs.2.parts.2.parts.1",
    ]);
  });

  it("allows repeated attribute names under different parents and owners", () => {
    expect(lint(model({ entities: { A: { attrs: [
      { name: "Home", parts: ["City", "Street"] }, { name: "Work", parts: ["City", "Street"] },
    ] }, B: { attrs: ["City"] } }, relationships: { LINKS: { ...binary(), attrs: ["City"] } } }))
      .filter((diagnostic) => diagnostic.rule === "duplicate-attribute")).toEqual([]);
  });

  it("allows generated end ids and explicit ids reused in different relationships", () => {
    expect(lint(model({ relationships: { FIRST: binary(), SECOND: {
      ends: [{ ...end("A"), id: "left" }, { ...end("B"), id: "right" }],
    }, THIRD: { ends: [{ ...end("A"), id: "left" }, { ...end("C"), id: "right" }] } } }))
      .filter((diagnostic) => diagnostic.rule === "duplicate-end-id")).toEqual([]);
  });

  it("reports every missing recursive role, including blank roles in an n-ary relationship", () => {
    const findings = lint(model({ relationships: { LINKS: {
      ends: [end("A", "0..N", " "), end("B"), end("A"), end("A", "0..N", "owner")],
    } } })).filter((diagnostic) => diagnostic.rule === "recursive-missing-role");
    expect(findings.map((diagnostic) => diagnostic.path)).toEqual(["relationships.LINKS.ends.0.role", "relationships.LINKS.ends.2.role"]);
  });

  it("retains diagnostics without source locations", () => {
    const findings = lint(normalize({ version: 1, entities: { A: { attrs: ["Name", "Name"] } } }));
    expect(findings.every((diagnostic) => diagnostic.path && diagnostic.hint && diagnostic.line === undefined && diagnostic.column === undefined)).toBe(true);
  });
});

describe("weak entity edge cases", () => {
  it.each(["0..1", "0..N", "1..N", "1..2", "2..2"])("reports actual invalid binary weak end %s", (card) => {
    const findings = lint(model({ entities: { A: strong, B: weak }, relationships: {
      OWNS: { ...identifying, ends: [end("A"), end("B", card)] },
    } })).filter((diagnostic) => diagnostic.rule === "weak-end-not-total");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(card);
    expect(findings[0]?.path).toBe("relationships.OWNS.ends.1.card");
    expect(findings[0]?.hint).toContain("1..1");
  });

  it.each(["1..N", "2..3"])("allows total n-ary weak participation %s", (card) => {
    expect(lint(model({ entities: { ...entities, B: weak }, relationships: { OWNS: {
      identifies: "B", ends: [end("A"), end("B", card), end("C")],
    } } })).filter((diagnostic) => diagnostic.rule === "weak-end-not-total")).toEqual([]);
  });

  it("rejects optional n-ary weak participation", () => {
    expect(lint(model({ entities: { ...entities, B: weak }, relationships: { OWNS: {
      identifies: "B", ends: [end("A"), end("B", "0..N"), end("C")],
    } } })).filter((diagnostic) => diagnostic.rule === "weak-end-not-total")).toHaveLength(1);
  });

  it("leaves unknown identifies references to unknown-entity", () => {
    const findings = lint(model({ relationships: { OWNS: { ...binary(), identifies: "Missing" } } }));
    expect(findings.some((diagnostic) => diagnostic.rule === "unknown-entity")).toBe(true);
    expect(findings.some((diagnostic) => diagnostic.rule === "identifies-not-weak")).toBe(false);
  });

  it("reports one finding per independent identification cycle, including self ownership", () => {
    const findings = lint(model({ entities: { A: weak, B: weak, C: weak, D: weak }, relationships: {
      OWNS_A: { ...binary("B", "A"), identifies: "A" }, OWNS_B: identifying,
      SELF: { identifies: "C", ends: [end("C", "1..1", "child"), end("C", "1..1", "owner")] },
      OUTSIDE: { ...binary("A", "D"), identifies: "D" },
    } })).filter((diagnostic) => diagnostic.rule === "identification-cycle");
    expect(findings).toHaveLength(2);
    expect(findings[0]?.message).toContain("A, B");
    expect(findings[0]?.message).not.toContain("OUTSIDE");
    expect(findings[1]?.message).toContain("C");
  });

  it("detects long cycles involving multiple owners", () => {
    const findings = lint(model({ entities: { A: weak, B: weak, C: weak, D: strong }, relationships: {
      OWNS_A: { identifies: "A", ends: [end("D"), end("B"), end("A", "1..1")] },
      OWNS_B: { ...binary("C", "B"), identifies: "B" },
      OWNS_C: { ...binary("A", "C"), identifies: "C" },
    } })).filter((diagnostic) => diagnostic.rule === "identification-cycle");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("A, B, C");
  });
});

describe("course and heuristic details", () => {
  it.each(["HAS", "have", "HAVING", "IS", "ARE", "RELATES", "Related-To", "BELONGS", "belongs_to"])
    ("flags generic name %s", (name) => {
      expect(lint(model({ relationships: { [name]: binary() } })).filter((diagnostic) => diagnostic.rule === "generic-relationship-name")).toHaveLength(1);
    });

  it("uses entity sets for parallel relationships regardless of arity or repeated ends", () => {
    const findings = lint(model({ relationships: { FIRST: binary(), SECOND: {
      ends: [end("B"), end("A", "0..N", "left"), end("A", "0..N", "right")],
    }, THIRD: binary("B", "A") } })).filter((diagnostic) => diagnostic.rule === "parallel-relationships");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("FIRST, SECOND, THIRD");
    expect(findings[0]?.hint).toContain("note or merge");
  });

  it.each(["b", "bId", "BNO", "bCode", "BName"])("detects hidden relationship attribute %s", (name) => {
    const findings = lint(model({ entities: { A: { attrs: [name] }, B: strong } }))
      .filter((diagnostic) => diagnostic.rule === "attribute-names-entity");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(`A.${name}`);
  });

  it("checks entity composite parts but does not flag relationship attributes", () => {
    const findings = lint(model({ entities: { A: { attrs: [{ name: "Details", parts: ["BId", "Other"] }] }, B: strong },
      relationships: { LINKS: { ...binary(), attrs: ["BId"] } },
    })).filter((diagnostic) => diagnostic.rule === "attribute-names-entity");
    expect(findings.map((diagnostic) => diagnostic.path)).toEqual(["entities.A.attrs.0.parts.0"]);
  });
});

describe("movable relationship attributes", () => {
  it("suggests the N side using that entity's own max=1 end", () => {
    const findings = lint(model({ relationships: { WORKS_FOR: { ...binary("A", "B", "1..1", "1..N"), attrs: ["Since"] } } }))
      .filter((diagnostic) => diagnostic.rule === "movable-relationship-attribute");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("move to A,");
    expect(findings[0]?.message).not.toContain("move to B");
  });

  it("suggests either side for 1:1", () => {
    const findings = lint(model({ relationships: { PAIRS: { ...binary("A", "B", "1..1", "0..1"), attrs: ["Since"] } } }))
      .filter((diagnostic) => diagnostic.rule === "movable-relationship-attribute");
    expect(findings[0]?.message).toContain("A or B");
  });

  it("does not suggest a move for n-ary relationships or relationships without attributes", () => {
    expect(lint(model({ relationships: { LINKS: { ends: [end("A", "1..1"), end("B"), end("C")], attrs: ["Since"] },
      EMPTY: binary("A", "B", "1..1") } }))
      .filter((diagnostic) => diagnostic.rule === "movable-relationship-attribute")).toEqual([]);
  });
});

describe("lint filtering and ordering", () => {
  const input: Partial<ModelInput> = { entities: { A: { attrs: ["BId", "BId"] }, B: strong },
    relationships: { HAS: { ...binary("A", "B", "1..1"), attrs: ["Since"] } } };

  it("filters rule ids and severities together", () => {
    const findings = lint(model(input), { disable: ["duplicate-attribute", "unknown-rule"], disableSeverities: ["course", "info"] });
    expect(findings.map((diagnostic) => diagnostic.rule)).toEqual(["attribute-names-entity", "attribute-names-entity"]);
    expect(lint(model(input), { disableSeverities: ["error", "course", "heuristic", "info"] })).toEqual([]);
  });

  it("sorts by severity, then line, then rule", () => {
    const parsed = model(input);
    const findings = lint(parsed);
    const ranks = { error: 0, course: 1, heuristic: 2, info: 3 };
    expect(findings.map((diagnostic) => ranks[diagnostic.severity])).toEqual([0, 1, 1, 2, 2, 3]);
    expect(findings.filter((diagnostic) => diagnostic.severity === "course").map((diagnostic) => diagnostic.rule))
      .toEqual(["entity-without-key", "generic-relationship-name"]);
    const sameLine = lint({ ...parsed, locate: () => ({ line: 1, column: 1 }) });
    expect(sameLine.filter((diagnostic) => diagnostic.severity === "course").map((diagnostic) => diagnostic.rule))
      .toEqual(["entity-without-key", "generic-relationship-name"]);
    expect(lint(parsed)).toEqual(findings);
  });

  it("uses rule ids to order missing positions deterministically", () => {
    const findings = lint(normalize({ version: 1, ...input, entities: input.entities! }));
    expect(findings.filter((diagnostic) => diagnostic.severity === "course").map((diagnostic) => diagnostic.rule))
      .toEqual(["entity-without-key", "generic-relationship-name"]);
  });

  it("does not mutate normalized models or options", () => {
    const parsed = model(input);
    const snapshot = JSON.stringify(parsed);
    const options = { disable: ["generic-relationship-name"], disableSeverities: ["info" as const] };
    lint(parsed, options);
    expect(JSON.stringify(parsed)).toBe(snapshot);
    expect(options).toEqual({ disable: ["generic-relationship-name"], disableSeverities: ["info"] });
  });
});

describe("existing example and benchmark fixtures", () => {
  it.each(["dense-attrs", "pinned", "recursive", "ternary", "turkish-labels"])("keeps bench fixture %s error-free", (name) => {
    const result = parseModel(readFileSync(new URL(`../bench/fixtures/${name}.er.yaml`, import.meta.url), "utf8"));
    expect(result.diagnostics).toEqual([]);
    const findings = lint(result.model!);
    expect(findings.filter((diagnostic) => diagnostic.severity !== "info")).toEqual([]);
    expect(findings.filter((diagnostic) => diagnostic.severity === "info")).toHaveLength(name === "recursive" ? 1 : 0);
  });

  it("keeps the library example free of all lint findings", () => {
    const result = parseModel(readFileSync(new URL("../examples/library.er.yaml", import.meta.url), "utf8"));
    expect(result.diagnostics).toEqual([]);
    expect(lint(result.model!)).toEqual([]);
  });
});
