// Parsers for the agents' JSON line streams: `claude -p --output-format stream-json` and `codex exec --json`.
// Unknown or malformed lines are ignored.
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
/** Parses one stdout line; a parser may keep state across the lines of one run. */
export type LineParser = (line: string) => StreamUpdate;

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

const parse = (line: string): Record<string, unknown> | undefined => { try { return record(JSON.parse(line)); } catch { return undefined; } };

export function parseStreamLine(line: string): StreamUpdate {
  const update: StreamUpdate = { steps: [] };
  const event = parse(line);
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

/** `/bin/zsh -lc 'npx tsx … lint m.yaml'` → `npx`: the first word of the command inside a shell wrapper. */
export function commandWord(command: string): string | undefined {
  const inner = /^\S*\/?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())?.[2] ?? command;
  return inner.trim().split(/\s+/)[0]?.split("/").at(-1) || undefined;
}

const CHANGE_VERB: Record<string, string> = { add: "Create", delete: "Delete", update: "Edit" };

/** Summary of one `codex exec --json` item, or undefined for items that are not steps (reasoning, plans). */
export function summarizeCodexItem(item: Record<string, unknown>): Step | undefined {
  switch (item.type) {
    case "command_execution": {
      const word = commandWord(text(item.command) ?? "");
      return { kind: "tool", summary: word ? `Shell ${clip(word, 60)}` : "Shell" };
    }
    case "file_change": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(record).filter((c) => c && text(c.path));
      const verbs = [...new Set(changes.map((c) => CHANGE_VERB[text(c!.kind) ?? ""] ?? "Edit"))];
      const files = [...new Set(changes.map((c) => basename(c!.path as string)))];
      return { kind: "tool", summary: clip(`${verbs.length === 1 ? verbs[0] : "Edit"}${files.length ? ` ${files.join(", ")}` : ""}`) };
    }
    case "mcp_tool_call": {
      const server = text(item.server), tool = text(item.tool);
      return { kind: "tool", summary: server && tool ? `mcp__${server}__${tool}` : tool ?? "MCP tool" };
    }
    case "web_search": return { kind: "tool", summary: "Web search" };
    case "error": return text(item.message)?.trim() ? { kind: "text", summary: clip(item.message as string) } : undefined;
    default: return undefined;
  }
}

/**
 * Parser for `codex exec --json` (JSONL thread events). Tool items become a step when first seen, so a running
 * command shows up at `item.started`; agent messages become a step when completed. A top-level `error` or
 * `turn.failed` marks the result as an error; a later `turn.completed` clears it (codex reports retried stream
 * errors the same way).
 */
export function codexParser(): LineParser {
  const seen = new Set<string>();
  return (line) => {
    const update: StreamUpdate = { steps: [] };
    const event = parse(line);
    if (!event) return update;
    const type = text(event.type);
    if (type === "thread.started" && text(event.thread_id)) update.sessionId = event.thread_id as string;
    else if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = record(event.item);
      if (!item) return update;
      const id = text(item.id);
      if (item.type === "agent_message") {
        const message = text(item.text)?.trim();
        if (type === "item.completed" && message && !(id && seen.has(id))) {
          if (id) seen.add(id);
          update.lastText = message;
          update.steps.push({ kind: "text", summary: clip(message) });
        }
        return update;
      }
      if (id && seen.has(id)) return update;
      const step = summarizeCodexItem(item);
      if (step && (step.kind === "tool" || type === "item.completed")) {
        if (id) seen.add(id);
        update.steps.push(step);
      }
    } else if (type === "error") update.result = { text: text(event.message) ?? "", isError: true };
    else if (type === "turn.failed") update.result = { text: text(record(event.error)?.message) ?? text(event.message) ?? "", isError: true };
    else if (type === "turn.completed") update.result = { text: "", isError: false };
    return update;
  };
}
