// Prompt and command line for one agent turn.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { flattenAttrs, parseModel } from "../core/normalize.js";

export interface SelectedNode { id: string; label?: string }

const quote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** How this process was started, so the agent can run the same CLI's `lint`. */
export function lintCommandFor(script: string | undefined, root: string): string {
  if (script && /[\\/]src[\\/]cli[\\/]index\.ts$/.test(script)) return `npx tsx ${quote(resolve(script))} lint`;
  if (script && /([\\/]bin[\\/]chen(\.js)?|[\\/]dist[\\/]cli[\\/]index\.js)$/.test(script)) return `node ${quote(resolve(script))} lint`;
  // Embedded use (tests, other hosts): fall back to this checkout or package.
  const source = join(root, "src/cli/index.ts");
  return existsSync(source) && !existsSync(join(root, "dist/cli/index.js"))
    ? `npx tsx ${quote(source)} lint`
    : `node ${quote(join(root, "bin/chen.js"))} lint`;
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

export function buildPrompt(input: { modelPath: string; lintCommand: string; selection: readonly SelectedNode[]; text: string }): string {
  const selected = input.selection.length
    ? input.selection.map((s) => s.label ? `${s.id} (${s.label})` : s.id)
    : ["(none)"];
  return [
    "You edit a Chen ER model for the chen-er viewer.",
    `Model file: ${input.modelPath}`,
    "Selected elements:",
    ...selected,
    "Rules:",
    "- Edit only that YAML file.",
    "- Keep its comments and formatting.",
    `- After editing, run \`${input.lintCommand} ${quote(input.modelPath)}\` and fix any errors.`,
    "- Never edit *.er.layout.json files.",
    "- Reply with one or two plain sentences describing what changed.",
    "",
    "Request:",
    input.text,
  ].join("\n");
}

export function claudeArgs(prompt: string, modelDir: string, sessionId?: string): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--add-dir", modelDir, ...(sessionId ? ["--resume", sessionId] : [])];
}
