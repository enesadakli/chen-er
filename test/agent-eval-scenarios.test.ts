import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lint } from "../src/core/lint/index.js";
import { flattenAttrs, parseModel } from "../src/core/normalize.js";
import { checkReferenceErrors, scoreModels, scoreVariants } from "../bench/agent-eval/score.js";
import { loadScenario, selectScenarios } from "../bench/agent-eval/scenarios.js";
import { MAX_REQUIREMENT_TEXT, parseRequirements } from "../src/core/requirements.js";

const scenarios = new URL("../bench/agent-eval/scenarios/", import.meta.url);
const names = readdirSync(fileURLToPath(scenarios)).sort();

describe("evaluation scenarios", () => {
  it("contains both six-scenario sets", () => {
    expect(names).toEqual(["airline", "company", "hospital", "library", "n-car-rental", "n-course-sections", "n-kutuphane-agi", "n-siparis", "n-supply", "n-vet-clinic", "turkish-labels", "university"]);
  });

  for (const name of names) {
    it(`${name}: gold parses and has zero lint errors`, () => {
      const parsed = parseModel(readFileSync(new URL(`${name}/gold.er.yaml`, scenarios), "utf8"));
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.model).toBeDefined();
      expect(lint(parsed.model!).filter((d) => d.severity === "error")).toEqual([]);
    });
    it(`${name}: has 6–14 complete numbered requirements without applied state`, () => {
      const text = readFileSync(new URL(`${name}/requirements.md`, scenarios), "utf8");
      const doc = parseRequirements(text);
      expect(doc.items.length).toBeGreaterThanOrEqual(name.startsWith("n-") ? 8 : 6);
      expect(doc.items.length).toBeLessThanOrEqual(14);
      expect(text.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(doc.items.length);
      expect(new Set(doc.items.map((item) => item.id)).size).toBe(doc.items.length);
      expect(doc.items.every((item) => !item.applied && !item.trace && item.text.length < MAX_REQUIREMENT_TEXT)).toBe(true);
      expect(doc.items.every((item, index) => text.includes(`${index + 1}. ${item.text}`))).toBe(true);
    });
  }
  const loaded = names.map((name) => loadScenario(fileURLToPath(scenarios), name));
  it("defaults existing scenarios to explicit/en and filters both sets", () => {
    const explicit = selectScenarios(loaded, "explicit"), natural = selectScenarios(loaded, "natural");
    expect(explicit).toHaveLength(6);
    expect(explicit.every((s) => s.language === "en" && s.checks === undefined)).toBe(true);
    expect(natural).toHaveLength(6);
    expect(natural.filter((s) => s.language === "tr").map((s) => s.name)).toEqual(["n-kutuphane-agi", "n-siparis"]);
    expect(selectScenarios(loaded, "all")).toEqual(loaded);
  });

  for (const scenario of loaded) {
    for (const variant of scenario.variants) {
      it(`${scenario.name}/${variant.name}: every check references gold and self-scores perfectly`, () => {
        expect(lint(variant.model).filter((d) => d.severity === "error")).toEqual([]);
        const checks = scenario.checks?.checks.filter((c) => !c.variants || c.variants.includes(variant.name)) ?? [];
        for (const check of checks) expect(checkReferenceErrors(check, variant.model)).toEqual([]);
        const report = scoreModels(variant.model, variant.model, scenario.aliases, undefined, scenario.checks, variant.name);
        expect(report.overall).toBe(1);
        expect(report.goldVariant).toBe(variant.name);
        if (scenario.set === "natural") {
          expect(checks.length).toBeGreaterThan(0);
          expect(report.decisions).toEqual({ correct: checks.length, total: checks.length, accuracy: 1, failed: [] });
        } else expect(report.decisions).toBeNull();
        expect(scoreVariants(scenario.variants, variant.model, scenario.aliases, undefined, scenario.checks).overall).toBe(1);
      });
    }
    if (scenario.set === "natural") {
      it(`${scenario.name}: prose contains no modeling vocabulary or identifier hints`, () => {
        const text = readFileSync(new URL(`${scenario.name}/requirements.md`, scenarios), "utf8");
        const english = /\b(?:entity|entities|attributes?|weak|keys?|partial|ternary|binary|multivalued|multi-valued|derived|composite|cardinality|participation|relationships?|identifying)\b/i;
        const turkish = /(?:^|[^\p{L}\p{N}_])(?:varlık|nitelik|zayıf|anahtar|kısmi|üçlü|ikili|çok\s+değerli|türetilmiş|bileşik|kardinalite|katılım|ilişki[\p{L}\p{N}_]*)(?=$|[^\p{L}\p{N}_])/iu;
        expect(text).not.toMatch(english);
        expect(text).not.toMatch(turkish);
        expect(text).not.toMatch(/(?<!\p{L})\p{Lu}{3,}(?!\p{L})/u);
        expect(text).not.toMatch(/\p{L}+[\p{L}\p{N}]*_[\p{L}\p{N}_]+/u);
        expect(text).not.toMatch(/\p{Ll}\p{Lu}/u);
        expect(scenario.checks?.checks.length).toBeGreaterThan(0);
        expect(new Set(scenario.checks!.checks.map((c) => c.id)).size).toBe(scenario.checks!.checks.length);
        const cardinalities = scenario.checks!.checks.filter((c) => c.kind === "cardinality");
        expect(cardinalities.length).toBeGreaterThanOrEqual(3);
        expect(cardinalities.length).toBeLessThanOrEqual(5);
        for (const variant of scenario.variants) for (const entity of variant.model.entities) {
          expect(scenario.aliases.entities?.[entity.name]?.length).toBeGreaterThanOrEqual(2);
          expect(scenario.aliases.entities?.[entity.name]?.length).toBeLessThanOrEqual(4);
          for (const attr of flattenAttrs(entity.attrs)) {
            const aliases = scenario.aliases.attributes?.[attr.id.slice(2)];
            expect(aliases?.length).toBeGreaterThanOrEqual(2);
            expect(aliases?.length).toBeLessThanOrEqual(4);
          }
        }
      });
    }
  }

});
