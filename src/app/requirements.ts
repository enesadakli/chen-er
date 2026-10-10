// Requirements tab on the server: the `<model>.er.requirements.md` file next to the model (the viewer's only other
// write besides the layout file) and the plan for an apply turn. Contract: docs/requirements.md.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { flattenAttrs, parseModel } from "../core/normalize.js";
import {
  extractTrace, isRequirementId, MAX_REQUIREMENT_TEXT, MAX_REQUIREMENTS, normalizeText, ordinalLabel, parseRequirements,
  pendingRequirements, serializeRequirements, textHash, validateTrace, type Requirement, type RequirementsDoc,
} from "../core/requirements.js";
import { buildRequirementsPrompt } from "./agent-prompt.js";
import type { AgentKind } from "./agent-runner.js";
import type { RequirementMark, Turn, TurnRequirements } from "./agent-store.js";
import type { TurnPlan } from "./agent.js";
import { fileBytes, replaceBytes } from "./file-guard.js";

/** `club.er.yaml` → `club.er.requirements.md`, the same way as the layout and agent file names. */
export const requirementsPathFor = (modelPath: string): string => modelPath.replace(/(\.er)?\.ya?ml$/i, "") + ".er.requirements.md";

const MAX_BYTES = 1_048_576;

export class RequirementsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface RequirementsView {
  file: string;
  exists: boolean;
  /** sha256 over the ids and texts only: machine state (applied hash, trace) merges server-side and never conflicts. */
  revision: string;
  title?: string;
  items: Requirement[];
  /** Agent CLI when Apply is available (`chen serve --agent`), otherwise null. */
  agent: AgentKind | null;
}

export const textsRevision = (items: readonly Pick<Requirement, "id" | "text">[]): string =>
  createHash("sha256").update(JSON.stringify(items.map((i) => [i.id, normalizeText(i.text)]))).digest("hex");

/** Element ids and labels of a model text; empty when it does not parse. */
export function modelIndex(yaml: string | null): { ids: Set<string>; labels: Map<string, string>; title?: string } | undefined {
  const model = yaml === null ? undefined : parseModel(yaml).model;
  if (!model) return undefined;
  const ids = new Set<string>(), labels = new Map<string, string>();
  for (const owner of [...model.entities, ...model.relationships]) {
    ids.add(owner.id); labels.set(owner.id, owner.label);
    for (const a of flattenAttrs(owner.attrs)) { ids.add(a.id); labels.set(a.id, a.label); }
  }
  return { ids, labels, ...(model.title ? { title: model.title } : {}) };
}

/** Validates a PUT /api/requirements body. */
export function parseSaveRequest(value: Record<string, unknown>): { items: { id: string; text: string }[]; expectedRevision: string } {
  if (Object.keys(value).some((key) => key !== "items" && key !== "expectedRevision")) throw new RequirementsError(400, "Unexpected field.");
  if (typeof value.expectedRevision !== "string") throw new RequirementsError(400, "Expected revision is required.");
  if (!Array.isArray(value.items) || value.items.length > MAX_REQUIREMENTS) throw new RequirementsError(400, `Items must be a list of at most ${MAX_REQUIREMENTS} requirements.`);
  const seen = new Set<string>();
  const items = value.items.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new RequirementsError(400, "Each item needs an id and a text.");
    const { id, text, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) throw new RequirementsError(400, "Unexpected item field.");
    if (typeof id !== "string" || !isRequirementId(id) || seen.has(id)) throw new RequirementsError(400, "Requirement ids must be unique r<number> ids.");
    if (typeof text !== "string" || !normalizeText(text) || text.length > MAX_REQUIREMENT_TEXT) throw new RequirementsError(400, `Requirement text must have 1 to ${MAX_REQUIREMENT_TEXT} characters.`);
    seen.add(id);
    return { id, text: normalizeText(text) };
  });
  return { items, expectedRevision: value.expectedRevision };
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
function mark(item: Requirement): RequirementMark {
  return { ...(item.applied ? { applied: item.applied } : {}), ...(item.trace ? { trace: item.trace } : {}), ...(item.why ? { why: item.why } : {}) };
}
function setMark(item: Requirement, value: RequirementMark): void {
  delete item.applied; delete item.trace; delete item.why;
  Object.assign(item, value);
}

export interface RequirementsDeps {
  path: string;
  modelPath: string;
  agent: AgentKind | null;
  lintCommand: string;
  /** Serializes the write with the server's other file writes. */
  serial<T>(task: () => Promise<T>): Promise<T>;
  emit(view: RequirementsView): void;
}

export function createRequirements(deps: RequirementsDeps) {
  let seen: string | undefined;
  const file = basename(deps.path);
  const model = () => fileBytes(deps.modelPath)?.toString("utf8") ?? null;

  /** Reads the file: a regular file without links, at most 1 MB; absent means an empty list. */
  function read(): { doc: RequirementsDoc; bytes: Buffer | null } {
    let stat;
    try { stat = lstatSync(deps.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { doc: { items: [] }, bytes: null }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new RequirementsError(403, "The requirements path must be a regular file without links.");
    if (stat.size > MAX_BYTES) throw new RequirementsError(413, "The requirements file exceeds 1 MB.");
    const bytes = readFileSync(deps.path);
    return { doc: parseRequirements(bytes.toString("utf8")), bytes };
  }
  try { seen = read().bytes?.toString("utf8"); } catch { /* Reported when the viewer reads it. */ }
  const viewOf = (doc: RequirementsDoc, bytes: Buffer | null): RequirementsView => ({
    file, exists: bytes !== null, revision: textsRevision(doc.items), ...(doc.title ? { title: doc.title } : {}), items: doc.items, agent: deps.agent,
  });
  /** Writes `doc` over `bytes` atomically (temp file + rename in the same directory) and announces it. */
  function write(doc: RequirementsDoc, bytes: Buffer | null): RequirementsView {
    const text = serializeRequirements(doc, modelIndex(model())?.labels);
    if (bytes?.toString("utf8") !== text) replaceBytes(deps.path, bytes, Buffer.from(text));
    seen = text;
    const view = viewOf(doc, Buffer.from(text));
    deps.emit(view);
    return view;
  }

  return {
    path: deps.path,
    view(): RequirementsView { const { doc, bytes } = read(); return viewOf(doc, bytes); },

    /** PUT: the client owns ids and texts; applied hashes, traces and prose come from the current file. */
    save(value: Record<string, unknown>): Promise<RequirementsView> {
      const request = parseSaveRequest(value);
      return deps.serial(async () => {
        const { doc, bytes } = read();
        if (textsRevision(doc.items) !== request.expectedRevision) {
          throw new RequirementsError(409, "The requirements file changed outside the viewer. Load it again and retry.");
        }
        if (bytes === null && !request.items.length) return viewOf(doc, bytes);
        const old = new Map(doc.items.map((item) => [item.id, item]));
        const next: RequirementsDoc = { ...doc, title: doc.title ?? (modelIndex(model())?.title ? `Requirements: ${modelIndex(model())!.title}` : "Requirements"),
          items: request.items.map((item) => ({ ...mark(old.get(item.id) ?? { id: item.id, text: "" }), id: item.id, text: item.text })) };
        return write(next, bytes);
      });
    },

    /** Called by the file watcher; announces an outside edit (Obsidian, an editor) once. */
    check(): void {
      try {
        const { doc, bytes } = read();
        const text = bytes?.toString("utf8");
        if (text === seen) return;
        seen = text;
        deps.emit(viewOf(doc, bytes));
      } catch { /* A broken path is reported when the viewer reads it. */ }
    },

    /**
     * Plans one apply turn: only new or changed lines, the whole list as context. When the turn finishes ok, the
     * trace in the reply is validated against the model and written to the file; Undo puts the old state back.
     */
    plan(value: Record<string, unknown>): { text: string; plan: TurnPlan } {
      if (Object.keys(value).some((key) => key !== "expectedRevision")) throw new RequirementsError(400, "Unexpected field.");
      const { doc } = read();
      if (value.expectedRevision !== undefined && value.expectedRevision !== textsRevision(doc.items)) {
        throw new RequirementsError(409, "The requirements changed. Wait for the save to finish and apply again.");
      }
      const pending = pendingRequirements(doc.items);
      if (!pending.length) throw new RequirementsError(409, "Every requirement is already applied.");
      const label = new Map(doc.items.map((item, index) => [item.id, ordinalLabel(index)]));
      const requirements: TurnRequirements = { ids: pending.map((r) => r.id), labels: pending.map((r) => label.get(r.id)!), hashes: pending.map((r) => textHash(r.text)) };
      const prompt = buildRequirementsPrompt({ modelPath: deps.modelPath, lintCommand: deps.lintCommand,
        apply: pending.map((r) => ({ id: r.id, label: label.get(r.id)!, text: r.text, changed: !!r.applied, ...(r.trace?.length ? { trace: r.trace } : {}) })),
        all: doc.items.map((r) => ({ id: r.id, label: label.get(r.id)!, text: r.text })) });
      const text = `Apply ${requirements.labels.length === 1 ? "requirement" : "requirements"} ${requirements.labels.join(", ")} to the model`;
      return { text, plan: { prompt, requirements, settle } };
    },

    undo,
  };

  async function settle(turn: Turn): Promise<void> {
    const meta = turn.requirements;
    if (!meta) return;
    if (turn.reply) {
      const { raw, reply } = extractTrace(turn.reply);
      if (reply) turn.reply = reply; else delete turn.reply;
      if (turn.status !== "ok") return;
      await record(turn, meta, raw);
    } else if (turn.status === "ok") await record(turn, meta, undefined);
  }

  async function record(turn: Turn, meta: TurnRequirements, raw: unknown): Promise<void> {
    const index = modelIndex(model());
    if (!index) {
      turn.steps.push({ kind: "text", summary: "The model does not parse, so the requirements stay unapplied." });
      return;
    }
    const result = validateTrace(raw, meta.ids, index.ids);
    meta.trace = result.entries;
    if (raw === undefined) meta.noTrace = true;
    await deps.serial(async () => {
      const { doc, bytes } = read();
      const before: Record<string, RequirementMark> = {};
      meta.ids.forEach((id, i) => {
        const item = doc.items.find((r) => r.id === id);
        if (!item) return;
        before[id] = mark(item);
        const entry = result.entries[id];
        setMark(item, { applied: meta.hashes[i]!, trace: entry?.elements ?? [], ...(entry?.why ? { why: entry.why } : {}) });
      });
      meta.before = before;
      if (Object.keys(before).length) write(doc, bytes);
    });
  }

  /** Undo of an apply turn: put back the state of each line this turn wrote, unless a later apply changed it. */
  async function undo(turn: Turn): Promise<void> {
    const meta = turn.requirements;
    if (!meta?.before) return;
    await deps.serial(async () => {
      const { doc, bytes } = read();
      let changed = false;
      meta.ids.forEach((id, i) => {
        const item = doc.items.find((r) => r.id === id);
        const previous = meta.before![id];
        if (!item || !previous) return;
        if (item.applied !== meta.hashes[i] || !sameList(item.trace, meta.trace?.[id]?.elements ?? [])) return;
        setMark(item, previous);
        changed = true;
      });
      if (changed) write(doc, bytes);
    });
  }
}
export type RequirementsController = ReturnType<typeof createRequirements>;
