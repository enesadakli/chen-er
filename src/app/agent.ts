// Agent panel controller: turns, snapshots, change sets and undo. HTTP lives in serve.ts.
import { dirname, extname } from "node:path";
import { changeSet, type ChangeSet } from "./agent-changes.js";
import { buildPrompt, claudeArgs, selectionLabels } from "./agent-prompt.js";
import { runAgent, type RunHandle, type RunOutcome } from "./agent-runner.js";
import { clip, type Step } from "./agent-stream.js";
import { fileBytes, revision } from "./file-guard.js";

export type AgentKind = "claude";
export type TurnStatus = "running" | "ok" | "error" | "cancelled" | "limit" | "undone";
export interface Turn {
  id: string;
  text: string;
  selection: string[];
  startedAt: string;
  finishedAt?: string;
  status: TurnStatus;
  reply?: string;
  steps: Step[];
  changes?: ChangeSet;
  error?: string;
}
export interface AgentInfo { enabled: true; kind: AgentKind; cwd: string; running: string | null; turns: Turn[] }

export class AgentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface AgentDeps {
  kind: AgentKind;
  cwd: string;
  modelPath: string;
  layoutPath: string;
  bin: string;
  lintCommand: string;
  emit(turn: Turn): void;
  /** Atomically replace the model bytes `expected` with `next`, serialized with other server writes. */
  writeModel(expected: Buffer | null, next: Buffer | null): Promise<void>;
  /** Same for the layout file; used only to revert a layout file the agent changed. */
  writeLayout(expected: Buffer | null, next: Buffer | null): Promise<void>;
  /** True when these layout bytes are the server's own last write. */
  isServerLayout(bytes: Buffer | null): boolean;
  /** Called once a turn has settled, so the server can save positions it skipped during the turn. */
  afterTurn?(modelChanged: boolean): void;
  killAfterMs?: number;
}

interface Entry { turn: Turn; before: Buffer | null; after?: Buffer | null }

export const MAX_TEXT = 4000;
export const MAX_SELECTION = 20;

/** Validates a POST /api/agent/turns body. */
export function parseTurnRequest(value: Record<string, unknown>): { text: string; selection: string[] } {
  if (Object.keys(value).some((key) => key !== "text" && key !== "selection")) throw new AgentError(400, "Unexpected field.");
  const { text, selection = [] } = value;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw new AgentError(400, `Text must have 1 to ${MAX_TEXT} characters.`);
  if (!Array.isArray(selection) || selection.length > MAX_SELECTION
    || selection.some((id) => typeof id !== "string" || !id || id.length > 200)) {
    throw new AgentError(400, `Selection must be at most ${MAX_SELECTION} node ids.`);
  }
  return { text, selection: [...new Set(selection as string[])] };
}

/** Node runs script paths directly so tests and wrappers need no executable bit. */
export function agentCommand(bin: string, args: string[]): { bin: string; args: string[] } {
  return [".js", ".mjs", ".cjs"].includes(extname(bin)) ? { bin: process.execPath, args: [bin, ...args] } : { bin, args };
}

const changed = (entry: Entry): boolean => entry.after !== undefined && revision(entry.after) !== revision(entry.before);

export function createAgent(deps: AgentDeps) {
  const entries: Entry[] = [];
  let sessionId: string | undefined;
  let running: { entry: Entry; handle: RunHandle; finished: Promise<void> } | undefined;
  let undoing = false;
  let counter = 0;
  const find = (id: string): Entry => {
    const entry = entries.find((e) => e.turn.id === id);
    if (!entry) throw new AgentError(404, "Unknown turn.");
    return entry;
  };

  async function finish(entry: Entry, layoutBefore: Buffer | null, outcome: RunOutcome): Promise<void> {
    const { turn } = entry;
    if (outcome.sessionId) sessionId = outcome.sessionId;
    entry.after = fileBytes(deps.modelPath);
    turn.changes = changed(entry)
      ? changeSet(entry.before?.toString("utf8") ?? null, entry.after?.toString("utf8") ?? null)
      : { added: [], removed: [], modified: [] };
    const layout = fileBytes(deps.layoutPath);
    if (revision(layout) !== revision(layoutBefore) && !deps.isServerLayout(layout)) {
      // Pins and positions belong to the person; revert an agent write to the layout file.
      try {
        await deps.writeLayout(layout, layoutBefore);
        turn.steps.push({ kind: "text", summary: "Reverted a change to the layout file; the agent must not edit it." });
      } catch { /* the file moved on again; leave it */ }
    }
    turn.status = outcome.status;
    if (outcome.reply) turn.reply = outcome.reply;
    if (outcome.error) turn.error = outcome.error;
    const last = turn.steps.at(-1);
    if (turn.reply && last?.kind === "text" && last.summary === clip(turn.reply)) turn.steps.pop();
    turn.finishedAt = new Date().toISOString();
    running = undefined;
    deps.emit(turn);
    deps.afterTurn?.(changed(entry));
  }

  return {
    info(): AgentInfo {
      return { enabled: true, kind: deps.kind, cwd: deps.cwd, running: running?.entry.turn.id ?? null, turns: entries.map((e) => e.turn) };
    },
    start(request: { text: string; selection: string[] }): string {
      if (running) throw new AgentError(409, "A turn is already running.");
      if (undoing) throw new AgentError(409, "An undo is in progress.");
      const before = fileBytes(deps.modelPath);
      const layoutBefore = fileBytes(deps.layoutPath);
      const turn: Turn = { id: `t${++counter}`, text: request.text, selection: request.selection,
        startedAt: new Date().toISOString(), status: "running", steps: [] };
      const entry: Entry = { turn, before };
      const prompt = buildPrompt({ modelPath: deps.modelPath, lintCommand: deps.lintCommand,
        selection: selectionLabels(before?.toString("utf8") ?? null, request.selection), text: request.text });
      const command = agentCommand(deps.bin, claudeArgs(prompt, dirname(deps.modelPath), sessionId));
      const handle = runAgent({ ...command, cwd: deps.cwd, killAfterMs: deps.killAfterMs,
        onStep: (step) => { turn.steps.push(step); deps.emit(turn); } });
      entries.push(entry);
      const finished = handle.done.then((outcome) => finish(entry, layoutBefore, outcome));
      running = { entry, handle, finished };
      deps.emit(turn);
      return turn.id;
    },
    async cancel(id: string): Promise<{ status: TurnStatus }> {
      const entry = find(id);
      if (running?.entry === entry) {
        const { handle, finished } = running;
        await handle.cancel();
        await finished;
      }
      return { status: entry.turn.status };
    },
    async undo(id: string): Promise<{ status: "undone" }> {
      const entry = find(id);
      if (running) throw new AgentError(409, "Wait for the running turn to finish.");
      if (undoing) throw new AgentError(409, "An undo is in progress.");
      if (entry.turn.status === "undone") throw new AgentError(409, "This turn was already undone.");
      if (!changed(entry)) throw new AgentError(409, "This turn did not change the model.");
      if (entry.before === null) throw new AgentError(409, "No model snapshot exists for this turn.");
      if (entries.findLast(changed) !== entry) throw new AgentError(409, "Only the most recent agent change can be undone.");
      if (revision(fileBytes(deps.modelPath)) !== revision(entry.after ?? null)) throw new AgentError(409, "The model changed after this turn.");
      undoing = true;
      try { await deps.writeModel(entry.after ?? null, entry.before); }
      finally { undoing = false; }
      entry.turn.status = "undone";
      deps.emit(entry.turn);
      return { status: "undone" };
    },
    async close(): Promise<void> {
      if (running) { const { handle, finished } = running; await handle.cancel(); await finished; }
    },
  };
}
export type AgentController = ReturnType<typeof createAgent>;
