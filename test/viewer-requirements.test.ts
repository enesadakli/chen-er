import { describe, expect, it } from "vitest";
import { textHash } from "../src/core/requirements.js";
import type { Turn } from "../src/viewer/agent-logic.js";
import {
  applyResult, applySummary, applyTurns, editorKey, ensureTrailing, lineLabels, mergeState, oneLine, pasteLines,
  receiveView, requirementFindings, savePayload, splitPaste, traceLinks, type KeyInput, type Line, type RequirementsView,
} from "../src/viewer/requirements-logic.js";

const ids = () => { let n = 100; return () => `r${++n}`; };
const lines = (...texts: string[]): Line[] => texts.map((text, i) => ({ id: `r${i + 1}`, text }));
const key = (k: string, start: number, patch: Partial<KeyInput> = {}): KeyInput => ({ key: k, start, end: start, singleRow: true, ...patch });
const texts = (result: { lines: Line[] } | undefined) => result?.lines.map((l) => l.text);

describe("requirements editor keys", () => {
  it("Enter on a non-empty line opens the next line, splitting at the caret", () => {
    const fresh = ids();
    const end = editorKey(lines("Every course has a code", ""), 0, key("Enter", 23), fresh);
    // The empty last line already waits below, so Enter moves there.
    expect(texts(end)).toEqual(["Every course has a code", ""]);
    expect(end!.focus).toEqual({ index: 1, caret: 0 });
    const split = editorKey(lines("Every course has a code", ""), 0, key("Enter", 12), fresh);
    expect(texts(split)).toEqual(["Every course", "has a code", ""]);
    expect(split!.lines[1]!.id).toBe("r101");
    expect(split!.focus).toEqual({ index: 1, caret: 0 });
    const middle = editorKey(lines("A", "B", ""), 0, key("Enter", 1), fresh);
    expect(texts(middle)).toEqual(["A", "", "B", ""]);
    expect(middle!.focus).toEqual({ index: 1, caret: 0 });
  });

  it("Enter on an empty line does nothing but is still handled (no newline)", () => {
    const result = editorKey(lines("A", ""), 1, key("Enter", 0), ids());
    expect(texts(result)).toEqual(["A", ""]);
    expect(result!.focus).toEqual({ index: 1, caret: 0 });
    expect(editorKey(lines("A", ""), 0, key("Enter", 1, { shiftKey: true }), ids())!.focus.index).toBe(1);
    expect(editorKey(lines("A", ""), 0, key("Enter", 1, { isComposing: true }), ids())).toBeUndefined();
  });

  it("Backspace on an empty line deletes it and focuses the end of the previous line", () => {
    const result = editorKey(lines("Alpha", "", "Beta", ""), 1, key("Backspace", 0), ids());
    expect(texts(result)).toEqual(["Alpha", "Beta", ""]);
    expect(result!.focus).toEqual({ index: 0, caret: 5 });
    // The last empty line comes back, so Backspace there just walks up.
    const last = editorKey(lines("Alpha", ""), 1, key("Backspace", 0), ids());
    expect(texts(last)).toEqual(["Alpha", ""]);
    expect(last!.focus).toEqual({ index: 0, caret: 5 });
    expect(editorKey(lines(""), 0, key("Backspace", 0), ids())).toBeUndefined();
  });

  it("Backspace at the start joins the previous line; Delete at the end joins the next", () => {
    const join = editorKey(lines("Alpha", "Beta", ""), 1, key("Backspace", 0), ids());
    expect(texts(join)).toEqual(["AlphaBeta", ""]);
    expect(join!.lines[0]!.id).toBe("r1");
    expect(join!.focus).toEqual({ index: 0, caret: 5 });
    expect(editorKey(lines("Alpha", "Beta"), 1, key("Backspace", 2), ids())).toBeUndefined();
    const del = editorKey(lines("Alpha", "Beta", ""), 0, key("Delete", 5), ids());
    expect(texts(del)).toEqual(["AlphaBeta", ""]);
    expect(editorKey(lines("Alpha", ""), 0, key("Delete", 5), ids())).toBeUndefined();
  });

  it("ArrowUp and ArrowDown move between lines and keep the column on one-row lines", () => {
    expect(editorKey(lines("Alpha", "Be"), 1, key("ArrowUp", 2), ids())!.focus).toEqual({ index: 0, caret: 2 });
    expect(editorKey(lines("Alpha", "Be"), 0, key("ArrowDown", 4), ids())!.focus).toEqual({ index: 1, caret: 2 });
    expect(editorKey(lines("Alpha", "Be"), 0, key("ArrowUp", 2), ids())).toBeUndefined();
    // Wrapped lines: the browser moves inside the text until the caret reaches the edge.
    expect(editorKey(lines("Alpha", "long wrapped"), 1, key("ArrowUp", 4, { singleRow: false }), ids())).toBeUndefined();
    expect(editorKey(lines("Alpha", "long wrapped"), 1, key("ArrowUp", 0, { singleRow: false }), ids())!.focus).toEqual({ index: 0, caret: 5 });
    expect(editorKey(lines("long wrapped", "B"), 0, key("ArrowDown", 12, { singleRow: false }), ids())!.focus).toEqual({ index: 1, caret: 0 });
    expect(editorKey(lines("Alpha", "Be"), 1, key("ArrowUp", 2, { shiftKey: true }), ids())).toBeUndefined();
    expect(editorKey(lines("Alpha", "Be"), 1, key("ArrowUp", 0, { end: 2 }), ids())).toBeUndefined();
  });

  it("keeps exactly one empty line at the end", () => {
    expect(texts({ lines: ensureTrailing(lines("A"), ids()) })).toEqual(["A", ""]);
    expect(texts({ lines: ensureTrailing(lines("A", ""), ids()) })).toEqual(["A", ""]);
    expect(texts({ lines: ensureTrailing([], ids()) })).toEqual([""]);
  });

  it("splits a multi-line paste into lines and strips list markers", () => {
    expect(splitPaste("1. Every course has a code\n\n- Students enroll\r\nR3: Rooms have a capacity\n  ")).toEqual(["Every course has a code", "Students enroll", "Rooms have a capacity"]);
    const result = pasteLines(lines("Intro: ", ""), 0, 7, 7, "first\nsecond\nthird", ids());
    expect(texts(result)).toEqual(["Intro: first", "second", "third", ""]);
    expect(result!.focus).toEqual({ index: 2, caret: 5 });
    const middle = pasteLines(lines("A|B", ""), 0, 1, 2, "x\ny", ids());
    expect(texts(middle)).toEqual(["Ax", "yB", ""]);
    expect(pasteLines(lines("A", ""), 0, 1, 1, "single", ids())).toBeUndefined();
    expect(texts(pasteLines(lines("A", ""), 0, 1, 1, "tail\n", ids()))).toEqual(["Atail", ""]);
    expect(oneLine("a\nb\r\nc")).toBe("a b c");
  });
});

describe("autosave and server state", () => {
  const view = (items: Line[], revision = "rev2"): RequirementsView => ({ file: "club.er.requirements.md", exists: true, revision, items, agent: "claude" });
  it("sends only non-empty lines with normalized text", () => {
    expect(savePayload(lines(" Every  course ", "", "B"))).toEqual([{ id: "r1", text: "Every course" }, { id: "r3", text: "B" }]);
  });
  it("merges applied state for the same revision and keeps local text", () => {
    const local = lines("typed locally", "");
    const next = receiveView(local, "rev1", true, view([{ id: "r1", text: "old", applied: "abcd0123", trace: ["E:A"] }], "rev1"), ids());
    expect(next).toMatchObject({ conflict: false, base: "rev1" });
    expect(next.lines[0]).toEqual({ id: "r1", text: "typed locally", applied: "abcd0123", trace: ["E:A"] });
    expect(mergeState(next.lines, [])[0]).toEqual({ id: "r1", text: "typed locally" });
  });
  it("takes an outside edit when nothing is unsaved and reports a conflict otherwise", () => {
    const outside = view([{ id: "r1", text: "from Obsidian" }]);
    expect(receiveView(lines("mine", ""), "rev1", false, outside, ids())).toMatchObject({ base: "rev2", conflict: false, lines: [{ text: "from Obsidian" }, { text: "" }] });
    expect(receiveView(lines("mine", ""), "rev1", true, outside, ids())).toMatchObject({ base: "rev1", conflict: true, lines: [{ text: "mine" }, { text: "" }] });
  });
});

describe("line labels, summary and findings", () => {
  const hashed = (id: string, text: string, trace: string[]): Line => ({ id, text, applied: textHash(text), trace });
  const all: Line[] = [hashed("r1", "covered", ["E:A"]), { id: "r2", text: "" }, { id: "r4", text: "brand new" }, hashed("r5", "uncovered", []), { ...hashed("r6", "old", ["E:A"]), text: "edited" }, { id: "r7", text: "" }];
  it("numbers non-empty lines in order and gives the last empty line the next number", () => {
    expect(lineLabels(all)).toEqual(["R1", undefined, "R2", "R3", "R4", "R5"]);
  });
  it("summarizes what Apply would send", () => {
    expect(applySummary(all)).toEqual({ pending: 2, text: "1 new · 1 changed" });
    expect(applySummary([hashed("r1", "a", ["E:A"]), { id: "r2", text: "" }])).toEqual({ pending: 0, text: "1 applied" });
    expect(applySummary([hashed("r1", "a", ["E:A"]), hashed("r2", "b", [])]).text).toBe("1 applied · 1 not covered");
    expect(applySummary([{ id: "r1", text: "" }]).text).toBe("No requirements yet.");
  });
  it("adds an info finding per applied line nothing implements, using the live model", () => {
    expect(requirementFindings(all).map((f) => f.message)).toEqual(["Requirement R3 is not reflected in the model."]);
    expect(requirementFindings(all, new Set(["E:B"])).map((f) => f.message)).toEqual([
      "Requirement R1 is not reflected in the model.", "Requirement R3 is not reflected in the model."]);
    expect(requirementFindings(all)[0]).toMatchObject({ rule: "requirement-not-covered", severity: "info" });
  });
  it("marks trace links whose element left the model", () => {
    expect(traceLinks(hashed("r1", "x", ["E:A", "E:B"]), new Set(["E:A"]))).toEqual([{ id: "E:A", present: true }, { id: "E:B", present: false }]);
  });
});

describe("apply turns", () => {
  const meta = { ids: ["r2", "r4"], labels: ["R2", "R3"], hashes: ["00000000", "00000001"] };
  const turn = (id: string, patch: Partial<Turn>): Turn => ({ id, text: "t", selection: [], startedAt: "2026-10-10T10:00:00Z", status: "ok", steps: [], ...patch });
  it("finds the running apply, a blocking chat turn and the last finished apply", () => {
    const turns = [turn("t1", { requirements: meta }), turn("t2", {}), turn("t3", { status: "running", requirements: meta })];
    expect(applyTurns(turns, "t3")).toMatchObject({ running: { id: "t3" }, busy: true, last: { id: "t1" } });
    expect(applyTurns(turns.slice(0, 2), "t2")).toEqual({ busy: true, last: turns[0] });
  });
  it("says what happened in one sentence, problems in the red pencil", () => {
    expect(applyResult(turn("t1", { requirements: { ...meta, trace: { r2: { elements: ["E:A"], dropped: ["E:GHOST"] }, r4: { elements: [] } } } }), "claude"))
      .toEqual({ tone: "quiet", text: "Applied R2, R3. Unknown element ids were left out: E:GHOST (R2)." });
    expect(applyResult(turn("t1", { requirements: { ...meta, noTrace: true } }), "codex"))
      .toEqual({ tone: "problem", text: "Applied R2, R3. Codex returned no trace, so they show as not covered." });
    expect(applyResult(turn("t1", { status: "undone", requirements: meta }), "claude").text).toBe("Undone. R2, R3 are back to how they were before.");
    expect(applyResult(turn("t1", { status: "limit", requirements: meta }), "claude"))
      .toEqual({ tone: "problem", text: "Claude hit its usage limit. Try again after the limit resets. R2, R3 stay unapplied." });
    expect(applyResult(turn("t1", { status: "cancelled", requirements: { ...meta, ids: ["r2"], labels: ["R2"], hashes: ["0"] } }), "claude").text).toBe("Cancelled. R2 stays unapplied.");
  });
});
