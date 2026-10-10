import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalize } from "../src/core/normalize.js";
import { parseModel } from "../src/core/normalize.js";
import type { AttributeInput, EntityInput } from "../src/core/schema.js";
import { scoreModels, scoreVariants, type Aliases } from "../bench/agent-eval/score.js";
import { loadScenario } from "../bench/agent-eval/scenarios.js";

const owner = (attrs: AttributeInput[], extra: Partial<EntityInput> = {}) => normalize({ version: 1, entities: { PERSON: { attrs, ...extra } } });
const pair = (gold: string, candidate: string, aliases: Aliases = {}) => scoreModels(owner([gold]), owner([candidate]), aliases);

describe("attribute matching passes", () => {
  it("records exact and alias matches and rejects unrelated or wrongly scoped aliases", () => {
    expect(pair("Course_Code", "course-code").matches.attributes[0]!.matchedBy).toBe("name");
    expect(pair("Number", "Identifier", { attributes: { "PERSON.Number": ["Identifier"] } }).matches.attributes[0]!.matchedBy).toBe("alias");
    expect(pair("Number", "Identifier").attributes.matched).toBe(0);
    expect(pair("Number", "Identifier", { attributes: { "OTHER.Number": ["Identifier"] } }).attributes.matched).toBe(0);
  });

  for (const [gold, candidate] of [["DemirbaşNo", "DemirbasNo"], ["ÜyeNo", "UyeNo"], ["MüşteriNo", "MusteriNo"],
    ["SiparişNo", "SiparisNo"], ["SatırNo", "SatirNo"]]) {
    it(`folds ${gold}/${candidate} without changing display names`, () => {
      const g = owner([gold!]), c = owner([candidate!]);
      expect(scoreModels(g, c).matches.attributes).toEqual([{ gold: `A:PERSON.${gold}`, candidate: `A:PERSON.${candidate}`, matchedBy: "folded" }]);
      expect(g.entities[0]!.attrs[0]!.label).toBe(gold);
      expect(c.entities[0]!.attrs[0]!.label).toBe(candidate);
      expect(pair(gold!, "Address").attributes.matched).toBe(0);
    });
  }

  it("consumes exact, alias and folded matches before the remaining key", () => {
    const report = scoreModels(owner(["Id", "ÜyeNo", "RegistrationNo", "Name"], { keys: [["Id"], ["ÜyeNo"], ["RegistrationNo"]] }),
      owner(["Id", "UyeNo", "Identifier", "Title"], { keys: [["Id"], ["UyeNo"], ["Identifier"]] }),
      { attributes: { "PERSON.Name": ["Title"] } });
    expect(report.matches.attributes.map((p) => [p.gold, p.matchedBy])).toEqual([
      ["A:PERSON.Id", "name"], ["A:PERSON.Name", "alias"], ["A:PERSON.RegistrationNo", "key"], ["A:PERSON.ÜyeNo", "folded"],
    ]);
    expect(report.overall).toBe(1);
  });

  it("matches exactly one remaining strong or partial key by role", () => {
    for (const weak of [false, true]) {
      const g = owner(["RegistrationNo"], weak ? { weak, partialKey: ["RegistrationNo"] } : { keys: [["RegistrationNo"]] });
      const c = owner(["Identifier"], weak ? { weak, partialKey: ["Identifier"] } : { keys: [["Identifier"]] });
      const report = scoreModels(g, c);
      expect(report.matches.attributes[0]!.matchedBy).toBe("key");
      expect(report.keys.accuracy).toBe(1);
      expect(scoreModels(g, owner(["Identifier"])).attributes.matched).toBe(0);
    }
  });

  it("rejects key-role matching when either side has two unmatched key attributes", () => {
    const one = owner(["Identifier"], { keys: [["Identifier"]] });
    const two = owner(["Account", "Serial"], { keys: [["Account"], ["Serial"]] });
    expect(scoreModels(one, two).attributes.matched).toBe(0);
    expect(scoreModels(two, one).attributes.matched).toBe(0);
    const mixed = owner(["Account", "Serial"], { keys: [["Account"]], partialKey: ["Serial"] });
    expect(scoreModels(mixed, one).attributes.matched).toBe(0);
  });

  for (const [gold, candidate] of [["RegistrationNo", "RegNo"], ["ProfessorNo", "ProfNo"], ["CourseCode", "Code"],
    ["Telefonlar", "Telefon"], ["RegNo", "RegistrationNo"], ["Registration_No12", "Reg_No12"], ["ProfessorNo", "Prof_No"]]) {
    it(`matches ${gold}/${candidate} by tokens`, () => {
      expect(pair(gold!, candidate!).matches.attributes[0]!.matchedBy).toBe("tokens");
      expect(pair(gold!, candidate!).overall).toBe(1);
    });
  }

  for (const [gold, candidate] of [["AdmissionDate", "Address"], ["RegistrationNo", "No"], ["Number", "No"],
    ["RegistrationNo", "RNo"], ["RegistrationNo", "RegCode"], ["Registration_No12", "Reg_No34"]]) {
    it(`rejects token similarity for ${gold}/${candidate}`, () => {
      expect(pair(gold!, candidate!).attributes.matched).toBe(0);
      expect(pair(candidate!, gold!).overall).toBeLessThan(1);
    });
  }

  it("requires compatible multivalued flags for tokens and ignores derived", () => {
    const gold = owner([{ name: "Telefonlar", multivalued: true, derived: true }]);
    const checks = { checks: [{ id: "phones", kind: "multivalued" as const, attribute: "PERSON.Telefonlar", why: "Several phone numbers." }] };
    const good = scoreModels(gold, owner([{ name: "Telefon", multivalued: true }]), {}, undefined, checks);
    expect(good.decisions!.accuracy).toBe(1);
    expect(good.matches.attributes[0]!.matchedBy).toBe("tokens");
    expect(good.attributeProperties.accuracy).toBe(0);
    const bad = scoreModels(gold, owner(["Telefon"]), {}, undefined, checks);
    expect(bad.attributes.matched).toBe(0);
    expect(bad.decisions!.accuracy).toBe(0);
    expect(scoreModels(owner(["Telefonlar"]), owner([{ name: "Telefon", multivalued: true }])).attributes.matched).toBe(0);
    expect(scoreModels(gold, owner(["Telefonlar"])).attributes.matched).toBe(1);
  });

  it("applies all name passes recursively on entity and relationship composite parts", () => {
    const attrs: AttributeInput[] = [{ name: "Details", parts: ["Name", "ÜyeNo", { name: "Identity", parts: ["RegistrationNo", "ProfessorNo"] }] }];
    const renamed: AttributeInput[] = [{ name: "Details", parts: ["Title", "UyeNo", { name: "Identity", parts: ["RegNo", "ProfNo"] }] }];
    for (const relationship of [false, true]) {
      const make = (items: AttributeInput[]) => relationship ? normalize({ version: 1, entities: { A: {}, B: {} }, relationships: {
        PERSON: { attrs: items, ends: [{ entity: "A", card: "0..N" }, { entity: "B", card: "0..N" }] },
      } }) : owner(items);
      const gold = make(attrs), candidate = make(renamed);
      const aliases = { attributes: { "PERSON.Details.Name": ["Title"] } };
      const report = scoreModels(gold, candidate, aliases);
      expect(report.overall).toBe(1);
      expect(report.matches.attributes.map((p) => p.matchedBy)).toEqual(["name", "name", "tokens", "tokens", "alias", "folded"]);
      expect(scoreModels(gold, make(["Title", "UyeNo", "RegNo", "ProfNo"]), aliases).attributes.matched).toBe(0);
    }
  });

  it("ranks passes before prefix length and consumes each attribute once deterministically", () => {
    const gold = owner(["RegNo", "RegimentNo", "RegistrationNo", "ÜyeNo"]);
    const candidate = owner(["RegNo", "RegisNo", "UyeNo", "Title"]);
    const aliases = { attributes: { "PERSON.ÜyeNo": ["Title"] } };
    const before = JSON.stringify([gold, candidate]);
    const first = scoreModels(gold, candidate, aliases);
    expect(first.matches.attributes).toEqual([
      { gold: "A:PERSON.RegNo", candidate: "A:PERSON.RegNo", matchedBy: "name" },
      { gold: "A:PERSON.RegistrationNo", candidate: "A:PERSON.RegisNo", matchedBy: "tokens" },
      { gold: "A:PERSON.ÜyeNo", candidate: "A:PERSON.Title", matchedBy: "alias" },
    ]);
    expect(JSON.stringify([gold, candidate])).toBe(before);
    gold.entities[0]!.attrs.reverse(); candidate.entities[0]!.attrs.reverse();
    expect(scoreModels(gold, candidate, aliases)).toEqual(first);
    const tied = scoreModels(owner(["RegistryNo", "RegistrationNo"]), owner(["RegNo"]));
    expect(tied.matches.attributes[0]!.gold).toBe("A:PERSON.RegistrationNo");
    const candidateTie = scoreModels(owner(["RegistrationNo"]), owner(["Reg_No", "RegNo"]));
    expect(candidateTie.matches.attributes[0]!.candidate).toBe("A:PERSON.RegNo");
  });
});

describe("folded owner matching", () => {
  it("uses folded entity names before structure and folded relationship names before overlap", () => {
    const gold = normalize({ version: 1, entities: { ÜYE: { attrs: ["Name", "Date"] }, ŞUBE: {} }, relationships: {
      ÖDÜNÇ: { ends: [{ entity: "ÜYE", card: "0..N" }, { entity: "ŞUBE", card: "0..N" }], attrs: ["Date"] },
    } });
    const candidate = normalize({ version: 1, entities: { UYE: {}, RECORD: { attrs: ["Name", "Date"] }, SUBE: {} }, relationships: {
      ODUNC: { ends: [{ entity: "UYE", card: "0..N" }, { entity: "SUBE", card: "0..N" }] },
      OTHER: { ends: [{ entity: "UYE", card: "0..N" }, { entity: "SUBE", card: "0..N" }], attrs: ["Date"] },
    } });
    const report = scoreModels(gold, candidate);
    expect(report.matches.entities).toContainEqual({ gold: "E:ÜYE", candidate: "E:UYE", matchedBy: "folded" });
    expect(report.matches.relationships).toEqual([{ gold: "R:ÖDÜNÇ", candidate: "R:ODUNC" }]);
    expect(scoreModels(owner([]), normalize({ version: 1, entities: { ADDRESS: {} } })).entities.matched).toBe(0);
    candidate.relationships = candidate.relationships.slice(0, 1);
    candidate.relationships[0]!.ends[1]!.entity = "UYE";
    expect(scoreModels(gold, candidate).relationships.matched).toBe(0);
  });

  it("scores the saved library candidate perfectly, including decisions", () => {
    const scenario = loadScenario(fileURLToPath(new URL("../bench/agent-eval/scenarios/", import.meta.url)), "n-kutuphane-agi");
    const parsed = parseModel(readFileSync(new URL("fixtures/agent-eval/kutuphane-candidate.er.yaml", import.meta.url), "utf8"));
    expect(parsed.diagnostics).toEqual([]);
    const report = scoreVariants(scenario.variants, parsed.model!, scenario.aliases, undefined, scenario.checks);
    expect(report.overall).toBe(1);
    expect(report.decisions!.accuracy).toBe(1);
    expect(report.details.unmatchedGold.attributes).toEqual([]);
    expect(report.matches.attributes.find((p) => p.gold === "A:ÜYE.Telefonlar")!.matchedBy).toBe("tokens");
  });
});
