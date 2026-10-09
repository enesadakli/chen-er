import { readFileSync } from "node:fs";
import { expect, it, describe } from "vitest";
import { stringify } from "yaml";
import { lint } from "../src/core/lint/index.js";
import { normalize, parseModel } from "../src/core/normalize.js";
import type { RelationshipInput } from "../src/core/schema.js";

function binary(from: string, to: string, card = "1..1", reverseCard = "0..N"): RelationshipInput {
  return { ends: [{ entity: from, card }, { entity: to, card: reverseCard }] };
}

function check(relationships: Record<string, RelationshipInput>) {
  const result = parseModel(stringify({ version: 1, entities: {
    A: { attrs: ["Id"], keys: [["Id"]] }, B: { attrs: ["Id"], keys: [["Id"]] },
    C: { attrs: ["Id"], keys: [["Id"]] }, D: { attrs: ["Id"], keys: [["Id"]] },
  }, relationships }));
  expect(result.diagnostics).toEqual([]);
  return lint(result.model!).filter((diagnostic) => diagnostic.rule === "redundant-functional-path");
}

describe("redundant functional paths", () => {
  it("reproduces STUDENT HAS DEPT alongside FOLLOWS / DEFINES with a participation contradiction", () => {
    const text = readFileSync(new URL("./fixtures/lint/student-dept.er.yaml", import.meta.url), "utf8");
    const result = parseModel(text);
    expect(result.diagnostics).toEqual([]);
    const findings = lint(result.model!);
    expect(findings.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const paths = findings.filter((diagnostic) => diagnostic.rule === "redundant-functional-path");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ rule: "redundant-functional-path", severity: "heuristic",
      path: "relationships.HAS.ends.0.card", line: 16, column: 33 });
    expect(paths[0]?.message).toContain("STUDENT → FOLLOWS → CURRICULUM → DEFINES → DEPT");
    expect(paths[0]?.message).toContain("STUDENT's DEPT");
    expect(paths[0]?.message).toContain("min = 0");
    expect(paths[0]?.message).toContain("min ≥ 1");
    expect(paths[0]?.hint).toContain("reconcile");
  });

  it("also reports duplicate mandatory facts without claiming an optional participation contradiction", () => {
    const findings = check({ DIRECT: binary("A", "C"), FIRST: binary("A", "B"), SECOND: binary("B", "C") });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).not.toContain("permits absence");
    expect(findings[0]?.hint).not.toContain("reconcile");
  });

  it("reports optional paths without claiming mandatory participation", () => {
    const findings = check({ DIRECT: binary("A", "C", "0..1"), FIRST: binary("A", "B", "0..1"), SECOND: binary("B", "C") });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).not.toContain("path requires");
  });

  it("prefers a mandatory route even when an optional route sorts first", () => {
    const findings = check({ DIRECT: binary("A", "D", "0..1"),
      A_OPTIONAL: binary("A", "B", "0..1"), B_FINISH: binary("B", "D"),
      C_MANDATORY: binary("A", "C"), D_FINISH: binary("C", "D"),
    });
    const direct = findings.find((diagnostic) => diagnostic.path === "relationships.DIRECT.ends.0.card");
    expect(direct?.message).toContain("C_MANDATORY");
    expect(direct?.message).toContain("path requires");
  });

  it("detects paths longer than two hops", () => {
    const findings = check({ DIRECT: binary("A", "D"), FIRST: binary("A", "B"),
      SECOND: binary("B", "C"), THIRD: binary("C", "D") });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("A → FIRST → B → SECOND → C → THIRD → D");
  });

  it("takes a parallel first hop when it leads to a longer alternate path", () => {
    const findings = check({ DIRECT: binary("A", "C"), A_FIRST: binary("A", "B", "0..1"),
      B_FIRST: binary("A", "B"), FINISH: binary("B", "C") });
    expect(findings.filter((diagnostic) => diagnostic.path === "relationships.DIRECT.ends.0.card")).toHaveLength(1);
    expect(findings[0]?.message).toContain("B_FIRST");
  });

  it("does not count a different direct edge as a path of length two", () => {
    expect(check({ FIRST: binary("A", "B"), SECOND: binary("A", "B") })).toEqual([]);
  });

  it("requires a direct to-one hop", () => {
    expect(check({ DIRECT: binary("A", "C", "1..N"), FIRST: binary("A", "B"), SECOND: binary("B", "C") })).toEqual([]);
  });

  it("uses source-end max rather than target-end max for direction", () => {
    const reversed = check({ DIRECT: binary("A", "C"), FIRST: binary("A", "B", "0..N", "1..1"), SECOND: binary("B", "C") });
    expect(reversed.map((diagnostic) => diagnostic.path)).toEqual(["relationships.SECOND.ends.0.card"]);
    const findings = check({ DIRECT: binary("A", "C"), FIRST: binary("B", "A", "0..N", "1..1"), SECOND: binary("C", "B", "0..N", "1..1") });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("relationships.DIRECT.ends.0.card");
  });

  it("finds both directed redundant facts for 1:1 relationships", () => {
    const findings = check({ DIRECT: binary("A", "C", "1..1", "1..1"),
      FIRST: binary("A", "B", "1..1", "1..1"), SECOND: binary("B", "C", "1..1", "1..1") });
    expect(findings).toHaveLength(6);
    expect(findings.filter((diagnostic) => diagnostic.path?.startsWith("relationships.DIRECT"))).toHaveLength(2);
  });

  it("never treats ternary relationships as direct hops or intermediate hops", () => {
    const ternary: RelationshipInput = { ends: [...binary("A", "C").ends, { entity: "D", card: "1..1" }] };
    expect(check({ DIRECT: ternary, FIRST: binary("A", "B"), SECOND: binary("B", "C") })).toEqual([]);
    expect(check({ DIRECT: binary("A", "C"), FIRST: { ends: [...binary("A", "B").ends, { entity: "D", card: "1..1" }] },
      SECOND: binary("B", "C") })).toEqual([]);
  });

  it("does not inflate an alternate path with cycles or reuse the direct relationship", () => {
    expect(check({ DIRECT: binary("A", "C", "1..1", "1..1"), OUT: binary("A", "B"), BACK: binary("B", "A") })).toEqual([]);
    expect(check({ DIRECT: binary("A", "C"), PARALLEL: binary("A", "C"),
      OUT: binary("C", "B"), BACK: binary("B", "C") })).toEqual([]);
  });

  it("does not mistake recursive roles for different entities", () => {
    expect(check({ DIRECT: binary("A", "B"), SELF: { ends: [
      { entity: "A", card: "1..1", role: "child" }, { entity: "A", card: "1..1", role: "parent" },
    ] } })).toEqual([]);
  });

  it("skips unknown entities and invalid cardinalities when constructing paths", () => {
    expect(check({ DIRECT: binary("A", "C"), FIRST: binary("A", "Missing"), SECOND: binary("Missing", "C") })).toEqual([]);
    expect(check({ DIRECT: binary("A", "C"), FIRST: binary("A", "B", "2..1"), SECOND: binary("B", "C") })).toEqual([]);
  });

  it("chooses the same route when input relationships are reordered", () => {
    const relationships = { DIRECT: binary("A", "D", "0..1"), FIRST: binary("A", "B"), SECOND: binary("B", "D"),
      OTHER: binary("A", "C"), LAST: binary("C", "D") };
    const forward = normalize({ version: 1, entities: { A: {}, B: {}, C: {}, D: {} }, relationships });
    const reverse = normalize({ version: 1, entities: { A: {}, B: {}, C: {}, D: {} },
      relationships: Object.fromEntries(Object.entries(relationships).reverse()) });
    const findings = (input: typeof forward) => lint(input).filter((diagnostic) => diagnostic.rule === "redundant-functional-path");
    expect(findings(forward)).toEqual(findings(reverse));
  });

  it("handles a dense graph without enumerating all possible alternate paths", () => {
    const names = Array.from({ length: 24 }, (_, index) => `E${index}`);
    const relationships: Record<string, RelationshipInput> = {};
    names.forEach((from, i) => names.slice(i + 1).forEach((to, j) => {
      relationships[`R${i}_${j}`] = binary(from, to);
    }));
    const input = normalize({ version: 1, entities: Object.fromEntries(names.map((name) => [name, {}])), relationships });
    const findings = lint(input, { disableSeverities: ["course", "info"] });
    expect(findings).toHaveLength(253);
    expect(findings.every((diagnostic) => diagnostic.rule === "redundant-functional-path")).toBe(true);
  });
});
