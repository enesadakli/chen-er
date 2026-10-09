// Parser for `claude -p --output-format stream-json` lines. Unknown or malformed lines are ignored.
import { basename } from "node:path";

export interface Step { kind: "tool" | "text"; summary: string }
export interface StreamUpdate {
  sessionId?: string;
  steps: Step[];
  /** Full text of the last assistant text block in this line. */
  lastText?: string;
  /** Final `result` event: the reply text and whether the CLI flagged it as an error. */
  result?: { text: string; isError: boolean };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export const clip = (value: string, max = 200): string => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function summarizeTool(name: string, input: unknown): string {
  const args = record(input) ?? {};
  const file = text(args.file_path) ?? text(args.notebook_path) ?? text(args.path);
  if (name === "Bash") {
    const word = text(args.command)?.trim().split(/\s+/)[0];
    return word ? `Bash ${clip(word, 60)}` : "Bash";
  }
  return file ? `${name} ${basename(file)}` : name;
}

export function parseStreamLine(line: string): StreamUpdate {
  const update: StreamUpdate = { steps: [] };
  let event: Record<string, unknown> | undefined;
  try { event = record(JSON.parse(line)); } catch { return update; }
  if (!event) return update;
  const session = text(event.session_id);
  if (session) update.sessionId = session;
  if (event.type === "assistant") {
    const content = record(event.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const item = record(block);
      if (item?.type === "tool_use" && text(item.name)) update.steps.push({ kind: "tool", summary: summarizeTool(item.name as string, item.input) });
      else if (item?.type === "text" && text(item.text)?.trim()) {
        update.lastText = (item.text as string).trim();
        update.steps.push({ kind: "text", summary: clip(update.lastText) });
      }
    }
  } else if (event.type === "result") {
    update.result = { text: text(event.result) ?? "", isError: event.is_error === true || (text(event.subtype) ?? "success") !== "success" };
  }
  return update;
}
