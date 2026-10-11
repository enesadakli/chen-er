// Agent panel controller: turns, snapshots, change sets, undo and the stored thread. HTTP lives in serve.ts.
import { dirname, extname } from "node:path";
import { changeSet } from "./agent-changes.js";
import { buildPrompt, claudeArgs, codexArgs, selectionLabels } from "./agent-prompt.js";
import { runAgent, type AgentKind, type RunHandle, type RunOutcome } from "./agent-runner.js";
import { readThread, writeThread, type StoredThread, type Turn, type TurnRequirements, type TurnStatus } from "./agent-store.js";
import { clip } from "./agent-stream.js";
import { fileBytes, revision } from "./file-guard.js";

export type { AgentKind } from "./agent-runner.js";
export type { Turn, TurnStatus, TurnRequirements } from "./agent-store.js";
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
  /** Called after Undo restored the model for a turn (requirements applies put their line state back). */
  onUndo?(turn: Turn): Promise<void>;
  /** Thread file (`<model>.er.agent.json`); without it the thread lives only in memory. */
  statePath?: string;
  killAfterMs?: number;
}

/** `before` holds the pre-turn model bytes (null: no model file) while they may be needed for undo; revisions
 * outlive it, so a restored thread still knows which turns changed the model. */
interface Entry { turn: Turn; beforeRevision: string; afterRevision?: string; before?: Buffer | null }

/** A turn with its own prompt instead of a chat request (requirements apply). */
export interface TurnPlan {
  prompt: string;
  requirements?: TurnRequirements;
  /** Runs once the agent has finished, before the final event: may rewrite the reply and the requirements state. */
  settle?(turn: Turn): Promise<void>;
}

export const INTERRUPTED = "The server stopped while this request was running, so it was cancelled. Changes are measured against the model as found at restart.";

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

const changed = (entry: Entry): boolean => entry.afterRevision !== undefined && entry.afterRevision !== entry.beforeRevision;

export function createAgent(deps: AgentDeps) {
  const entries: Entry[] = [];
  let sessionId: string | undefined;
  let running: { entry: Entry; handle: RunHandle; finished: Promise<void>; plan?: TurnPlan } | undefined;
  let undoing = false;
  let counter = 0;
  let warned = false;
  const find = (id: string): Entry => {
    const entry = entries.find((e) => e.turn.id === id);
    if (!entry) throw new AgentError(404, "Unknown turn.");
    return entry;
  };

  /** Writes the thread file. Snapshot bytes are kept only for the latest model-changing turn and a running turn. */
  function save(): void {
    const keep = new Set([entries.findLast(changed), running?.entry]);
    for (const entry of entries) if (!keep.has(entry)) delete entry.before;
    if (!deps.statePath) return;
    const thread: StoredThread = { version: 1, model: deps.modelPath, kind: deps.kind, ...(sessionId ? { sessionId } : {}),
      entries: entries.map((e) => ({ turn: e.turn, beforeRevision: e.beforeRevision,
        ...(e.afterRevision ? { afterRevision: e.afterRevision } : {}),
        ...(e.before !== undefined ? { before: e.before === null ? null : e.before.toString("base64") } : {}) })) };
    try { writeThread(deps.statePath, thread); }
    catch (error) {
      if (!warned) console.error(`The agent thread was not saved to ${deps.statePath}: ${(error as Error).message}`);
      warned = true;
    }
  }
  const emit = (turn: Turn): void => { save(); deps.emit(turn); };
  /** Measures the model after a turn: its revision and the change set against the snapshot. */
  function measure(entry: Entry): void {
    const after = fileBytes(deps.modelPath);
    entry.afterRevision = revision(after);
    entry.turn.changes = !changed(entry) ? { added: [], removed: [], modified: [] }
      : entry.before === undefined ? { added: [], removed: [], modified: [], parseError: true }
        : changeSet(entry.before?.toString("utf8") ?? null, after?.toString("utf8") ?? null);
  }

  const stored = deps.statePath ? readThread(deps.statePath, deps.modelPath, deps.kind) : undefined;
  if (stored) {
    sessionId = stored.sessionId;
    let interrupted = false;
    for (const item of stored.entries) {
      const entry: Entry = { turn: item.turn, beforeRevision: item.beforeRevision,
        ...(item.afterRevision ? { afterRevision: item.afterRevision } : {}),
        ...(item.before !== undefined ? { before: item.before === null ? null : Buffer.from(item.before, "base64") } : {}) };
      if (entry.turn.status === "running") {
        // The process died mid-turn: the agent is gone, so the turn ends here, measured against the model as it is now.
        measure(entry);
        interrupted = true;
        Object.assign(entry.turn, { status: "cancelled", notice: INTERRUPTED, finishedAt: new Date().toISOString() });
      }
      entries.push(entry);
      counter = Math.max(counter, Number(/^t(\d+)$/.exec(entry.turn.id)?.[1] ?? 0));
    }
    if (interrupted) save();
  }

  async function finish(entry: Entry, layoutBefore: Buffer | null, outcome: RunOutcome): Promise<void> {
    const { turn } = entry;
    if (outcome.sessionId) sessionId = outcome.sessionId;
    measure(entry);
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
    if (outcome.errorKind) turn.errorKind = outcome.errorKind;
    const last = turn.steps.at(-1);
    if (turn.reply && last?.kind === "text" && last.summary === clip(turn.reply)) turn.steps.pop();
    const plan = running?.entry === entry ? running.plan : undefined;
    if (plan?.settle) {
      try { await plan.settle(turn); }
      catch (error) { turn.steps.push({ kind: "text", summary: clip(`The requirements file was not updated: ${(error as Error).message}`) }); }
    }
    turn.finishedAt = new Date().toISOString();
    running = undefined;
    emit(turn);
    deps.afterTurn?.(changed(entry));
  }

  return {
    info(): AgentInfo {
      return { enabled: true, kind: deps.kind, cwd: deps.cwd, running: running?.entry.turn.id ?? null, turns: entries.map((e) => e.turn) };
    },
    start(request: { text: string; selection: string[] }, plan?: TurnPlan): string {
      if (running) throw new AgentError(409, "A turn is already running.");
      if (undoing) throw new AgentError(409, "An undo is in progress.");
      const before = fileBytes(deps.modelPath);
      const layoutBefore = fileBytes(deps.layoutPath);
      const turn: Turn = { id: `t${++counter}`, text: request.text, selection: request.selection,
        startedAt: new Date().toISOString(), status: "running", steps: [], ...(plan?.requirements ? { requirements: plan.requirements } : {}) };
      const entry: Entry = { turn, beforeRevision: revision(before), before };
      const prompt = plan?.prompt ?? buildPrompt({ modelPath: deps.modelPath, lintCommand: deps.lintCommand,
        selection: selectionLabels(before?.toString("utf8") ?? null, request.selection), text: request.text });
      const modelDir = dirname(deps.modelPath);
      const args = deps.kind === "codex" ? codexArgs(prompt, deps.cwd, modelDir, sessionId) : claudeArgs(prompt, modelDir, deps.lintCommand, sessionId);
      const handle = runAgent({ ...agentCommand(deps.bin, args), kind: deps.kind, cwd: deps.cwd, killAfterMs: deps.killAfterMs,
        onStep: (step) => { turn.steps.push(step); emit(turn); } });
      entries.push(entry);
      const finished = handle.done.then((outcome) => finish(entry, layoutBefore, outcome));
      running = { entry, handle, finished, ...(plan ? { plan } : {}) };
      emit(turn);
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
      if (entries.findLast(changed) !== entry) throw new AgentError(409, "Only the most recent agent change can be undone.");
      if (entry.before === undefined || entry.before === null) throw new AgentError(409, "No model snapshot exists for this turn.");
      const current = fileBytes(deps.modelPath);
      if (revision(current) !== entry.afterRevision) throw new AgentError(409, "The model changed after this turn.");
      undoing = true;
      try { await deps.writeModel(current, entry.before); }
      finally { undoing = false; }
      entry.turn.status = "undone";
      if (deps.onUndo) {
        try { await deps.onUndo(entry.turn); }
        catch (error) { entry.turn.steps.push({ kind: "text", summary: clip(`The requirements file was not reverted: ${(error as Error).message}`) }); }
      }
      emit(entry.turn);
      return { status: "undone" };
    },
    async close(): Promise<void> {
      if (running) { const { handle, finished } = running; await handle.cancel(); await finished; }
    },
  };
}
export type AgentController = ReturnType<typeof createAgent>;
