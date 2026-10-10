// Requirements file (`<model>.er.requirements.md`): parse, serialize, per-line state and the trace an agent returns.
// Browser-safe: the viewer and the server share it. Format: docs/requirements.md.

export interface TraceEntry { elements: string[]; why?: string; dropped?: string[] }
export interface Requirement {
  /** Stable id (`r<n>`); never renumbered, so traces and the agent thread keep pointing at the same line. */
  id: string;
  text: string;
  /** Hash of the text as it was when it was last applied (`textHash`). */
  applied?: string;
  /** Element ids (`E:`, `R:`, `A:`) the last apply linked to this requirement; empty means not covered. */
  trace?: string[];
  /** One-line rationale from the last apply. */
  why?: string;
}
export interface RequirementsDoc { title?: string; intro?: string; outro?: string; items: Requirement[] }
export type RequirementState = "new" | "changed" | "applied" | "uncovered";

export const MAX_REQUIREMENTS = 300;
export const MAX_REQUIREMENT_TEXT = 1000;
export const MAX_WHY = 300;
const MAX_TRACE = 50;
const ID = /^r[1-9]\d{0,5}$/;
const ELEMENT = /^[ERA]:\S{1,200}$/;
const HEADER = "<!-- chen-er requirements v1: one requirement per list item. The comment after each item keeps its id and trace for chen serve; leave it in place. -->";

/** Whitespace-insensitive text used for hashing and comparison. */
export const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

/** FNV-1a (32 bit) of the normalized text as 8 hex digits: cheap, stable and identical in Node and the browser. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(normalizeText(text))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const isRequirementId = (id: string): boolean => ID.test(id);

/** The next unused stable id. Ids are never reused while a line holds them. */
export function nextRequirementId(ids: Iterable<string>): string {
  let max = 0;
  for (const id of ids) if (ID.test(id)) max = Math.max(max, Number(id.slice(1)));
  return `r${max + 1}`;
}

/** Display label of a requirement: its ordinal, `R1`, `R2`… (stable ids stay in the file and the prompt). */
export const ordinalLabel = (index: number): string => `R${index + 1}`;

/**
 * Per-line state. `live` is the set of element ids in the current model when known; trace ids missing from it no
 * longer count, so a requirement whose elements were removed later shows as not covered.
 */
export function requirementState(item: Requirement, live?: ReadonlySet<string>): RequirementState {
  if (!item.applied) return "new";
  if (item.applied !== textHash(item.text)) return "changed";
  return liveTrace(item, live).length ? "applied" : "uncovered";
}
export const liveTrace = (item: Requirement, live?: ReadonlySet<string>): string[] =>
  (item.trace ?? []).filter((id) => !live || live.has(id));

/** Lines an apply must process: non-empty and new or changed since the last apply. */
export function pendingRequirements(items: readonly Requirement[]): Requirement[] {
  return items.filter((item) => normalizeText(item.text) && (!item.applied || item.applied !== textHash(item.text)));
}

/** Readable element name from its id alone: `A:STUDENT.Name.First` → `First (STUDENT)`. */
export function elementName(id: string, labels?: ReadonlyMap<string, string>): string {
  const label = labels?.get(id);
  const kind = id.slice(0, 2), path = id.slice(2);
  if (kind === "A:") {
    const parts = path.split(".");
    const owner = parts[0]!;
    return `${label ?? parts.at(-1)} (${labels?.get(`E:${owner}`) ?? labels?.get(`R:${owner}`) ?? owner})`;
  }
  return label ?? (kind === "E:" || kind === "R:" ? path : id);
}

// Requirement text sits in Markdown next to an HTML comment, so a comment opener or closer inside it is escaped.
const escapeText = (text: string): string => normalizeText(text).replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
const unescapeText = (text: string): string => text.replace(/&lt;!--/g, "<!--").replace(/--&gt;/g, "-->");
// JSON inside an HTML comment: `<` and `>` as \u escapes keep `-->` out of it and stay valid JSON.
const commentJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const ITEM = /^(?:\d{1,6}[.)]|[-*+])\s+(.*)$/;
const STATE = /\s*<!--\s*chen-er\s+(\{.*\})\s*-->\s*$/;
const GENERATED = /^\s+\*(?:→|△)\s/;

function readState(raw: string | undefined): Partial<Requirement> {
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const state: Partial<Requirement> = {};
  if (typeof v.id === "string" && ID.test(v.id)) state.id = v.id;
  if (typeof v.applied === "string" && /^[0-9a-f]{8}$/.test(v.applied)) state.applied = v.applied;
  if (Array.isArray(v.trace)) state.trace = [...new Set(v.trace.filter((id): id is string => typeof id === "string" && ELEMENT.test(id)))].slice(0, MAX_TRACE);
  if (typeof v.why === "string" && v.why.trim()) state.why = normalizeText(v.why).slice(0, MAX_WHY);
  return state;
}

/**
 * Parses the file. List items are requirements (ordered or bullet); the trailing `<!-- chen-er {...} -->` comment
 * holds the machine state. Generated trace lines (`*→ …*`, `*△ …*`) are skipped; other indented lines continue the
 * item. Prose before the list is kept as intro, any other prose as outro. Items without a valid unique id get the
 * next free one, in order, so a hand-written list parses to the same ids every time.
 */
export function parseRequirements(text: string): RequirementsDoc {
  const doc: RequirementsDoc = { items: [] };
  const intro: string[] = [], outro: string[] = [];
  const pending: { text: string; state: Partial<Requirement> }[] = [];
  let current: { text: string; state: Partial<Requirement> } | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (doc.title === undefined && !pending.length && !intro.some((l) => l.trim()) && /^#\s+\S/.test(line)) { doc.title = line.replace(/^#\s+/, "").trim(); continue; }
    if (line.trim() === HEADER || /^\s*<!--\s*chen-er requirements v\d+\b.*-->\s*$/.test(line)) continue;
    const item = ITEM.exec(line);
    if (item) {
      const state = STATE.exec(item[1]!);
      current = { text: (state ? item[1]!.slice(0, state.index) : item[1]!), state: readState(state?.[1]) };
      pending.push(current);
      continue;
    }
    if (current && GENERATED.test(line)) continue;
    if (current && /^\s{2,}\S/.test(line)) {
      const state = STATE.exec(line);
      if (state) current.state = { ...current.state, ...readState(state[1]) };
      const rest = state ? line.slice(0, state.index) : line;
      if (rest.trim()) current.text += ` ${rest.trim()}`;
      continue;
    }
    if (!line.trim()) { current = undefined; (pending.length ? outro : intro).push(line); continue; }
    current = undefined;
    (pending.length ? outro : intro).push(line);
  }
  const used = new Set<string>();
  for (const entry of pending) {
    const textValue = unescapeText(normalizeText(entry.text)).slice(0, MAX_REQUIREMENT_TEXT);
    if (!textValue) continue;
    const id = entry.state.id && !used.has(entry.state.id) ? entry.state.id : undefined;
    const item: Requirement = { id: id ?? "", text: textValue };
    if (entry.state.applied) item.applied = entry.state.applied;
    if (entry.state.trace) item.trace = entry.state.trace;
    if (entry.state.why) item.why = entry.state.why;
    if (id) used.add(id);
    doc.items.push(item);
  }
  for (const item of doc.items) if (!item.id) { item.id = nextRequirementId(used); used.add(item.id); }
  doc.items = doc.items.slice(0, MAX_REQUIREMENTS);
  const trim = (lines: string[]) => lines.join("\n").replace(/^\n+|\s+$/g, "");
  if (trim(intro)) doc.intro = trim(intro);
  if (trim(outro)) doc.outro = trim(outro);
  return doc;
}

/**
 * Writes the file: title, a one-line format comment, an ordered list (numbers match R1, R2… in the viewer) and, under
 * each applied item, one generated italic line naming the elements that implement it (`*→ …*`) or saying it is not
 * covered (`*△ …*`). HTML comments are invisible in Obsidian's reading view and in a printed PDF.
 */
export function serializeRequirements(doc: RequirementsDoc, labels?: ReadonlyMap<string, string>): string {
  const out = [`# ${doc.title?.trim() || "Requirements"}`, "", HEADER, ""];
  if (doc.intro) out.push(doc.intro, "");
  doc.items.forEach((item, index) => {
    const state: Record<string, unknown> = { id: item.id };
    if (item.applied) state.applied = item.applied;
    if (item.applied && item.trace) state.trace = item.trace;
    if (item.applied && item.why) state.why = item.why;
    const number = `${index + 1}.`;
    out.push(`${number} ${escapeText(item.text)} <!-- chen-er ${commentJson(state)} -->`);
    const indent = " ".repeat(number.length + 1);
    if (item.applied && item.applied === textHash(item.text)) {
      const why = item.why ? ` ${escapeText(item.why).replace(/\*/g, "\\*")}` : "";
      out.push(item.trace?.length
        ? `${indent}*→ ${item.trace.map((id) => elementName(id, labels).replace(/\*/g, "\\*")).join(", ")}.${why}*`
        : `${indent}*△ Not reflected in the model.${why}*`);
    }
  });
  if (doc.outro) out.push("", doc.outro);
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Trace returned by the agent at the end of its final message:
//   ```chen-trace
//   {"r2": {"elements": ["E:COURSE", "R:OFFERS"], "why": "one line"}}
//   ```

const FENCE = /```[ \t]*(chen-trace|json)[ \t]*\n([\s\S]*?)\n[ \t]*```/g;

/** Finds the last `chen-trace` block (or, failing that, the last JSON block) and returns the reply without it. */
export function extractTrace(reply: string): { raw?: unknown; reply: string } {
  let found: { start: number; end: number; value: unknown; tagged: boolean } | undefined;
  for (const match of reply.matchAll(FENCE)) {
    let value: unknown;
    try { value = JSON.parse(match[2]!); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const tagged = match[1] === "chen-trace";
    if (!found || tagged || !found.tagged) found = { start: match.index!, end: match.index! + match[0].length, value, tagged };
  }
  if (!found) return { reply: reply.trim() };
  return { raw: found.value, reply: `${reply.slice(0, found.start)}${reply.slice(found.end)}`.replace(/\n{3,}/g, "\n\n").trim() };
}

/** A rationale reads as a sentence in the file and the viewer. */
const sentence = (text: string): string => /[.!?…:)]$/.test(text) ? text : `${text}.`;

export interface TraceResult {
  /** One entry per applied requirement id that the agent answered for; elements are only ids present in the model. */
  entries: Record<string, TraceEntry>;
  /** Applied ids without an entry. */
  missing: string[];
}

/**
 * Validates the agent's trace against the requirement ids it was asked to apply and the element ids of the model
 * after the turn. Unknown element ids are dropped (kept in `dropped`); a bare `COURSE` resolves to `E:COURSE` or
 * `R:COURSE` when exactly one exists. Entries for ids outside the applied set are ignored.
 */
export function validateTrace(raw: unknown, applied: readonly string[], modelIds: ReadonlySet<string>): TraceResult {
  const entries: Record<string, TraceEntry> = {};
  const source = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const item of raw) if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") source.set((item as { id: string }).id, item);
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const inner = record.requirements && typeof record.requirements === "object" ? record.requirements : record;
    if (Array.isArray(inner)) return validateTrace(inner, applied, modelIds);
    for (const [key, value] of Object.entries(inner as Record<string, unknown>)) source.set(key, value);
  }
  const resolve = (id: string): string | undefined => {
    if (modelIds.has(id)) return id;
    if (/^[ERA]:/.test(id)) return undefined;
    const options = [`E:${id}`, `R:${id}`].filter((candidate) => modelIds.has(candidate));
    return options.length === 1 ? options[0] : undefined;
  };
  for (const id of applied) {
    const key = [...source.keys()].find((k) => k.trim().toLowerCase() === id);
    if (key === undefined) continue;
    const value = source.get(key);
    const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as Record<string, unknown>).elements : undefined;
    const why = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).why : undefined;
    const elements: string[] = [], dropped: string[] = [];
    for (const element of Array.isArray(list) ? list : []) {
      if (typeof element !== "string" || !element.trim() || element.length > 200) continue;
      const resolved = resolve(element.trim());
      if (resolved) { if (!elements.includes(resolved)) elements.push(resolved); }
      else if (!dropped.includes(element.trim())) dropped.push(element.trim());
    }
    const entry: TraceEntry = { elements: elements.slice(0, MAX_TRACE) };
    if (typeof why === "string" && normalizeText(why)) entry.why = sentence(normalizeText(why).slice(0, MAX_WHY));
    if (dropped.length) entry.dropped = dropped.slice(0, MAX_TRACE);
    entries[id] = entry;
  }
  return { entries, missing: applied.filter((id) => !entries[id]) };
}
