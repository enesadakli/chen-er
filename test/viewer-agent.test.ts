import { describe, expect, it } from "vitest";
import {
  agentName, applyTurn, canSend, changeNote, changeNoteText, composerKey, elapsedSeconds, flashIds, labelFor,
  loadThread, outcome, selectionChips, takeToken, undoableTurn, MAX_TEXT, type Turn,
} from "../src/viewer/agent-logic.js";

const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({
  id, text: `request ${id}`, selection: [], startedAt: `2026-10-10T12:00:0${id}Z`, status: "running", steps: [], ...patch,
});
const labels = new Map([["E:STUDENT", "STUDENT"], ["R:ENROLLS", "ENROLLS"], ["A:STUDENT.BirthDate", "Birth date"]]);

describe("agent turn reducer", () => {
  it("loads turns in start order and keeps the running id", () => {
    const state = loadThread({ running: "2", turns: [turn("2"), turn("1", { status: "ok", finishedAt: "x" })] });
    expect(state.turns.map((t) => t.id)).toEqual(["1", "2"]);
    expect(state.running).toBe("2");
  });
  it("appends a started turn, replaces it on each step and clears running when it finishes", () => {
    let state = loadThread({ running: null, turns: [] });
    state = applyTurn(state, turn("1"));
    expect(state.running).toBe("1");
    state = applyTurn(state, turn("1", { steps: [{ kind: "tool", summary: "Edit university.er.yaml" }] }));
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.steps).toHaveLength(1);
    state = applyTurn(state, turn("1", { status: "ok", finishedAt: "2026-10-10T12:00:09Z", reply: "Done." }));
    expect(state.running).toBeNull();
    expect(state.turns[0]!.reply).toBe("Done.");
  });
  it("ignores a late running snapshot for a finished turn but accepts ok -> undone", () => {
    let state = applyTurn(loadThread({ running: null, turns: [] }), turn("1", { status: "ok", finishedAt: "f" }));
    const same = applyTurn(state, turn("1", { steps: [{ kind: "text", summary: "late" }] }));
    expect(same).toBe(state);
    state = applyTurn(state, turn("1", { status: "undone", finishedAt: "f" }));
    expect(state.turns[0]!.status).toBe("undone");
  });
  it("does not clear another turn's running id", () => {
    const state = applyTurn(loadThread({ running: "2", turns: [turn("2")] }), turn("1", { status: "error", finishedAt: "f" }));
    expect(state.running).toBe("2");
  });
});

describe("undo eligibility", () => {
  const changes = { added: ["A:STUDENT.BirthDate"], removed: [], modified: [] };
  it("offers undo only on the latest model-changing turn while it is ok", () => {
    const turns = [turn("1", { status: "ok", changes }), turn("2", { status: "ok", changes }), turn("3", { status: "ok", changes: { added: [], removed: [], modified: [] } })];
    expect(undoableTurn(turns)).toBe("2");
  });
  it("offers nothing after the latest change was undone, failed or while nothing changed", () => {
    expect(undoableTurn([turn("1", { status: "ok", changes }), turn("2", { status: "undone", changes })])).toBeUndefined();
    expect(undoableTurn([turn("1", { status: "error" })])).toBeUndefined();
    expect(undoableTurn([turn("1", { status: "ok", changes }), turn("2")])).toBe("1");
  });
  it("treats a parse error as a model change so a broken edit can be undone", () => {
    expect(undoableTurn([turn("1", { status: "ok", changes: { added: [], removed: [], modified: [], parseError: true } })])).toBe("1");
  });
});

describe("change note", () => {
  it("formats added, modified and removed lines with readable labels", () => {
    const lines = changeNote({ added: ["A:STUDENT.BirthDate"], modified: ["R:ENROLLS"], removed: ["R:HAS"] }, labels);
    expect(changeNoteText(lines)).toBe("+ Birth date (STUDENT)\n~ ENROLLS\n- HAS");
    expect(lines.map((l) => l.linkable)).toEqual([true, true, false]);
  });
  it("falls back to the id for unknown elements and composite parts", () => {
    expect(labelFor("A:PERSON.Address.City")).toBe("City (PERSON)");
    expect(labelFor("E:COURSE")).toBe("COURSE");
    expect(labelFor("weird")).toBe("weird");
  });
  it("is empty without changes or on a parse error", () => {
    expect(changeNote(undefined)).toEqual([]);
    expect(changeNote({ added: ["E:X"], removed: [], modified: [], parseError: true })).toEqual([]);
  });
  it("flashes what exists after the turn, and what came back after an undo", () => {
    const changes = { added: ["E:A"], modified: ["E:B"], removed: ["E:C"] };
    expect(flashIds(turn("1", { status: "ok", changes }))).toEqual(["E:A", "E:B"]);
    expect(flashIds(turn("1", { status: "undone", changes }))).toEqual(["E:C", "E:B"]);
  });
});

describe("context chips", () => {
  it("mirror the canvas selection", () => {
    expect(selectionChips("E:STUDENT", undefined)).toEqual(["E:STUDENT"]);
    expect(selectionChips(undefined, undefined)).toEqual([]);
  });
  it("stay dismissed only for the selection that was dismissed", () => {
    expect(selectionChips("E:STUDENT", "E:STUDENT")).toEqual([]);
    expect(selectionChips("R:ENROLLS", "E:STUDENT")).toEqual(["R:ENROLLS"]);
  });
});

describe("outcomes and input", () => {
  it("names what to run when the CLI is missing or logged out", () => {
    expect(outcome(turn("1", { status: "error", error: "spawn claude ENOENT" }))).toEqual({ kind: "missing", message: "Claude Code was not found. Install it, run `claude` once in a terminal, then `/login`." });
    expect(outcome(turn("1", { status: "error", error: "Not logged in" }), "codex")?.message).toBe("Codex is not logged in. Run `codex login` in a terminal.");
    expect(outcome(turn("1", { status: "error", errorKind: "not-found" }), "codex")?.message).toBe("Codex CLI was not found. Install it, then run `codex login` in a terminal.");
    expect(outcome(turn("1", { status: "error", errorKind: "other", error: "boom" }), "codex")?.message).toBe("Codex stopped with an error.");
    expect(outcome(turn("1", { status: "limit" }), "codex")?.message).toBe("Codex hit its usage limit. Try again after the limit resets.");
    expect(outcome(turn("1", { status: "error", error: "Invalid API key · Please run /login" }))?.kind).toBe("login");
    expect(outcome(turn("1", { status: "limit" }))?.message).toMatch(/usage limit/);
  });
  it("trusts the server's errorKind over the text heuristics", () => {
    expect(outcome(turn("1", { status: "error", errorKind: "not-found", error: "something odd" }))?.kind).toBe("missing");
    expect(outcome(turn("1", { status: "error", errorKind: "not-logged-in", error: "exit 1" }))?.kind).toBe("login");
    // A generic failure whose text merely mentions authentication stays a generic error when the server says so.
    expect(outcome(turn("1", { status: "error", errorKind: "other", error: "authentication module crashed" }))).toMatchObject({ kind: "error", detail: "authentication module crashed" });
    expect(outcome(turn("1", { status: "error", errorKind: "other", error: "spawn claude ENOENT" }))?.kind).toBe("error");
  });
  it("reports other errors with the stderr excerpt", () => {
    const error = outcome(turn("1", { status: "error", error: "line 1\nline 2" }));
    expect(error).toMatchObject({ kind: "error", detail: "line 1\nline 2" });
    expect(outcome(turn("1", { status: "ok", changes: { added: [], removed: [], modified: [] } }))?.message).toBe("No changes to the model.");
    expect(outcome(turn("1"))).toBeUndefined();
  });
  it("shows the server's notice on a turn it cancelled itself", () => {
    expect(outcome(turn("1", { status: "cancelled" }))).toEqual({ kind: "cancelled", message: "Cancelled." });
    expect(outcome(turn("1", { status: "cancelled", notice: "The server stopped while this request was running, so it was cancelled." })))
      .toEqual({ kind: "cancelled", message: "The server stopped while this request was running, so it was cancelled." });
  });
  it("takes the token from the address once and strips it", () => {
    expect(takeToken("http://127.0.0.1:4000/?t=abc&x=1#h", null)).toEqual({ token: "abc", cleanHref: "/?x=1#h" });
    expect(takeToken("http://127.0.0.1:4000/", "kept")).toEqual({ token: "kept" });
  });
  it("sends on Enter, keeps Shift+Enter and IME composition as text", () => {
    expect(composerKey({ key: "Enter", shiftKey: false })).toBe("send");
    expect(composerKey({ key: "Enter", shiftKey: true })).toBe("none");
    expect(composerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe("none");
    expect(canSend("  ", null)).toBe(false);
    expect(canSend("Add X", "1")).toBe(false);
    expect(canSend("x".repeat(MAX_TEXT + 1), null)).toBe(false);
  });
  it("counts elapsed seconds and names the agent", () => {
    expect(elapsedSeconds("2026-10-10T12:00:00Z", Date.parse("2026-10-10T12:00:12.900Z"))).toBe(12);
    expect(agentName("claude")).toBe("Claude");
    expect(agentName("codex")).toBe("Codex");
  });
});
