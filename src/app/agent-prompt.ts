// Prompt and command line for one agent turn.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flattenAttrs, parseModel } from "../core/normalize.js";

export interface SelectedNode { id: string; label?: string }

const quote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** How this process was started, so the agent can run the same CLI's `lint`. */
export function lintCommandFor(script: string | undefined, root: string): string {
  if (script && /[\\/]src[\\/]cli[\\/]index\.ts$/.test(script)) return tsxLint(resolve(script));
  if (script && /([\\/]bin[\\/]chen(\.js)?|[\\/]dist[\\/]cli[\\/]index\.js)$/.test(script)) return `node ${quote(resolve(script))} lint`;
  // Embedded use (tests, other hosts): fall back to this checkout or package.
  const source = join(root, "src/cli/index.ts");
  return existsSync(source) && !existsSync(join(root, "dist/cli/index.js"))
    ? tsxLint(source)
    : `node ${quote(join(root, "bin/chen.js"))} lint`;
}

/** A checkout's own tsx when installed: `npx` would try the network for it from another directory, and the Codex
 * sandbox has no network. */
function tsxLint(source: string): string {
  const tsx = join(dirname(dirname(dirname(source))), "node_modules/.bin/tsx");
  return existsSync(tsx) ? `${quote(tsx)} ${quote(source)} lint` : `npx tsx ${quote(source)} lint`;
}

/** Labels for selected node ids, read from the current model text. Unknown ids keep no label. */
export function selectionLabels(yaml: string | null, ids: readonly string[]): SelectedNode[] {
  const model = yaml === null ? undefined : parseModel(yaml).model;
  const labels = new Map<string, string>();
  for (const owner of [...model?.entities ?? [], ...model?.relationships ?? []]) {
    labels.set(owner.id, owner.label);
    for (const a of flattenAttrs(owner.attrs)) labels.set(a.id, a.label);
  }
  return ids.map((id) => ({ id, label: labels.get(id) }));
}

/** Rules every agent turn gets, chat request or requirements apply. */
function rules(modelPath: string, lintCommand: string): string[] {
  return [
    "Rules:",
    "- Edit only that YAML file.",
    "- Keep its comments and formatting.",
    `- After editing, run \`${lintCommand} ${quote(modelPath)}\` and fix any errors.`,
    "- Never edit *.er.layout.json, *.er.agent.json or *.er.requirements.md files.",
    "- Do not create or update notes, memory, receipts or logs outside the model file.",
  ];
}

export function buildPrompt(input: { modelPath: string; lintCommand: string; selection: readonly SelectedNode[]; text: string }): string {
  const selected = input.selection.length
    ? input.selection.map((s) => s.label ? `${s.id} (${s.label})` : s.id)
    : ["(none)"];
  return [
    "You edit a Chen ER model for the chen-er viewer.",
    `Model file: ${input.modelPath}`,
    "Selected elements:",
    ...selected,
    ...rules(input.modelPath, input.lintCommand),
    "- Reply with one or two plain sentences describing what changed.",
    "",
    "Request:",
    input.text,
  ].join("\n");
}

export interface PromptRequirement { id: string; label: string; text: string; changed?: boolean; trace?: readonly string[] }

/**
 * One requirements apply: the lines to process now (new or changed), the whole list as context, the usual rules and
 * the trace format the server parses (docs/requirements.md). Lines carry their stable id and their R-number.
 */
export function buildRequirementsPrompt(input: { modelPath: string; lintCommand: string; apply: readonly PromptRequirement[]; all: readonly PromptRequirement[] }): string {
  const line = (r: PromptRequirement) => `${r.id} (${r.label}): ${r.text}`;
  const example = Object.fromEntries(input.apply.slice(0, 2).map((r, i) => [r.id, i === 0
    ? { elements: ["E:COURSE", "R:OFFERS", "A:COURSE.Title"], why: "one line: how these elements implement the requirement" }
    : { elements: [], why: "one line: why no element implements it" }]));
  return [
    "You build a Chen ER model for the chen-er viewer from a student's requirements, the way a database course does:",
    "requirements, then entities, relationships, attributes and (min,max) constraints.",
    `Model file: ${input.modelPath}`,
    ...rules(input.modelPath, input.lintCommand),
    "- Never write coordinates or layout; the viewer lays the model out.",
    "- Implement the requirements to apply now. Keep elements that other requirements still need; change them only when a",
    "  requirement to apply now requires it.",
    "",
    "Requirements to apply now (new or changed since the last apply):",
    ...input.apply.map((r) => `${line(r)}${r.changed ? `  [changed${r.trace?.length ? `; it was linked to ${r.trace.join(", ")}` : ""}]` : "  [new]"}`),
    "",
    "All requirements, for context:",
    ...input.all.map(line),
    "",
    "Element ids: E:<Entity>, R:<Relationship>, A:<Owner>.<attribute> (A:<Owner>.<attribute>.<part> for composite parts),",
    "using the names in the YAML file.",
    "Reply with one or two plain sentences describing what changed. Then end the reply with a fenced block tagged",
    "chen-trace that maps every requirement id applied now to the element ids that implement it, plus a one-line why:",
    "```chen-trace",
    JSON.stringify(example),
    "```",
  ].join("\n");
}

/**
 * Tools pre-approved for a headless turn: exactly what the prompt asks the agent to run.
 * `--permission-mode acceptEdits` covers Edit/Write but not Bash or MCP tools, which would otherwise wait for a
 * permission answer that never comes in `-p` mode. Claude Code rule syntax: `Bash(<command prefix>:*)` allows that
 * command with any trailing arguments (here: the model path); MCP tools are `mcp__<server>__<tool>`.
 * The Bash rule is built from the same `lintCommand` string the prompt shows, so the two cannot drift.
 */
export function allowedTools(lintCommand: string): string[] {
  return [`Bash(${lintCommand}:*)`, "mcp__chen-er__lint_er", "mcp__chen-er__render_er"];
}

/**
 * `claude --help`: `--allowedTools, --allowed-tools <tools...>` takes a variadic list, so it is followed by another
 * flag (`--add-dir`) to end the list. Each rule is its own argv element; spaces inside `Bash(...)` stay in the rule.
 */
export function claudeArgs(prompt: string, modelDir: string, lintCommand: string, sessionId?: string): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--allowedTools", ...allowedTools(lintCommand),
    "--add-dir", modelDir, ...(sessionId ? ["--resume", sessionId] : [])];
}

/**
 * `codex exec --help` (codex-cli 0.160): `--json` prints thread events as JSONL; `--sandbox workspace-write` lets the
 * agent write inside `--cd` and every `--add-dir` (the model's directory) and run commands without network, and exec
 * never asks for approval, so a turn cannot stall on a prompt. `--skip-git-repo-check` allows model folders outside
 * a git repository. A follow-up turn uses `exec resume <thread id> <prompt>`; `resume` accepts neither `--sandbox`
 * nor `--cd`, so the exec-level options come before the subcommand. stdin must be closed (the runner spawns with
 * stdin ignored), otherwise codex waits for more prompt input.
 */
export function codexArgs(prompt: string, cwd: string, modelDir: string, sessionId?: string): string[] {
  return ["exec", "--json", "--sandbox", "workspace-write", "--cd", cwd, "--add-dir", modelDir, "--skip-git-repo-check",
    ...(sessionId ? ["resume", sessionId] : []), prompt];
}
