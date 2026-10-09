/** Pure agent-panel logic: no DOM, no fetch. Contract: docs/agent-panel.md. */

export type TurnStatus = "running" | "ok" | "error" | "cancelled" | "limit" | "undone";
export type ErrorKind = "not-found" | "not-logged-in" | "limit" | "other";
export interface Step { kind: "tool" | "text"; summary: string }
export interface Changes { added: string[]; removed: string[]; modified: string[]; parseError?: boolean }
export interface Turn {
  id: string;
  text: string;
  selection: string[];
  startedAt: string;
  finishedAt?: string;
  status: TurnStatus;
  reply?: string;
  steps: Step[];
  changes?: Changes;
  error?: string;
  errorKind?: ErrorKind;
}
export interface AgentInfo { enabled: boolean; kind: string; cwd: string; running: string | null; turns: Turn[] }
export interface ThreadState { turns: Turn[]; running: string | null }

export const MAX_TEXT = 4000;
export const MAX_SELECTION = 20;
export const EXAMPLES = [
  "Add a BirthDate attribute to the selected entity",
  "Make ENROLLS one-to-many",
  "Explain the heuristic findings",
] as const;

export function agentName(kind: string | undefined): string {
  if (kind === "codex") return "Codex";
  if (kind === "claude" || !kind) return "Claude";
  return kind[0]!.toUpperCase() + kind.slice(1);
}

const finished = (turn: Turn) => turn.status !== "running";
const order = (a: Turn, b: Turn) => Date.parse(a.startedAt) - Date.parse(b.startedAt);

/** Replace the whole thread (GET /api/agent). */
export function loadThread(info: Pick<AgentInfo, "turns" | "running">): ThreadState {
  return { turns: [...info.turns].sort(order), running: info.running };
}

/**
 * Apply one `agent-turn` event (the full Turn). Events can arrive out of order across a reconnect,
 * so a running snapshot never overwrites a turn that is already finished.
 */
export function applyTurn(state: ThreadState, turn: Turn): ThreadState {
  const index = state.turns.findIndex((t) => t.id === turn.id);
  const existing = index >= 0 ? state.turns[index] : undefined;
  if (existing && finished(existing) && !finished(turn)) return state;
  const turns = existing ? state.turns.map((t, i) => i === index ? turn : t) : [...state.turns, turn].sort(order);
  const running = turn.status === "running" ? turn.id : state.running === turn.id ? null : state.running;
  return { turns, running };
}

export function changed(changes: Changes | undefined): boolean {
  return !!changes && (!!changes.parseError || changes.added.length + changes.removed.length + changes.modified.length > 0);
}

/** The turn that may offer Undo: the latest model-changing turn, only while its status is ok. */
export function undoableTurn(turns: readonly Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.status === "running") continue;
    if (!changed(turn.changes) || (turn.status !== "ok" && turn.status !== "undone")) continue;
    return turn.status === "ok" ? turn.id : undefined;
  }
  return undefined;
}

/** Readable name for a node id. Attributes read `BirthDate (STUDENT)`; unknown ids fall back to the id itself. */
export function labelFor(id: string, known: ReadonlyMap<string, string> = new Map()): string {
  const label = known.get(id);
  const kind = id.slice(0, 2);
  const path = id.slice(2);
  if (kind === "A:") {
    const parts = path.split(".");
    const owner = parts[0]!;
    const name = label ?? parts[parts.length - 1]!;
    return `${name} (${known.get(`E:${owner}`) ?? known.get(`R:${owner}`) ?? owner})`;
  }
  if (label) return label;
  return kind === "E:" || kind === "R:" ? path : id;
}

export interface ChangeLine { sign: "+" | "~" | "-"; id: string; text: string; linkable: boolean }
/** Change note lines in a stable order: added, modified, removed; each group sorted by label. */
export function changeNote(changes: Changes | undefined, known: ReadonlyMap<string, string> = new Map()): ChangeLine[] {
  if (!changes || changes.parseError) return [];
  const group = (ids: string[], sign: ChangeLine["sign"], linkable: boolean) => ids
    .map((id) => ({ sign, id, text: labelFor(id, known), linkable }))
    .sort((a, b) => a.text.localeCompare(b.text));
  return [...group(changes.added, "+", true), ...group(changes.modified, "~", true), ...group(changes.removed, "-", false)];
}
export function changeNoteText(lines: readonly ChangeLine[]): string {
  return lines.map((l) => `${l.sign} ${l.text}`).join("\n");
}

/** Ids worth a brief halo after a turn: what now exists and changed. */
export function flashIds(turn: Turn): string[] {
  const c = turn.changes;
  if (!c || c.parseError) return [];
  return turn.status === "undone" ? [...c.removed, ...c.modified] : [...c.added, ...c.modified];
}

/**
 * Context chips mirror the current canvas selection. × dismisses the chip for that selection only; selecting
 * something else shows a chip again. The list shape leaves room for multi-select later.
 */
export function selectionChips(selected: string | undefined, dismissed: string | undefined): string[] {
  return selected && selected !== dismissed ? [selected].slice(0, MAX_SELECTION) : [];
}

export function elapsedSeconds(startedAt: string, now: number): number {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
}

export type Outcome =
  | { kind: "ok"; message?: string }
  | { kind: "missing" | "login" | "limit" | "cancelled" | "undone" | "parse"; message: string }
  | { kind: "error"; message: string; detail?: string };

/** What a finished turn says beyond the reply and change note. */
export function outcome(turn: Turn, kind = "claude"): Outcome | undefined {
  const name = agentName(kind);
  const cli = kind === "codex" ? "codex" : "claude";
  const product = kind === "codex" ? "Codex CLI" : "Claude Code";
  switch (turn.status) {
    case "running": return undefined;
    case "cancelled": return { kind: "cancelled", message: "Cancelled." };
    case "undone": return { kind: "undone", message: "Undone. The model is back to how it was before this request." };
    case "limit": return { kind: "limit", message: `${name} hit its usage limit. Try again after the limit resets.` };
    case "error": {
      const detail = turn.error?.trim() || undefined;
      const text = detail ?? "";
      // The server's errorKind decides; the text heuristics only cover servers that do not send it.
      const missing = turn.errorKind ? turn.errorKind === "not-found"
        : /ENOENT|command not found|not found in PATH|spawn \S+ ENOENT|is not recognized/i.test(text);
      const login = turn.errorKind ? turn.errorKind === "not-logged-in"
        : /not logged in|please log ?in|\/login|unauthori[sz]ed|authentication|invalid api key/i.test(text);
      if (missing) {
        return { kind: "missing", message: `${product} was not found. Install it, run \`${cli}\` once in a terminal, then \`/login\`.` };
      }
      if (login) {
        return { kind: "login", message: `${name} is not logged in. Run \`${cli}\` in a terminal, then \`/login\`.` };
      }
      return { kind: "error", message: `${name} stopped with an error.`, ...(detail ? { detail } : {}) };
    }
    case "ok":
      if (turn.changes?.parseError) return { kind: "parse", message: "The model no longer parses. The findings in Notes show where." };
      return changed(turn.changes) ? { kind: "ok" } : { kind: "ok", message: "No changes to the model." };
  }
}

/** Read the one-time token from `?t=` and return the address without it. */
export function takeToken(href: string, stored: string | null): { token: string | null; cleanHref?: string } {
  const url = new URL(href);
  const fromUrl = url.searchParams.get("t");
  if (fromUrl === null) return { token: stored };
  url.searchParams.delete("t");
  return { token: fromUrl || stored, cleanHref: `${url.pathname}${url.search}${url.hash}` };
}

/** Keyboard decision for the composer: Enter sends, Shift+Enter keeps a newline, IME composition is untouched. */
export function composerKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): "send" | "none" {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.altKey) return "none";
  return "send";
}

export function canSend(text: string, running: string | null): boolean {
  const trimmed = text.trim();
  return !running && trimmed.length > 0 && trimmed.length <= MAX_TEXT;
}
