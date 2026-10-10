import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { claudeArgs, codexArgs, lintCommandFor } from "../../src/app/agent-prompt.js";
import { runAgent, type AgentKind, type RunStatus } from "../../src/app/agent-runner.js";
import type { Turn } from "../../src/app/agent-store.js";
import { codexParser, parseStreamLine } from "../../src/app/agent-stream.js";
import { initFile } from "../../src/app/render.js";
import { createRequirements, requirementsPathFor } from "../../src/app/requirements.js";
import { parseModel } from "../../src/core/normalize.js";
import { scoreVariants, type ScoreReport } from "./score.js";
import { loadScenario, selectScenarios, type Scenario, type SetFilter } from "./scenarios.js";
import { summary, type SummaryRecord } from "./summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const scenariosDir = join(here, "scenarios");
const usage = `Usage: node_modules/.bin/tsx bench/agent-eval/run.ts --agent claude|codex [--scenario <name>]... [--set explicit|natural|all] [--runs N] [--out <dir>]

Options:
  --agent       CLI to run, using its own login (required)
  --scenario    Scenario name; repeat to select several (default: all)
  --set         Scenario set: explicit, natural, or all (default: all)
  --runs        Positive integer attempts per scenario (default: 1)
  --out         Artifact directory (default: bench/agent-eval/results/<UTC date-time>)
  --help        Print this help without invoking a CLI

Runs one Requirements Apply per fresh model, sequentially. Failed or limited runs are saved without retries.
This script calls real CLIs and is intentionally excluded from tests and CI.
`;

interface RunRecord extends SummaryRecord {
  agent: AgentKind;
  language: Scenario["language"];
  scenario: string;
  run: number;
  status: RunStatus;
  cliStatus: RunStatus | null;
  startedAt: string;
  finishedAt: string;
  wallTimeMs: number;
  usage: Record<string, number> | null;
  score: ScoreReport | null;
  parseDiagnostics: ReturnType<typeof parseModel>["diagnostics"];
  error: string | null;
  sessionId: string | null;
  settleError: string | null;
}

const json = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Keep only numeric usage metadata from terminal CLI events, never arbitrary event text. */
function captureUsage(line: string, counters: Record<string, number>): void {
  let event: Record<string, unknown>;
  try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  if (!event || (event.type !== "result" && event.type !== "turn.completed" && event.type !== "turn.failed")) return;
  const visit = (value: unknown, prefix: string): void => {
    if (typeof value === "number" && Number.isFinite(value)) counters[prefix] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, `${prefix}.${key}`);
    }
  };
  for (const key of ["usage", "modelUsage", "total_cost_usd", "duration_ms", "duration_api_ms", "num_turns"]) visit(event[key], key);
}

async function evaluate(agent: AgentKind, scenario: Scenario, run: number, artifactDir: string): Promise<RunRecord> {
  const startedAt = new Date().toISOString(), start = performance.now();
  const counters: Record<string, number> = {};
  let workspace: string | undefined;
  let modelPath: string | undefined, requirementsPath: string | undefined;
  let turn: Turn | undefined;
  let cliStatus: RunStatus | null = null, status: RunStatus = "error";
  let error: string | null = null, sessionId: string | null = null, settleError: string | null = null;
  let reply = "";
  try {
    workspace = mkdtempSync(join(tmpdir(), "chen-er-eval-"));
    modelPath = join(workspace, "model.er.yaml");
    requirementsPath = requirementsPathFor(modelPath);
    copyFileSync(join(scenario.dir, "requirements.md"), requirementsPath);
    initFile(modelPath, false, { empty: true, title: scenario.variants[0]!.model.title ?? scenario.name });
    const lintCommand = lintCommandFor(join(root, "src/cli/index.ts"), root);
    const controller = createRequirements({ path: requirementsPath, modelPath, agent, lintCommand,
      serial: async (task) => task(), emit: () => {} });
    const { text, plan } = controller.plan({ expectedRevision: controller.view().revision });
    writeFileSync(join(artifactDir, "prompt.txt"), `${plan.prompt}\n`);
    turn = { id: "t1", text, selection: [], startedAt, status: "running", steps: [], requirements: plan.requirements };
    const args = agent === "claude" ? claudeArgs(plan.prompt, workspace, lintCommand) : codexArgs(plan.prompt, workspace, workspace);
    const parser = agent === "codex" ? codexParser() : parseStreamLine;
    const handle = runAgent({ bin: agent, args, cwd: workspace, kind: agent,
      parse: (line) => { captureUsage(line, counters); return parser(line); }, onStep: (step) => turn!.steps.push(step) });
    const cancel = (): void => { void handle.cancel(); };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let outcome;
    try { outcome = await handle.done; }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
    status = cliStatus = outcome.status;
    sessionId = outcome.sessionId ?? null;
    error = outcome.error ?? null;
    reply = outcome.reply ?? "";
    Object.assign(turn, { status, ...(reply ? { reply } : {}), ...(error ? { error } : {}), ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}) });
    try { await plan.settle?.(turn); }
    catch (failure) {
      settleError = message(failure);
      turn.steps.push({ kind: "text", summary: `The requirements file was not updated: ${settleError}` });
    }
    turn.finishedAt = new Date().toISOString();
  } catch (failure) { status = "error"; error = message(failure); }

  try {
    const readFinal = (path: string | undefined): string => {
      if (!path) return "";
      try { return readFileSync(path, "utf8"); }
      catch (failure) { status = "error"; error ??= `Cannot read final artifact: ${message(failure)}`; return ""; }
    };
    const yaml = readFinal(modelPath), requirements = readFinal(requirementsPath);
    writeFileSync(join(artifactDir, "model.er.yaml"), yaml);
    writeFileSync(join(artifactDir, "model.er.requirements.md"), requirements);
    writeFileSync(join(artifactDir, "reply.txt"), reply);
    const parsed = parseModel(yaml);
    const score = parsed.model ? scoreVariants(scenario.variants, parsed.model, scenario.aliases, requirements, scenario.checks) : null;
    if (!parsed.model && status === "ok") { status = "error"; error = "The final model does not parse."; }
    const record: RunRecord = { agent, scenario: scenario.name, set: scenario.set, language: scenario.language, hasChecks: !!scenario.checks, run, status, cliStatus, startedAt, finishedAt: new Date().toISOString(),
      wallTimeMs: performance.now() - start, usage: Object.keys(counters).length ? counters : null, score,
      parseDiagnostics: parsed.diagnostics, error, sessionId, settleError };
    json(join(artifactDir, "score.json"), score);
    json(join(artifactDir, "run.json"), record);
    json(join(artifactDir, "turn.json"), turn ?? null);
    return record;
  } finally { if (workspace) rmSync(workspace, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { agent: { type: "string" }, scenario: { type: "string", multiple: true },
    set: { type: "string", default: "all" }, runs: { type: "string", default: "1" }, out: { type: "string" }, help: { type: "boolean" } }, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  if (!["explicit", "natural", "all"].includes(values.set!)) throw new Error("--set must be explicit, natural, or all.");
  if (values.agent !== "claude" && values.agent !== "codex") throw new Error("--agent must be claude or codex. Use --help for usage.");
  if (!/^[1-9]\d*$/.test(values.runs!) || !Number.isSafeInteger(Number(values.runs))) throw new Error("--runs must be a positive safe integer.");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"]) {
    if (process.env[key]) throw new Error(`Unset ${key}; this benchmark uses the CLI's own login.`);
  }
  const available = readdirSync(scenariosDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const names = [...new Set(values.scenario ?? available)];
  for (const name of names) if (!available.includes(name)) throw new Error(`Unknown scenario: ${name}. Available: ${available.join(", ")}`);
  const scenarios = selectScenarios(names.map((name) => loadScenario(scenariosDir, name)), values.set as SetFilter);
  if (!scenarios.length) throw new Error("No scenarios match the selected --set and --scenario filters.");
  const out = resolve(values.out ?? join(here, "results", new Date().toISOString().replace(/[:.]/g, "-")));
  const attempts = scenarios.flatMap((scenario) => Array.from({ length: Number(values.runs) }, (_, index) => ({ scenario, run: index + 1,
    dir: join(out, `${values.agent}-${scenario.name}-${index + 1}`) })));
  for (const attempt of attempts) if (existsSync(attempt.dir)) throw new Error(`Artifacts already exist: ${attempt.dir}. Choose a fresh --out directory.`);
  mkdirSync(out, { recursive: true });
  const records: RunRecord[] = [];
  let interrupted = false;
  const stop = (): void => { interrupted = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (const attempt of attempts) {
      mkdirSync(attempt.dir);
      console.log(`${values.agent} ${attempt.scenario.name} ${attempt.run}/${values.runs}`);
      const record = await evaluate(values.agent, attempt.scenario, attempt.run, attempt.dir);
      records.push(record);
      writeFileSync(join(out, "summary.md"), summary(values.agent, records));
      console.log(`  ${record.status}; overall=${record.score?.overall.toFixed(4) ?? "unparseable"}; ${(record.wallTimeMs / 1000).toFixed(2)}s`);
      if (interrupted) break;
    }
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  if (interrupted) process.exitCode = 130;
  else if (records.some((record) => record.status !== "ok")) process.exitCode = 1;
  console.log(`Artifacts: ${out}`);
}

main().catch((error: unknown) => { console.error(message(error)); process.exitCode = 1; });
