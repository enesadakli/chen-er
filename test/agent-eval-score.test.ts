import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { normalizeName, scoreModels, scoreVariants, type DecisionCheck, type ScoreReport } from "../bench/agent-eval/score.js";
import { loadScenario } from "../bench/agent-eval/scenarios.js";
import { summary, type SummaryRecord } from "../bench/agent-eval/summary.js";
import { fileURLToPath } from "node:url";
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

  it("folds accents and Turkish I and ignores case, underscores, hyphens and spaces", () => {
    expect(normalizeName("Flight_Leg")).toBe(normalizeName("flight leg"));
    expect(normalizeName("Flight-Leg")).toBe(normalizeName("flight leg"));
    expect(normalizeName("MÜŞTERİ")).toBe(normalizeName("Müşteri"));
    expect(normalizeName("ÜRÜN")).toBe(normalizeName("URUN"));
    expect(["I", "İ", "ı", "i"].map(normalizeName)).toEqual(["i", "i", "i", "i"]);
    expect(normalizeName("DemirbaşNo".normalize("NFD"))).toBe("demirbasno");
    expect(normalizeName("Address")).not.toBe(normalizeName("AdmissionDate"));
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
    expect(report.matches.entities).toEqual([{ gold: "E:A", candidate: "E:C", matchedBy: "alias" }]);
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


const natural = (name: string) => loadScenario(fileURLToPath(new URL("../bench/agent-eval/scenarios/", import.meta.url)), name);
const findEntity = (m: NModel, name: string) => m.entities.find((e) => e.name === name)!;
const findRel = (m: NModel, name: string) => m.relationships.find((r) => r.name === name)!;
const findAttr = (m: NModel, owner: string, name: string) => findEntity(m, owner).attrs.find((a) => a.name === name)!;
const decision = (kind: DecisionCheck["kind"], fields: object): DecisionCheck => ({ id: "decision", why: "Required modeling choice.", kind, ...fields }) as DecisionCheck;

describe("decision checks", () => {
  const mutations: { kind: DecisionCheck["kind"]; scenario: string; fields: object; mutate: (m: NModel) => void }[] = [
    { kind: "weak", scenario: "n-vet-clinic", fields: { entity: "PET", owner: "OWNER" }, mutate: (m) => { findEntity(m, "PET").weak = false; } },
    { kind: "ternary", scenario: "n-supply", fields: { relationship: "DELIVERS" }, mutate: (m) => {
      const rel = findRel(m, "DELIVERS");
      m.relationships = m.relationships.filter((r) => r !== rel);
      m.relationships.push({ ...rel, id: "R:PAIR_A", name: "PAIR_A", ends: rel.ends.slice(0, 2) },
        { ...rel, id: "R:PAIR_B", name: "PAIR_B", ends: rel.ends.slice(1) });
    } },
    { kind: "recursive", scenario: "n-vet-clinic", fields: { relationship: "MENTORS" }, mutate: (m) => { findRel(m, "MENTORS").ends[1]!.entity = "OWNER"; } },
    { kind: "multivalued", scenario: "n-vet-clinic", fields: { attribute: "OWNER.Phones" }, mutate: (m) => { findAttr(m, "OWNER", "Phones").multivalued = false; } },
    { kind: "derived", scenario: "n-vet-clinic", fields: { attribute: "PET.Age" }, mutate: (m) => { findAttr(m, "PET", "Age").derived = false; } },
    { kind: "composite", scenario: "n-vet-clinic", fields: { attribute: "OWNER.Name" }, mutate: (m) => { findAttr(m, "OWNER", "Name").parts = []; } },
    { kind: "relationshipAttribute", scenario: "n-supply", fields: { relationship: "DELIVERS", attribute: "Quantity" }, mutate: (m) => {
      const attr = findRel(m, "DELIVERS").attrs.pop()!;
      findEntity(m, "SUPPLIER").attrs.push({ ...attr, owner: "SUPPLIER", ownerKind: "entity", id: "A:SUPPLIER.Quantity" });
    } },
    { kind: "entity", scenario: "n-car-rental", fields: { entity: "RENTAL" }, mutate: (m) => {
      m.entities = m.entities.filter((e) => e.name !== "RENTAL");
      const attribute = findAttr(m, "CAR", "Model");
      findEntity(m, "CAR").attrs.push({ ...attribute, name: "RENTAL", id: "A:CAR.RENTAL" });
    } },
    { kind: "cardinality", scenario: "n-vet-clinic", fields: { relationship: "MENTORS", entity: "VET", role: "junior", card: "0..1" }, mutate: (m) => { findRel(m, "MENTORS").ends[1]!.max = "N"; } },
    { kind: "key", scenario: "n-car-rental", fields: { entity: "RENTAL", attrs: ["RentalNo"] }, mutate: (m) => { findEntity(m, "RENTAL").keys = [["PickupDate", "ReturnDate"]]; } },
  ];
  for (const test of mutations) it(`${test.kind}: passes on gold and fails its targeted mutation`, () => {
    const gold = natural(test.scenario).variants[0]!.model, candidate = natural(test.scenario).variants[0]!.model;
    const check = decision(test.kind, test.fields), checks = { checks: [check] };
    expect(scoreModels(gold, gold, {}, undefined, checks).decisions).toEqual({ correct: 1, total: 1, accuracy: 1, failed: [] });
    test.mutate(candidate);
    const report = scoreModels(gold, candidate, {}, undefined, checks);
    expect(report.decisions).toMatchObject({ correct: 0, total: 1, accuracy: 0, failed: [{ id: check.id, kind: check.kind, why: check.why, reason: expect.any(String) }] });
  });

  it("fails weak checks for missing partial keys, identification, or matched owners", () => {
    const gold = natural("n-vet-clinic").variants[0]!.model;
    const checks = { checks: [decision("weak", { entity: "PET", owner: "OWNER" })] };
    for (const mutate of [
      (m: NModel) => { findEntity(m, "PET").partialKey = []; },
      (m: NModel) => { delete findRel(m, "OWNS").identifies; },
      (m: NModel) => { findRel(m, "OWNS").ends[0]!.entity = "VET"; },
      (m: NModel) => { m.entities = m.entities.filter((e) => e.name !== "OWNER"); },
    ]) {
      const candidate = natural("n-vet-clinic").variants[0]!.model;
      mutate(candidate);
      expect(scoreModels(gold, candidate, {}, undefined, checks).decisions!.accuracy).toBe(0);
    }
  });

  it("fails missing attribute matches, composite minParts, and duplicated relationship attributes", () => {
    const gold = natural("n-siparis").variants[0]!.model, candidate = natural("n-siparis").variants[0]!.model;
    const checks = { checks: [decision("composite", { attribute: "MÜŞTERİ.TeslimatAdresleri", minParts: 3 })] };
    findAttr(candidate, "MÜŞTERİ", "TeslimatAdresleri").parts.pop();
    expect(scoreModels(gold, candidate, {}, undefined, checks).decisions!.accuracy).toBe(0);
    findEntity(candidate, "MÜŞTERİ").attrs = [];
    expect(scoreModels(gold, candidate, {}, undefined, checks).decisions!.failed[0]!.reason).toContain("No candidate attribute");
    const supply = natural("n-supply").variants[0]!.model;
    const quantity = findRel(supply, "DELIVERS").attrs[0]!;
    findEntity(supply, "PART").attrs.push({ ...quantity, name: "Amount", id: "A:PART.Amount", owner: "PART", ownerKind: "entity" });
    const scenario = natural("n-supply");
    expect(scoreModels(scenario.variants[0]!.model, supply, scenario.aliases, undefined,
      { checks: [decision("relationshipAttribute", { relationship: "DELIVERS", attribute: "Quantity" })] }).decisions!.failed[0]!.reason).toContain("also occurs");
  });

  it("fails a referenced relationship without a unique candidate match", () => {
    const input: ModelInput = { version: 1, entities: { A: {}, B: {}, C: {} }, relationships: {
      FIRST: { ends: [{ entity: "A", card: "0..N" }, { entity: "B", card: "0..N" }, { entity: "C", card: "0..N" }] },
      SECOND: { ends: [{ entity: "A", card: "0..N" }, { entity: "B", card: "0..N" }, { entity: "C", card: "0..N" }] },
    } };
    const candidate = structuredClone(input);
    delete candidate.relationships!.SECOND;
    const checks = { checks: [decision("ternary", { relationship: "SECOND" })] };
    expect(scoreModels(model(input), model(candidate), {}, undefined, checks).decisions!.accuracy).toBe(0);
    expect(scoreModels(model(input), model(input), {}, undefined, checks).decisions!.accuracy).toBe(1);
  });

  it("maps decision names through entity and attribute aliases and recursive role pairing", () => {
    const gold = model(basic), candidateInput = structuredClone(basic);
    candidateInput.entities.STAFF = { attrs: ["Number", "Name"], keys: [["Number"]] };
    delete candidateInput.entities.EMPLOYEE;
    candidateInput.relationships!.WORKS_FOR!.ends[0]!.entity = "STAFF";
    const checks = { checks: [decision("key", { entity: "EMPLOYEE", attrs: ["Id"] }),
      decision("cardinality", { relationship: "WORKS_FOR", entity: "EMPLOYEE", card: "1..1" })] };
    expect(scoreModels(gold, model(candidateInput), { entities: { EMPLOYEE: ["STAFF"] }, attributes: { "EMPLOYEE.Id": ["Number"] } }, undefined, checks).decisions!.accuracy).toBe(1);
    const scenario = natural("n-vet-clinic"), candidate = natural("n-vet-clinic").variants[0]!.model;
    findRel(candidate, "MENTORS").ends.reverse();
    expect(scoreModels(scenario.variants[0]!.model, candidate, {}, undefined, scenario.checks).decisions!.accuracy).toBe(1);
  });

  it("uses six terms with decisions and five terms without them, without mutating keys", () => {
    const gold = natural("n-car-rental").variants[0]!.model, candidate = natural("n-car-rental").variants[0]!.model;
    const checks = { checks: [decision("key", { entity: "RENTAL", attrs: ["RentalNo"] })] };
    findEntity(candidate, "RENTAL").weak = true;
    const before = JSON.stringify(candidate);
    const report = scoreModels(gold, candidate, {}, undefined, checks);
    const terms = report.entities.f1 + report.relationships.f1 + report.attributes.f1 + report.keys.accuracy + report.cardinality.accuracy;
    expect(report.overall).toBe((terms + report.decisions!.accuracy) / 6);
    const plain = scoreModels(gold, candidate);
    expect(plain.decisions).toBeNull();
    expect(plain.overall).toBe(terms / 5);
    expect(JSON.stringify(candidate)).toBe(before);
    expect(scoreModels(gold, candidate, {}, undefined, checks)).toEqual(report);
    expect(scoreModels(gold, candidate, {}, undefined, { checks: [] }).decisions).toEqual({ correct: 0, total: 0, accuracy: 1, failed: [] });
  });
});

describe("structural entity matching and gold variants", () => {
  it("matches renamed entities by two shared attributes or an equal key, using attribute aliases", () => {
    const gold = model({ version: 1, entities: { PERSON: { attrs: ["Number", "Name", "BirthDate"], keys: [["Number"]] } } });
    const candidate = model({ version: 1, entities: { RECORD: { attrs: ["No", "Name", "Birthday"], keys: [["No"]] } } });
    const report = scoreModels(gold, candidate, { attributes: { "PERSON.Number": ["No"], "PERSON.BirthDate": ["Birthday"] } });
    perfect(report);
    expect(report.matches.entities).toEqual([{ gold: "E:PERSON", candidate: "E:RECORD", matchedBy: "structure" }]);
    const keyOnly = model({ version: 1, entities: { RECORD: { attrs: ["Number", "X", "Y", "Z"], keys: [["Number"]] } } });
    expect(scoreModels(gold, keyOnly).matches.entities[0]!.matchedBy).toBe("structure");
    const noKeys = model({ version: 1, entities: { RECORD: { attrs: ["Name", "BirthDate", "X"] } } });
    expect(scoreModels(gold, noKeys).entities.matched).toBe(1);
    const tooFew = model({ version: 1, entities: { RECORD: { attrs: ["Name"] } } });
    expect(scoreModels(gold, tooFew).entities.matched).toBe(0);
    const lowOverlap = model({ version: 1, entities: { RECORD: { attrs: ["Name", "BirthDate", "X", "Y", "Z"] } } });
    expect(scoreModels(gold, lowOverlap).entities.matched).toBe(0);
    expect(scoreModels(model({ version: 1, entities: { A: {} } }), model({ version: 1, entities: { B: {} } })).entities.matched).toBe(0);
  });

  it("flattens nested attribute names for structure and prefers equality over an alias collision", () => {
    const gold = model({ version: 1, entities: { PERSON: { attrs: [{ name: "Name", parts: ["First", "Last"] }] } } });
    const candidate = model({ version: 1, entities: { RECORD: { attrs: ["Given", "Last"] } } });
    expect(scoreModels(gold, candidate, { attributes: { "PERSON.Name.First": ["Given", "Last"] } }).matches.entities)
      .toEqual([{ gold: "E:PERSON", candidate: "E:RECORD", matchedBy: "structure" }]);
  });

  it("prioritizes name and alias matches, then globally ranks structural pairs deterministically", () => {
    const gold = model({ version: 1, entities: { A: { attrs: ["One", "Two", "Three"] }, B: { attrs: ["One", "Two"] } } });
    const candidate = model({ version: 1, entities: { X: { attrs: ["One", "Two"] }, Y: { attrs: ["One", "Two", "Three"] } } });
    expect(scoreModels(gold, candidate).matches.entities).toEqual([
      { gold: "E:A", candidate: "E:Y", matchedBy: "structure" }, { gold: "E:B", candidate: "E:X", matchedBy: "structure" },
    ]);
    const named = model({ version: 1, entities: { A: { attrs: [] }, X: { attrs: ["One", "Two", "Three"] } } });
    expect(scoreModels(gold, named).matches.entities[0]).toMatchObject({ candidate: "E:A", matchedBy: "name" });
    expect(scoreModels(gold, candidate, { entities: { A: ["X"] } }).matches.entities[0]).toMatchObject({ candidate: "E:X", matchedBy: "alias" });
    const tied = model({ version: 1, entities: { Z: { attrs: ["One", "Two"] }, C: { attrs: ["One", "Two"] } } });
    const sameGold = model({ version: 1, entities: { B: { attrs: ["One", "Two"] }, A: { attrs: ["One", "Two"] } } });
    const first = scoreModels(sameGold, tied);
    expect(first.matches.entities.map((p) => [p.gold, p.candidate])).toEqual([["E:A", "E:C"], ["E:B", "E:Z"]]);
    sameGold.entities.reverse(); tied.entities.reverse();
    tied.entities.forEach((e) => e.attrs.reverse());
    expect(scoreModels(sameGold, tied)).toEqual(first);
  });

  it("selects the alternative gold and applies only its checks", () => {
    const scenario = natural("n-car-rental"), alt = scenario.variants.find((v) => v.name === "alt-option-entity")!;
    const report = scoreVariants([...scenario.variants].reverse(), alt.model, scenario.aliases, undefined, scenario.checks);
    expect(report.goldVariant).toBe("alt-option-entity");
    expect(report.overall).toBe(1);
    expect(report.decisions!.accuracy).toBe(1);
    expect(report.decisions!.total).toBe(scenario.checks!.checks.length - 1);
    expect(scoreVariants(scenario.variants, scenario.variants[0]!.model, scenario.aliases, undefined, scenario.checks).goldVariant).toBe("primary");
    const missingOnlyOnPrimary = { checks: [decision("entity", { entity: "MISSING", variants: ["primary"] })] };
    expect(scoreModels(alt.model, alt.model, {}, undefined, missingOnlyOnPrimary, alt.name).decisions!.total).toBe(0);
    expect(scoreModels(alt.model, alt.model, {}, undefined,
      { checks: [decision("entity", { entity: "MISSING", variants: [] })] }).decisions!.total).toBe(0);
    expect(scoreModels(alt.model, alt.model, {}, undefined, missingOnlyOnPrimary).decisions!.accuracy).toBe(0);
    expect(scoreVariants(scenario.variants, alt.model, scenario.aliases, undefined, scenario.checks)).toEqual(report);
  });

  it("breaks score ties by primary then lexical alternative name", () => {
    const gold = model(basic);
    expect(scoreVariants([{ name: "alt-z", model: gold }, { name: "primary", model: gold }, { name: "alt-a", model: gold }], gold).goldVariant).toBe("primary");
    expect(scoreVariants([{ name: "alt-z", model: gold }, { name: "alt-a", model: gold }], gold).goldVariant).toBe("alt-a");
    expect(() => scoreVariants([], gold)).toThrow("At least one gold variant");
  });
});

describe("evaluation summary", () => {
  it("retains zero contribution for failed attempts and lists every failed decision", () => {
    const scenario = natural("n-car-rental"), candidate = natural("n-car-rental").variants[0]!.model;
    findEntity(candidate, "RENTAL").keys = [];
    const score = scoreVariants(scenario.variants, candidate, scenario.aliases, undefined, scenario.checks);
    const record: SummaryRecord = { scenario: scenario.name, set: "natural", run: 1, status: "ok", wallTimeMs: 1000, hasChecks: true, score };
    const text = summary("codex", [record, { ...record, run: 2, status: "error" },
      { ...record, scenario: "plain", set: "explicit", hasChecks: false, score: scoreModels(model(basic), model(basic)) },
      { ...record, scenario: "unparseable", run: 1, status: "error", score: null }]);
    expect(text).toContain("| Set | Variant |");
    expect(text).toContain("| Decisions |");
    expect(text).toContain(`| n-car-rental | natural | primary | 1/2 | ${(score.overall / 2).toFixed(4)} |`);
    expect(text).toContain(`| ${(score.decisions!.accuracy / 2).toFixed(4)} | 1.00 |`);
    expect(text).toContain("| plain | explicit | primary | 1/1 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | — |");
    expect(text).toContain("| unparseable | natural | — | 0/1 | 0.0000 |");
    for (const failure of score.decisions!.failed) for (const run of [1, 2]) {
      expect(text).toContain(`| n-car-rental | ${run} | ${failure.id} | ${failure.kind} | ${failure.reason} |`);
    }
  });
  it("reports the most common variant with deterministic ties", () => {
    const score = scoreModels(model(basic), model(basic));
    const base: SummaryRecord = { scenario: "sample", set: "natural", run: 1, status: "ok", wallTimeMs: 0, hasChecks: false, score };
    const record = (goldVariant: ScoreReport["goldVariant"], run: number): SummaryRecord => ({ ...base, run, score: { ...score, goldVariant } });
    expect(summary("claude", [record("alt-z", 1), record("primary", 2)])).toContain("| sample | natural | primary |");
    expect(summary("claude", [record("alt-z", 1), record("alt-a", 2)])).toContain("| sample | natural | alt-a |");
    expect(summary("claude", [record("primary", 1), record("alt-z", 2), record("alt-z", 3)])).toContain("| sample | natural | alt-z |");
  });

});
