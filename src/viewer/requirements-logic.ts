/** Pure Requirements-tab logic: the line editor, autosave payloads, merging server state, findings. No DOM. */
import {
  liveTrace, normalizeText, ordinalLabel, requirementState, type Requirement, type RequirementState,
} from "../core/requirements.js";
import { agentName, outcome, type Turn } from "./agent-logic.js";

export type Line = Requirement;
export interface EditResult { lines: Line[]; focus: { index: number; caret: number } }
export interface KeyInput {
  key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean;
  /** Selection in the focused line. */
  start: number; end: number;
  /** The line fits one visual row, so Up/Down leave it at once instead of moving inside wrapped text. */
  singleRow: boolean;
}
export interface RequirementsView { file: string; exists: boolean; revision: string; title?: string; items: Requirement[]; agent: string | null }

const empty = (line: Line | undefined) => !!line && !line.text.trim();
const copy = (lines: readonly Line[]) => lines.map((line) => ({ ...line }));

/** Exactly one place to type a new requirement: the list always ends with an empty line. */
export function ensureTrailing(lines: readonly Line[], fresh: () => string): Line[] {
  const next = copy(lines);
  if (!next.length || !empty(next.at(-1))) next.push({ id: fresh(), text: "" });
  return next;
}

/**
 * Key handling for one line. Returns the new lines and where the caret goes, or undefined to leave the key to the
 * browser. Enter on a non-empty line opens (or moves to) the line below, splitting at the caret; Enter on an empty line
 * does nothing. Backspace on an empty line deletes it and moves to the end of the previous one; at the start of a
 * non-empty line it joins the line to the previous one (Delete at the end joins the next). Up/Down move between lines.
 */
export function editorKey(lines: readonly Line[], index: number, e: KeyInput, fresh: () => string): EditResult | undefined {
  const line = lines[index];
  if (!line || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return undefined;
  const text = line.text;
  const previous = lines[index - 1], next = lines[index + 1];
  if (e.key === "Enter") {
    if (!text.trim()) return { lines: copy(lines), focus: { index, caret: e.start } };
    const before = text.slice(0, e.start), after = text.slice(e.end);
    const result = copy(lines);
    result[index]!.text = before;
    if (!after && empty(next)) return { lines: ensureTrailing(result, fresh), focus: { index: index + 1, caret: 0 } };
    result.splice(index + 1, 0, { id: fresh(), text: after.trimStart() });
    return { lines: ensureTrailing(result, fresh), focus: { index: index + 1, caret: 0 } };
  }
  if (e.shiftKey && e.key !== "Backspace" && e.key !== "Delete") return undefined;
  if (e.key === "Backspace") {
    if (!text && lines.length > 1) {
      const result = copy(lines);
      result.splice(index, 1);
      const target = index > 0 ? index - 1 : 0;
      const caret = index > 0 ? result[target]!.text.length : 0;
      return { lines: ensureTrailing(result, fresh), focus: { index: target, caret } };
    }
    if (e.start === 0 && e.end === 0 && previous) {
      const result = copy(lines);
      const caret = previous.text.length;
      result[index - 1]!.text = previous.text + text;
      result.splice(index, 1);
      return { lines: ensureTrailing(result, fresh), focus: { index: index - 1, caret } };
    }
    return undefined;
  }
  if (e.key === "Delete" && e.start === text.length && e.end === text.length && next && !(empty(next) && index + 1 === lines.length - 1)) {
    const result = copy(lines);
    result[index]!.text = text + next.text;
    result.splice(index + 1, 1);
    return { lines: ensureTrailing(result, fresh), focus: { index, caret: text.length } };
  }
  if (e.key === "ArrowUp" && previous && e.start === e.end && (e.singleRow || e.start === 0)) {
    return { lines: copy(lines), focus: { index: index - 1, caret: e.singleRow ? Math.min(e.start, previous.text.length) : previous.text.length } };
  }
  if (e.key === "ArrowDown" && next && e.start === e.end && (e.singleRow || e.start === text.length)) {
    return { lines: copy(lines), focus: { index: index + 1, caret: e.singleRow ? Math.min(e.start, next.text.length) : 0 } };
  }
  return undefined;
}

/** Pasted text as requirement lines: list markers (`-`, `1.`, `R3:`) and blank lines dropped. */
export function splitPaste(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+•]|\d{1,4}[.)]|R\d{1,4}[.:)]?)\s+/i, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A paste with line breaks becomes several lines; a single-line paste is left to the browser (undefined). */
export function pasteLines(lines: readonly Line[], index: number, start: number, end: number, clip: string, fresh: () => string): EditResult | undefined {
  const line = lines[index];
  if (!line || !/[\r\n]/.test(clip)) return undefined;
  const pieces = splitPaste(clip);
  const before = line.text.slice(0, start), after = line.text.slice(end);
  const result = copy(lines);
  if (!pieces.length) return { lines: result, focus: { index, caret: start } };
  if (pieces.length === 1) {
    result[index]!.text = `${before}${pieces[0]}${after}`;
    return { lines: ensureTrailing(result, fresh), focus: { index, caret: before.length + pieces[0]!.length } };
  }
  result[index]!.text = `${before}${pieces[0]}`;
  const added = pieces.slice(1).map((text, i) => ({ id: fresh(), text: i === pieces.length - 2 ? `${text}${after}` : text }));
  result.splice(index + 1, 0, ...added);
  return { lines: ensureTrailing(result, fresh), focus: { index: index + added.length, caret: pieces.at(-1)!.length } };
}

/** Single-line text: anything that slipped a line break in (drop, autocorrect) becomes a space. */
export const oneLine = (text: string): string => text.replace(/\r\n?|\n/g, " ");

/** What autosave sends: non-empty lines with their stable ids. */
export function savePayload(lines: readonly Line[]): { id: string; text: string }[] {
  return lines.filter((line) => line.text.trim()).map((line) => ({ id: line.id, text: normalizeText(line.text) }));
}

/** Copy applied hashes, traces and rationales from the server onto local lines with the same id. */
export function mergeState(lines: readonly Line[], items: readonly Requirement[]): Line[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return lines.map((line) => {
    const item = byId.get(line.id);
    const next: Line = { id: line.id, text: line.text };
    if (item?.applied) next.applied = item.applied;
    if (item?.trace) next.trace = item.trace;
    if (item?.why) next.why = item.why;
    return next;
  });
}

/**
 * A `requirements` event or GET answer. Same text revision: only machine state changes (an apply or undo wrote
 * it). Another revision: take the file when nothing local is unsaved, otherwise report a conflict.
 */
export function receiveView(lines: readonly Line[], base: string | undefined, dirty: boolean, view: RequirementsView, fresh: () => string): { lines: Line[]; base?: string; conflict: boolean } {
  if (view.revision === base) return { lines: mergeState(lines, view.items), base, conflict: false };
  if (dirty && base !== undefined) return { lines: mergeState(lines, view.items), base, conflict: true };
  return { lines: ensureTrailing(view.items.map((item) => ({ ...item })), fresh), base: view.revision, conflict: false };
}

/** `R1`, `R2`… for non-empty lines in order; the trailing empty line shows the number it will get. */
export function lineLabels(lines: readonly Line[]): (string | undefined)[] {
  let n = 0;
  return lines.map((line, index) => line.text.trim() ? ordinalLabel(n++) : index === lines.length - 1 ? ordinalLabel(n) : undefined);
}

export function lineState(line: Line, live?: ReadonlySet<string>): RequirementState | undefined {
  return line.text.trim() ? requirementState(line, live) : undefined;
}

/** Quiet line under the bar: `2 new · 1 changed`, or that everything is applied. */
export function applySummary(lines: readonly Line[], live?: ReadonlySet<string>): { pending: number; text: string } {
  const count = { new: 0, changed: 0, uncovered: 0, applied: 0 };
  for (const line of lines) { const state = lineState(line, live); if (state) count[state]++; }
  const pending = count.new + count.changed;
  const parts = [count.new && `${count.new} new`, count.changed && `${count.changed} changed`].filter(Boolean);
  const total = count.new + count.changed + count.uncovered + count.applied;
  if (!total) return { pending, text: "No requirements yet." };
  if (parts.length) return { pending, text: parts.join(" · ") };
  return { pending, text: [count.applied && `${count.applied} applied`, count.uncovered && `${count.uncovered} not covered`].filter(Boolean).join(" · ") };
}

export interface RequirementFinding { rule: string; severity: "info"; message: string; hint: string }
/** Info findings for the Notes tab: applied requirements no model element implements (now). */
export function requirementFindings(lines: readonly Line[], live?: ReadonlySet<string>): RequirementFinding[] {
  const labels = lineLabels(lines);
  return lines.flatMap((line, index) => lineState(line, live) === "uncovered" ? [{
    rule: "requirement-not-covered", severity: "info" as const,
    message: `Requirement ${labels[index]} is not reflected in the model.`,
    hint: "Open the Requirements tab to read its trace, then rewrite it or ask the agent to cover it.",
  }] : []);
}

/** Element links under an applied line: ids in the model now, and ids that were removed since. */
export function traceLinks(line: Line, live?: ReadonlySet<string>): { id: string; present: boolean }[] {
  const present = new Set(liveTrace(line, live));
  return (line.trace ?? []).map((id) => ({ id, present: present.has(id) }));
}

/** The apply turn running now, whether another agent turn blocks Apply, and the latest finished apply turn. */
export function applyTurns(turns: readonly Turn[], running: string | null): { running?: Turn; busy: boolean; last?: Turn } {
  const current = running ? turns.find((t) => t.id === running) : undefined;
  const last = [...turns].reverse().find((t) => t.requirements && t.status !== "running");
  return { ...(current?.requirements ? { running: current } : {}), busy: !!running, ...(last ? { last } : {}) };
}

/** One sentence about the latest finished apply turn, for the line under Apply. */
export function applyResult(turn: Turn, kind: string): { tone: "quiet" | "problem"; text: string } {
  const meta = turn.requirements!;
  const list = meta.labels.join(", ");
  const name = agentName(kind);
  if (turn.status === "ok") {
    if (turn.changes?.parseError) return { tone: "problem", text: `${list}: the model no longer parses, so the lines stay unapplied. The findings in Notes show where.` };
    const dropped = meta.ids.flatMap((id, i) => (meta.trace?.[id]?.dropped ?? []).map((element) => `${element} (${meta.labels[i]})`));
    const parts = [`Applied ${list}.`];
    if (meta.noTrace) parts.push(`${name} returned no trace, so ${meta.labels.length === 1 ? "it shows" : "they show"} as not covered.`);
    if (dropped.length) parts.push(`Unknown element ids were left out: ${dropped.join(", ")}.`);
    return { tone: meta.noTrace ? "problem" : "quiet", text: parts.join(" ") };
  }
  if (turn.status === "undone") return { tone: "quiet", text: `Undone. ${list} ${meta.labels.length === 1 ? "is" : "are"} back to how ${meta.labels.length === 1 ? "it was" : "they were"} before.` };
  if (turn.status === "cancelled") return { tone: "quiet", text: `${turn.notice ?? "Cancelled."} ${list} stay${meta.labels.length === 1 ? "s" : ""} unapplied.` };
  return { tone: "problem", text: `${outcome(turn, kind)?.message ?? `${name} stopped.`} ${list} stay${meta.labels.length === 1 ? "s" : ""} unapplied.` };
}
