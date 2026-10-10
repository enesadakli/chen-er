// Agent thread persistence: `<model>.er.agent.json` next to the model, so a restarted `chen serve --agent` keeps its
// thread, resumes the agent session and can still undo the latest change. Never holds the URL token.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ChangeSet } from "./agent-changes.js";
import type { AgentKind, ErrorKind } from "./agent-runner.js";
import type { Step } from "./agent-stream.js";

export type TurnStatus = "running" | "ok" | "error" | "cancelled" | "limit" | "undone";
/** Machine state of one requirement before an apply wrote it, so Undo can put it back. */
export interface RequirementMark { applied?: string; trace?: string[]; why?: string }
/** A requirements apply turn (docs/requirements.md). */
export interface TurnRequirements {
  /** Stable ids processed by this turn, with their R-number labels and text hashes at the start. */
  ids: string[];
  labels: string[];
  hashes: string[];
  /** Validated trace per id, set when the turn finished ok. */
  trace?: Record<string, { elements: string[]; why?: string; dropped?: string[] }>;
  /** True when the reply had no readable trace block. */
  noTrace?: boolean;
  /** State of each id before this turn wrote it (for Undo). */
  before?: Record<string, RequirementMark>;
}
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
  /** Machine-readable cause when status is "error" or "limit". */
  errorKind?: ErrorKind;
  /** Why the server ended the turn itself, e.g. it stopped while the turn was running. */
  notice?: string;
  requirements?: TurnRequirements;
}

/** One turn plus its model revisions (sha256 of the bytes, or "absent"). `before` holds the bytes only while
 * they may still be needed for undo. */
export interface StoredEntry { turn: Turn; beforeRevision: string; afterRevision?: string; before?: string | null }
export interface StoredThread { version: 1; model: string; kind: AgentKind; sessionId?: string; entries: StoredEntry[] }

/** `club.er.yaml` → `club.er.agent.json`, the same way as the layout file name. Ignore with `*.er.agent.json`. */
export const agentStatePathFor = (modelPath: string): string => modelPath.replace(/(\.er)?\.ya?ml$/i, "") + ".er.agent.json";

const STATUSES = new Set<TurnStatus>(["running", "ok", "error", "cancelled", "limit", "undone"]);
const ERROR_KINDS = new Set<ErrorKind>(["not-found", "not-logged-in", "limit", "other"]);
const REVISION = /^(absent|[0-9a-f]{64})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const optional = (value: unknown, test: (v: unknown) => boolean) => value === undefined || test(value);

function validTurn(value: unknown): value is Turn {
  if (!isRecord(value)) return false;
  const t = value;
  const changes = t.changes;
  return isString(t.id) && /^[\w-]{1,64}$/.test(t.id) && isString(t.text) && strings(t.selection) && isString(t.startedAt)
    && STATUSES.has(t.status as TurnStatus) && Array.isArray(t.steps)
    && t.steps.every((s) => isRecord(s) && (s.kind === "tool" || s.kind === "text") && isString(s.summary))
    && optional(t.finishedAt, isString) && optional(t.reply, isString) && optional(t.error, isString) && optional(t.notice, isString)
    && optional(t.errorKind, (k) => ERROR_KINDS.has(k as ErrorKind))
    && optional(changes, (c) => isRecord(c) && strings(c.added) && strings(c.removed) && strings(c.modified) && optional(c.parseError, (p) => typeof p === "boolean"))
    && optional(t.requirements, validRequirements);
}

function validRequirements(value: unknown): boolean {
  if (!isRecord(value) || !strings(value.ids) || !strings(value.labels) || !strings(value.hashes)) return false;
  if (value.labels.length !== value.ids.length || value.hashes.length !== value.ids.length) return false;
  const marks = (v: unknown, test: (m: Record<string, unknown>) => boolean) => isRecord(v) && Object.values(v).every((m) => isRecord(m) && test(m));
  return optional(value.noTrace, (n) => typeof n === "boolean")
    && optional(value.trace, (v) => marks(v, (m) => strings(m.elements) && optional(m.why, isString) && optional(m.dropped, strings)))
    && optional(value.before, (v) => marks(v, (m) => optional(m.applied, isString) && optional(m.trace, strings) && optional(m.why, isString)));
}

/** Parses a stored thread; undefined when it is malformed or belongs to another model or agent kind. */
export function parseThread(text: string, model: string, kind: AgentKind): StoredThread | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || value.version !== 1 || value.model !== model || value.kind !== kind) return undefined;
  if (!optional(value.sessionId, isString) || !Array.isArray(value.entries)) return undefined;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || !validTurn(entry.turn) || ids.has(entry.turn.id)) return undefined;
    ids.add(entry.turn.id);
    if (!isString(entry.beforeRevision) || !REVISION.test(entry.beforeRevision)) return undefined;
    if (!optional(entry.afterRevision, (r) => isString(r) && REVISION.test(r))) return undefined;
    if (!optional(entry.before, (b) => b === null || (isString(b) && /^[A-Za-z0-9+/]*={0,2}$/.test(b)))) return undefined;
  }
  return value as unknown as StoredThread;
}

/** Reads the thread file if it is a regular file; any problem means "no stored thread". */
export function readThread(path: string, model: string, kind: AgentKind): StoredThread | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return parseThread(readFileSync(path, "utf8"), model, kind);
  } catch { return undefined; }
}

/** Atomic write: a private temp file in the same directory, then rename over the target (a rename replaces a
 * symlink itself and never writes through it). */
export function writeThread(path: string, thread: StoredThread): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(thread, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
