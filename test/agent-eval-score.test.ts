import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { normalizeName, scoreModels, type ScoreReport } from "../bench/agent-eval/score.js";
import { parseModel, type NModel } from "../src/core/normalize.js";
import { parseRequirements, serializeRequirements, textHash } from "../src/core/requirements.js";
import type { ModelInput } from "../src/core/schema.js";

function model(input: ModelInput | string): NModel {
  const parsed = parseModel(typeof input === "string" ? input : stringify(input));
  if (!parsed.model) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.model;
}
const fixture = (name: string): NModel => model(readFileSync(new URL(`../bench/agent-eval/scenarios/${name}/gold.er.yaml`, import.meta.url), "utf8"));
const basic: ModelInput = {
  version: 1,
  entities: { EMPLOYEE: { attrs: ["Id", "Name"], keys: [["Id"]] }, DEPARTMENT: { attrs: ["Id"], keys: [["Id"]] } },
  relationships: { WORKS_FOR: { ends: [{ entity: "EMPLOYEE", card: "1..1" }, { entity: "DEPARTMENT", card: "0..N" }] } },
};
const perfect = (report: ScoreReport): void => {
  expect(report.overall).toBe(1);
  for (const metric of [report.entities, report.relationships, report.attributes]) {
    expect([metric.precision, metric.recall, metric.f1]).toEqual([1, 1, 1]);
  }
  for (const metric of [report.keys, report.keys.strong, report.keys.weak, report.keys.identifying, report.cardinality, report.attributeProperties]) expect(metric.accuracy).toBe(1);
  expect(report.structure.lintErrorCount).toBe(0);
  expect(report.details.wrongCardinalities).toEqual([]);
  expect(report.details.wrongKeys).toEqual([]);
};

describe("requirements model scoring", () => {
  for (const name of ["library", "company", "university", "hospital", "airline", "turkish-labels"]) {
    it(`${name}: gold versus itself is perfect, including live trace coverage`, () => {
      const gold = fixture(name);
      const requirements = readFileSync(new URL(`../bench/agent-eval/scenarios/${name}/requirements.md`, import.meta.url), "utf8");
      const doc = parseRequirements(requirements);
      doc.items.forEach((item) => { item.applied = textHash(item.text); item.trace = [gold.entities[0]!.id]; });
      const report = scoreModels(gold, gold, {}, serializeRequirements(doc));
      perfect(report);
      expect(report.trace!.coverage).toBe(1);
    });
  }

  it("matches a renamed entity and key attribute through aliases", () => {
    const candidate = structuredClone(basic);
    candidate.entities.STAFF = { attrs: ["StaffId", "Name"], keys: [["StaffId"]] };
    delete candidate.entities.EMPLOYEE;
    candidate.relationships!.WORKS_FOR!.ends[0]!.entity = "STAFF";
    perfect(scoreModels(model(basic), model(candidate), { entities: { EMPLOYEE: ["STAFF", "WORKER"] }, attributes: { "EMPLOYEE.Id": ["StaffId"] } }));
  });

  it("ignores case, underscores and spaces while retaining accents", () => {
    expect(normalizeName("Flight_Leg")).toBe(normalizeName("flight leg"));
    expect(normalizeName("MÜŞTERİ")).toBe(normalizeName("Müşteri"));
    expect(normalizeName("ÜRÜN")).not.toBe(normalizeName("URUN"));
    const candidate = structuredClone(basic);
    candidate.entities.employee = candidate.entities.EMPLOYEE!;
    delete candidate.entities.EMPLOYEE;
    candidate.relationships!.WORKS_FOR!.ends[0]!.entity = "employee";
    perfect(scoreModels(model(basic), model(candidate)));
  });

  it("detects swapped cardinalities with both expected and actual values", () => {
    const candidate = structuredClone(basic);
    candidate.relationships!.WORKS_FOR!.ends[0]!.card = "0..N";
    candidate.relationships!.WORKS_FOR!.ends[1]!.card = "1..1";
    const report = scoreModels(model(basic), model(candidate));
    expect(report.cardinality).toMatchObject({ correct: 0, total: 2, accuracy: 0 });
    expect(report.details.wrongCardinalities).toEqual([
      { gold: "WORKS_FOR#0", candidate: "WORKS_FOR#0", expected: { min: 1, max: 1 }, actual: { min: 0, max: "N" } },
      { gold: "WORKS_FOR#1", candidate: "WORKS_FOR#1", expected: { min: 0, max: "N" }, actual: { min: 1, max: 1 } },
    ]);
    expect(report.relationships.f1).toBe(1);
    expect(report.overall).toBeLessThan(1);
  });

  it("reports a ternary split into renamed binaries as degree errors", () => {
    const gold = fixture("hospital");
    const candidate = model({ version: 1, entities: {
      PATIENT: { attrs: ["PatientId", "Name"], keys: [["PatientId"]] }, DOCTOR: { attrs: ["DoctorId", "Name", "Specialty"], keys: [["DoctorId"]] },
      WARD: { attrs: ["WardCode", "Name"], keys: [["WardCode"]] }, ADMISSION: { attrs: ["AdmissionId", "AdmissionDate", "DischargeDate"], keys: [["AdmissionId"]] },
    }, relationships: {
      ADMITTED: { ends: [{ entity: "PATIENT", card: "0..N" }, { entity: "ADMISSION", card: "1..1" }] },
      ALLOCATED: { ends: [{ entity: "WARD", card: "0..N" }, { entity: "ADMISSION", card: "1..1" }] },
      TREATS: { ends: [{ entity: "PATIENT", card: "0..N" }, { entity: "DOCTOR", card: "0..N" }] },
      LOCATED: { ends: [{ entity: "PATIENT", card: "0..N" }, { entity: "WARD", card: "0..N" }] },
      AUTHORIZED: { ends: [{ entity: "DOCTOR", card: "0..N" }, { entity: "WARD", card: "0..N" }] },
    } });
    const report = scoreModels(gold, candidate);
    expect(report.relationships.recall).toBeCloseTo(2 / 3);
    expect(report.details.unmatchedGold.relationships).toEqual(["R:CARE_ASSIGNMENT"]);
    expect(report.details.degreeErrors).toHaveLength(3);
    expect(report.details.degreeErrors.every((error) => error.goldDegree === 3 && error.candidateDegree === 2)).toBe(true);
    expect(report.overall).toBeLessThan(1);
  });

  it("an extra entity lowers entity precision but keeps recall and other metrics", () => {
    const candidate = structuredClone(basic);
    candidate.entities.EXTRA = { attrs: [], keys: [] };
    const report = scoreModels(model(basic), model(candidate));
    expect(report.entities.precision).toBeCloseTo(2 / 3);
    expect(report.entities.recall).toBe(1);
    expect(report.relationships.f1).toBe(1);
    expect(report.attributes.f1).toBe(1);
    expect(report.keys.accuracy).toBe(1);
    expect(report.details.extraCandidate.entities).toEqual(["E:EXTRA"]);
  });

  it("prefers relationship names or aliases over attribute overlap", () => {
    const gold = structuredClone(basic), candidate = structuredClone(basic);
    gold.relationships!.WORKS_FOR!.attrs = ["Since"];
    candidate.relationships!.EMPLOYED_BY = candidate.relationships!.WORKS_FOR!;
    delete candidate.relationships!.WORKS_FOR;
    candidate.relationships!.OTHER = { ends: structuredClone(basic.relationships!.WORKS_FOR!.ends), attrs: ["Since"] };
    const report = scoreModels(model(gold), model(candidate), { relationships: { WORKS_FOR: ["EMPLOYED_BY"] } });
    expect(report.matches.relationships).toEqual([{ gold: "R:WORKS_FOR", candidate: "R:EMPLOYED_BY" }]);
    expect(report.attributes.recall).toBeLessThan(1);
  });

  it("uses attribute overlap and then lexical ids when relationship names differ", () => {
    const gold = structuredClone(basic), candidate = structuredClone(basic);
    gold.relationships!.WORKS_FOR!.attrs = ["Since"];
    delete candidate.relationships!.WORKS_FOR;
    candidate.relationships!.A = { ends: structuredClone(basic.relationships!.WORKS_FOR!.ends) };
    candidate.relationships!.Z = { ends: structuredClone(basic.relationships!.WORKS_FOR!.ends), attrs: ["Since"] };
    expect(scoreModels(model(gold), model(candidate)).matches.relationships[0]!.candidate).toBe("R:Z");
    candidate.relationships!.A.attrs = ["Since"];
    expect(scoreModels(model(gold), model(candidate)).matches.relationships[0]!.candidate).toBe("R:A");
  });

  it("matches composite parts recursively inside their matched parents", () => {
    const gold = model({ version: 1, entities: { PERSON: { attrs: ["Id", { name: "Name", parts: ["First", { name: "Family", parts: ["Prefix", "Last"] }] }], keys: [["Id"]] } } });
    const candidate = model({ version: 1, entities: { PERSON: { attrs: ["Id", { name: "Name", parts: ["Given", { name: "Family", parts: ["Last", "Prefix"] }] }], keys: [["Id"]] } } });
    perfect(scoreModels(gold, candidate, { attributes: { "PERSON.Name.First": ["Given"] } }));
    const flat = model({ version: 1, entities: { PERSON: { attrs: ["Id", "First", "Family", "Prefix", "Last"], keys: [["Id"]] } } });
    expect(scoreModels(gold, flat).attributes.matched).toBe(1);
  });

  it("compares candidate key sets independent of key and component order", () => {
    const gold = model({ version: 1, entities: { PERSON: { attrs: ["Id", "A", "B"], keys: [["Id"], ["A", "B"]] } } });
    const candidate = model({ version: 1, entities: { PERSON: { attrs: ["Id", "A", "B"], keys: [["B", "A"], ["Id"]] } } });
    perfect(scoreModels(gold, candidate));
    candidate.entities[0]!.keys = [["Id"]];
    expect(scoreModels(gold, candidate).keys.strong.accuracy).toBe(0);
    candidate.entities[0]!.keys = [["Id"], ["A"], ["B"]];
    expect(scoreModels(gold, candidate).keys.strong.accuracy).toBe(0);
  });

  it("checks weak flags, partial keys and identifying targets", () => {
    const gold = fixture("library"), candidate = fixture("library");
    candidate.entities.find((entity) => entity.name === "COPY")!.partialKey = ["Condition"];
    delete candidate.relationships.find((rel) => rel.name === "HAS_COPY")!.identifies;
    const report = scoreModels(gold, candidate);
    expect(report.keys.weak.accuracy).toBe(0);
    expect(report.keys.identifying.accuracy).toBe(0.5);
    expect(report.details.wrongKeys.map((error) => error.kind)).toEqual(["weak", "identifying"]);
    candidate.entities.find((entity) => entity.name === "COPY")!.weak = false;
    expect(scoreModels(gold, candidate).keys.weak.accuracy).toBe(0);
  });

  it("aligns recursive ends by role when their order and explicit ids change", () => {
    const gold = fixture("company"), candidate = fixture("company");
    const rel = candidate.relationships.find((item) => item.name === "SUPERVISION")!;
    rel.ends.reverse();
    rel.ends.forEach((end, index) => { end.index = index; end.id = `${rel.name}#renamed_${index}`; });
    perfect(scoreModels(gold, candidate));
    rel.ends.forEach((end) => { end.min = 0; end.max = end.max === "N" ? 1 : "N"; });
    expect(scoreModels(gold, candidate).details.wrongCardinalities).toHaveLength(2);
  });

  it("records derived and multivalued mistakes separately from name F1", () => {
    const gold = fixture("airline"), candidate = fixture("airline");
    candidate.entities.find((entity) => entity.name === "FLIGHT")!.attrs.find((attr) => attr.name === "LegCount")!.derived = false;
    const report = scoreModels(gold, candidate);
    expect(report.attributes.f1).toBe(1);
    expect(report.attributeProperties.accuracy).toBeLessThan(1);
    expect(report.details.wrongAttributeProperties[0]!.expected.derived).toBe(true);
  });

  it("counts lint errors and requires at least one live element for trace coverage", () => {
    const candidate = model(basic);
    candidate.relationships[0]!.ends[0]!.entity = "MISSING";
    const report = scoreModels(model(basic), candidate, {}, { items: [
      { id: "r1", text: "one", trace: ["E:EMPLOYEE", "E:GONE"] }, { id: "r2", text: "two", trace: ["E:GONE"] }, { id: "r3", text: "three", trace: [] },
    ] });
    expect(report.structure.lintErrorCount).toBe(1);
    expect(report.trace).toEqual({ covered: 1, total: 3, coverage: 1 / 3, uncovered: ["r2", "r3"] });
    expect(scoreModels(model(basic), model(basic)).trace).toBeNull();
  });

  it("penalizes missing keys and ends instead of awarding an empty candidate accuracy", () => {
    const report = scoreModels(model(basic), model({ version: 1, entities: {} }));
    expect(report.overall).toBe(0);
    expect(report.cardinality).toMatchObject({ correct: 0, total: 2, evaluated: 0 });
    perfect(scoreModels(model({ version: 1, entities: {} }), model({ version: 1, entities: {} })));
  });

  it("greedily matches each candidate only once", () => {
    const gold = model({ version: 1, entities: { A: { attrs: ["Id"], keys: [["Id"]] }, B: { attrs: ["Id"], keys: [["Id"]] } } });
    const candidate = model({ version: 1, entities: { C: { attrs: ["Id"], keys: [["Id"]] } } });
    const report = scoreModels(gold, candidate, { entities: { A: ["C"], B: ["C"] } });
    expect(report.entities.matched).toBe(1);
    expect(report.matches.entities).toEqual([{ gold: "E:A", candidate: "E:C" }]);
  });

  it("is deterministic across repeated calls and owner ordering without mutating inputs", () => {
    const gold = fixture("company"), candidate = fixture("company");
    const before = JSON.stringify(candidate);
    const first = scoreModels(gold, candidate);
    expect(scoreModels(gold, candidate)).toEqual(first);
    expect(JSON.stringify(candidate)).toBe(before);
    candidate.entities.reverse(); candidate.relationships.reverse();
    candidate.entities.forEach((entity) => entity.attrs.reverse());
    expect(scoreModels(gold, candidate)).toEqual(first);
    expect(first.overall).toBe((first.entities.f1 + first.relationships.f1 + first.attributes.f1 + first.keys.accuracy + first.cardinality.accuracy) / 5);
  });
});
