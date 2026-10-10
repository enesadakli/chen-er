import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { AgentKind } from "../../src/app/agent-runner.js";
import { parseModel } from "../../src/core/normalize.js";
import { scoreVariants } from "./score.js";
import { loadScenario } from "./scenarios.js";
import { summary, type SummaryRecord } from "./summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const usage = `Usage: node_modules/.bin/tsx bench/agent-eval/rescore.ts <results dir> [--out <dir>]

Options:
  --out         Write rescored files under this directory (default: results dir)
  --help        Print this help

Reparse saved model and requirements artifacts without invoking a CLI.
Write <attempt>/score.rescored.json and summary.rescored.md; preserve originals.
`;
const runMetadata = z.object({
  status: z.enum(["ok", "error", "cancelled", "limit"]),
  wallTimeMs: z.number().finite().nonnegative(),
});

export function rescoreResults(resultsDir: string, outDir = resultsDir): void {
  const scenariosDir = join(here, "scenarios");
  const known = new Set(readdirSync(scenariosDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const attempts = readdirSync(resultsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((entry) => {
      const dir = join(resultsDir, entry.name);
      const match = /^(claude|codex)-(.+)-([1-9]\d*)$/.exec(entry.name);
      if (!match) {
        if (existsSync(join(dir, "run.json"))) throw new Error(`Invalid artifact directory: ${entry.name}`);
        return [];
      }
      const agent = match[1] as AgentKind, name = match[2]!, run = Number(match[3]);
      if (!Number.isSafeInteger(run)) throw new Error(`Invalid run number: ${entry.name}`);
      if (!known.has(name)) throw new Error(`Unknown scenario: ${name}`);
      const metadata = runMetadata.parse(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")));
      const scenario = loadScenario(scenariosDir, name);
      const parsed = parseModel(readFileSync(join(dir, "model.er.yaml"), "utf8"));
      const requirements = readFileSync(join(dir, "model.er.requirements.md"), "utf8");
      const score = parsed.model ? scoreVariants(scenario.variants, parsed.model, scenario.aliases, requirements, scenario.checks) : null;
      const record: SummaryRecord = { scenario: name, set: scenario.set, run, status: metadata.status,
        wallTimeMs: metadata.wallTimeMs, hasChecks: !!scenario.checks, score };
      return [{ name: entry.name, agent, record }];
    });
  if (!attempts.length) throw new Error(`No artifact directories found in ${resultsDir}`);
  for (const attempt of attempts) {
    const target = join(outDir, attempt.name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "score.rescored.json"), `${JSON.stringify(attempt.record.score, null, 2)}\n`);
  }
  const agents = [...new Set(attempts.map((attempt) => attempt.agent))];
  writeFileSync(join(outDir, "summary.rescored.md"), agents.map((agent) =>
    summary(agent, attempts.filter((attempt) => attempt.agent === agent).map((attempt) => attempt.record))).join("\n"));
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } }, allowPositionals: true });
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error("Expected one results directory. Use --help for usage.");
  const resultsDir = resolve(positionals[0]!);
  rescoreResults(resultsDir, values.out === undefined ? resultsDir : resolve(values.out));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error: unknown) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
