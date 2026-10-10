import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { lint } from "../../src/core/lint/index.js";
import { parseModel } from "../../src/core/normalize.js";
import { checkReferenceErrors, type Aliases, type ChecksDocument, type GoldVariant } from "./score.js";

export type ScenarioSet = "explicit" | "natural";
export type SetFilter = ScenarioSet | "all";
export interface Scenario {
  name: string;
  dir: string;
  set: ScenarioSet;
  language: "en" | "tr";
  variants: GoldVariant[];
  aliases: Aliases;
  checks?: ChecksDocument;
}

const metadata = z.object({ set: z.enum(["explicit", "natural"]), language: z.enum(["en", "tr"]) }).strict();
const variantName = z.string().regex(/^(primary|alt-[^/\r\n]+)$/);
const base = { id: z.string().min(1), why: z.string().min(1).regex(/^[^\r\n]+$/), variants: z.array(variantName).optional() };
const name = z.string().min(1);
const relationship = { relationship: name };
const attribute = { attribute: name };
const checksSchema = z.object({ checks: z.array(z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("weak"), entity: name, owner: name }).strict(),
  z.object({ ...base, kind: z.literal("ternary"), ...relationship }).strict(),
  z.object({ ...base, kind: z.literal("recursive"), ...relationship }).strict(),
  z.object({ ...base, kind: z.literal("multivalued"), ...attribute }).strict(),
  z.object({ ...base, kind: z.literal("derived"), ...attribute }).strict(),
  z.object({ ...base, kind: z.literal("composite"), ...attribute, minParts: z.number().optional() }).strict(),
  z.object({ ...base, kind: z.literal("relationshipAttribute"), ...relationship, ...attribute }).strict(),
  z.object({ ...base, kind: z.literal("entity"), entity: name }).strict(),
  z.object({ ...base, kind: z.literal("cardinality"), ...relationship, entity: name,
    card: z.string().regex(/^\s*\d+\s*\.\.\s*(\d+|[NnMm*])\s*$/), role: name.optional() }).strict(),
  z.object({ ...base, kind: z.literal("key"), entity: name, attrs: z.array(name).min(1) }).strict(),
])) }).strict();
const aliasesSchema = z.object({
  entities: z.record(z.string(), z.array(name)).optional(),
  relationships: z.record(z.string(), z.array(name)).optional(),
  attributes: z.record(z.string(), z.array(name)).optional(),
}).strict();
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function loadScenario(scenariosDir: string, name: string): Scenario {
  const dir = join(scenariosDir, name), metadataPath = join(dir, "scenario.json");
  const info = existsSync(metadataPath) ? metadata.parse(readJson(metadataPath)) : { set: "explicit", language: "en" } as const;
  const files = ["gold.er.yaml", ...readdirSync(dir).filter((file) => /^gold\.alt-.+\.er\.yaml$/.test(file)).sort()];
  const variants: GoldVariant[] = files.map((file) => {
    const parsed = parseModel(readFileSync(join(dir, file), "utf8"));
    if (!parsed.model || lint(parsed.model).some((d) => d.severity === "error")) throw new Error(`Invalid gold model: ${name}/${file}`);
    return { name: file === "gold.er.yaml" ? "primary" : file.slice(5, -8) as GoldVariant["name"], model: parsed.model };
  });
  const aliasPath = join(dir, "aliases.json"), checkPath = join(dir, "checks.json");
  const aliases = existsSync(aliasPath) ? aliasesSchema.parse(readJson(aliasPath)) : {};
  const checks = existsSync(checkPath) ? checksSchema.parse(readJson(checkPath)) as ChecksDocument : undefined;
  if (info.set === "natural" && !checks?.checks.length) throw new Error(`Natural scenario requires decision checks: ${name}`);
  if (checks) {
    if (new Set(checks.checks.map((check) => check.id)).size !== checks.checks.length) throw new Error(`Duplicate check ids: ${name}`);
    for (const check of checks.checks) {
      if (check.variants?.some((variant) => !variants.some((v) => v.name === variant))) throw new Error(`Unknown variant in ${name}/${check.id}`);
      for (const variant of variants.filter((v) => !check.variants || check.variants.includes(v.name))) {
        const errors = checkReferenceErrors(check, variant.model);
        if (errors.length) throw new Error(`Invalid check ${name}/${check.id}/${variant.name}: ${errors.join("; ")}`);
      }
    }
  }
  return { name, dir, ...info, variants, aliases, checks };
}

export function selectScenarios(scenarios: readonly Scenario[], set: SetFilter): Scenario[] {
  return scenarios.filter((scenario) => set === "all" || scenario.set === set);
}
