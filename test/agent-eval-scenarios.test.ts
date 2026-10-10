import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lint } from "../src/core/lint/index.js";
import { parseModel } from "../src/core/normalize.js";
import { MAX_REQUIREMENT_TEXT, parseRequirements } from "../src/core/requirements.js";

const scenarios = new URL("../bench/agent-eval/scenarios/", import.meta.url);
const names = readdirSync(fileURLToPath(scenarios)).sort();

describe("evaluation scenarios", () => {
  it("contains the six required domains", () => {
    expect(names).toEqual(["airline", "company", "hospital", "library", "turkish-labels", "university"]);
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
      expect(doc.items.length).toBeGreaterThanOrEqual(6);
      expect(doc.items.length).toBeLessThanOrEqual(14);
      expect(text.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(doc.items.length);
      expect(new Set(doc.items.map((item) => item.id)).size).toBe(doc.items.length);
      expect(doc.items.every((item) => !item.applied && !item.trace && item.text.length < MAX_REQUIREMENT_TEXT)).toBe(true);
      expect(doc.items.every((item, index) => text.includes(`${index + 1}. ${item.text}`))).toBe(true);
    });
  }
});
