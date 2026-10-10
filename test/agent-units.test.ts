import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeSet } from "../src/app/agent-changes.js";
import { agentCommand, parseTurnRequest } from "../src/app/agent.js";
import { allowedTools, buildPrompt, claudeArgs, codexArgs, lintCommandFor, selectionLabels } from "../src/app/agent-prompt.js";
import { classifyExit } from "../src/app/agent-runner.js";
import { agentStatePathFor, parseThread } from "../src/app/agent-store.js";
import { codexParser, commandWord, parseStreamLine, summarizeCodexItem, summarizeTool, type StreamUpdate } from "../src/app/agent-stream.js";
import { agentOptions } from "../src/cli/commands.js";

const BASE = `version: 1
entities:
  STUDENT:
    attrs: [StudentId, Name]
    keys: [[StudentId]]
  COURSE:
    attrs: [CourseId]
    keys: [[CourseId]]
relationships:
  ENROLLS:
    ends:
      - entity: STUDENT
        card: 0..N
      - entity: COURSE
        card: 0..N
  HAS:
    ends:
      - entity: STUDENT
        card: 0..1
      - entity: COURSE
        card: 0..N
`;

describe("agent stream parsing", () => {
  it("collects session ids, tool steps, text and the final result; ignores junk", () => {
    expect(parseStreamLine("not json")).toEqual({ steps: [] });
    expect(parseStreamLine("[1,2]")).toEqual({ steps: [] });
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1"}')).toEqual({ steps: [], sessionId: "s1" });
    const assistant = parseStreamLine(JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [
      { type: "text", text: "  Looking  at\nit " },
      { type: "tool_use", name: "Edit", input: { file_path: "/a/b/university.er.yaml" } },
      { type: "tool_use", name: "Bash", input: { command: "npx tsx src/cli/index.ts lint x" } },
      { type: "tool_use", name: "Read", input: { file_path: "/x/notes.md" } },
      { type: "thinking", thinking: "hidden" },
    ] } }));
    expect(assistant.steps).toEqual([
      { kind: "text", summary: "Looking at it" },
      { kind: "tool", summary: "Edit university.er.yaml" },
      { kind: "tool", summary: "Bash npx" },
      { kind: "tool", summary: "Read notes.md" },
    ]);
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s2"}'))
      .toEqual({ steps: [], sessionId: "s2", result: { text: "Done.", isError: false } });
    expect(parseStreamLine('{"type":"result","subtype":"error_max_turns","session_id":"s2"}').result).toEqual({ text: "", isError: true });
    expect(summarizeTool("Grep", { pattern: "x" })).toBe("Grep");
    expect(summarizeTool("Bash", {})).toBe("Bash");
  });

  it("classifies exits", () => {
    const base = { code: 0, cancelled: false, bin: "claude", stderr: "" };
    expect(classifyExit({ ...base, result: { text: "Added it.", isError: false } })).toEqual({ status: "ok", reply: "Added it." });
    expect(classifyExit({ ...base, lastText: "Fallback reply." })).toEqual({ status: "ok", reply: "Fallback reply." });
    expect(classifyExit({ ...base, code: null, cancelled: true })).toEqual({ status: "cancelled" });
    expect(classifyExit({ ...base, result: { text: "Claude AI usage limit reached|1760000000", isError: false } }).status).toBe("limit");
    expect(classifyExit({ ...base, code: 1, stderr: "Error: You've hit your limit" })).toMatchObject({ status: "limit", errorKind: "limit" });
    expect(classifyExit({ ...base, code: 2, stderr: "a\nb\n" })).toEqual({ status: "error", errorKind: "other", error: "a\nb" });
    expect(classifyExit({ ...base, code: 0, result: { text: "Invalid API key · Please run /login", isError: true } }))
      .toEqual({ status: "error", errorKind: "not-logged-in", error: "Invalid API key · Please run /login" });
    expect(classifyExit({ ...base, code: 1, stderr: "Not logged in" }).errorKind).toBe("not-logged-in");
    expect(classifyExit({ ...base, code: 1, stderr: "Authentication failed" }).errorKind).toBe("not-logged-in");
    expect(classifyExit({ ...base, result: { text: "Explained /login.", isError: false } })).toEqual({ status: "ok", reply: "Explained /login." });
    const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    expect(classifyExit({ ...base, code: null, spawnError: missing })).toMatchObject({ status: "error", errorKind: "not-found", error: expect.stringMatching(/claude command was not found/) });
    const denied = Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" });
    expect(classifyExit({ ...base, code: null, spawnError: denied }).errorKind).toBe("other");
  });
});

describe("agent change set", () => {
  it("reports added, removed and modified node ids", () => {
    const after = BASE
      .replace("attrs: [StudentId, Name]", "attrs: [StudentId, Name, BirthDate]")
      .replace("      - entity: COURSE\n        card: 0..N\n  HAS:", "      - entity: COURSE\n        card: 1..N\n  HAS:")
      .replace(/  HAS:[\s\S]*$/, "")
      .replace("attrs: [CourseId]", "attrs: [CourseId]\n    label: Course");
    expect(changeSet(BASE, after)).toEqual({ added: ["A:STUDENT.BirthDate"], removed: ["R:HAS"], modified: ["E:COURSE", "R:ENROLLS"] });
    expect(changeSet(BASE, BASE)).toEqual({ added: [], removed: [], modified: [] });
    expect(changeSet(BASE, "version: [\n")).toEqual({ added: [], removed: [], modified: [], parseError: true });
    expect(changeSet(null, BASE).parseError).toBe(true);
  });
});

describe("agent prompt and command", () => {
  it("builds the preamble with labels, lint command and rules", () => {
    const selection = selectionLabels(BASE, ["E:STUDENT", "A:STUDENT.Name", "R:GONE"]);
    expect(selection).toEqual([{ id: "E:STUDENT", label: "STUDENT" }, { id: "A:STUDENT.Name", label: "Name" }, { id: "R:GONE", label: undefined }]);
    const prompt = buildPrompt({ modelPath: "/m/My Model.er.yaml", lintCommand: "node /r/bin/chen.js lint", selection, text: "Make HAS 1:N" });
    expect(prompt).toContain("Model file: /m/My Model.er.yaml\nSelected elements:\nE:STUDENT (STUDENT)\nA:STUDENT.Name (Name)\nR:GONE\nRules:");
    expect(prompt).toContain("run `node /r/bin/chen.js lint '/m/My Model.er.yaml'` and fix any errors");
    expect(prompt).toContain("Keep its comments and formatting.");
    expect(prompt).toContain("\n- Never edit *.er.layout.json, *.er.agent.json or *.er.requirements.md files.\n");
    expect(prompt).toContain("Reply with one or two plain sentences");
    expect(prompt).toContain("\n- Do not create or update notes, memory, receipts or logs outside the model file.\n");
    expect(buildPrompt({ modelPath: "/m", lintCommand: "x", selection: [], text: "t" })).toContain("Selected elements:\n(none)\n");
    const lint = "npx tsx '/r x/src/cli/index.ts' lint";
    expect(allowedTools(lint)).toEqual(["Bash(npx tsx '/r x/src/cli/index.ts' lint:*)", "mcp__chen-er__lint_er", "mcp__chen-er__render_er"]);
    expect(claudeArgs("P", "/m", "node /r/bin/chen.js lint", "s1")).toEqual(["-p", "P", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash(node /r/bin/chen.js lint:*)", "mcp__chen-er__lint_er", "mcp__chen-er__render_er", "--add-dir", "/m", "--resume", "s1"]);
    expect(claudeArgs("P", "/m", "x")).not.toContain("--resume");
  });

  it("derives the lint command from how the server was started", () => {
    expect(lintCommandFor("/repo/src/cli/index.ts", "/repo")).toBe("npx tsx /repo/src/cli/index.ts lint");
    expect(lintCommandFor("/repo/bin/chen.js", "/repo")).toBe("node /repo/bin/chen.js lint");
    expect(lintCommandFor("/usr/lib/node_modules/chen-er/dist/cli/index.js", "/x")).toBe("node /usr/lib/node_modules/chen-er/dist/cli/index.js lint");
    // A checkout with tsx installed runs its own tsx: npx would try the network from another directory.
    expect(lintCommandFor("/other/vitest.mjs", resolve("."))).toMatch(/^(\S+\/node_modules\/\.bin\/tsx \S+src\/cli\/index\.ts|node \S+bin\/chen\.js) lint$/);
    expect(lintCommandFor(resolve("src/cli/index.ts"), "/x")).toBe(`${resolve("node_modules/.bin/tsx")} ${resolve("src/cli/index.ts")} lint`);
  });

  it("runs script agents with node and validates requests", () => {
    expect(agentCommand("/x/fake.mjs", ["-p", "a"])).toEqual({ bin: process.execPath, args: ["/x/fake.mjs", "-p", "a"] });
    expect(agentCommand("claude", ["-p"])).toEqual({ bin: "claude", args: ["-p"] });
    expect(parseTurnRequest({ text: "hi" })).toEqual({ text: "hi", selection: [] });
    expect(parseTurnRequest({ text: "hi", selection: ["E:A", "E:A"] }).selection).toEqual(["E:A"]);
    expect(() => parseTurnRequest({ text: "  " })).toThrow();
    expect(() => parseTurnRequest({ text: "a", selection: [1] })).toThrow();
  });
});

describe("serve --agent flags", () => {
  it("maps flags for claude and codex and rejects other agents and a stray --agent-cwd", () => {
    expect(agentOptions({})).toBeUndefined();
    expect(agentOptions({ agent: "claude", agentCwd: "/v" })).toEqual({ kind: "claude", cwd: "/v" });
    expect(agentOptions({ agent: "codex" })).toEqual({ kind: "codex" });
    expect(() => agentOptions({ agent: "gemini" })).toThrow("Unknown agent: gemini. Use --agent claude or --agent codex.");
    expect(() => agentOptions({ agentCwd: "/v" })).toThrow("--agent-cwd requires --agent claude or --agent codex.");
  });
});

/** Feeds lines through one parser and merges the updates the way the runner does. */
function feed(parse: (line: string) => StreamUpdate, lines: string[]) {
  const merged: { sessionId?: string; steps: StreamUpdate["steps"]; lastText?: string; result?: StreamUpdate["result"] } = { steps: [] };
  for (const line of lines) {
    const update = parse(line);
    if (update.sessionId) merged.sessionId = update.sessionId;
    if (update.lastText) merged.lastText = update.lastText;
    if (update.result) merged.result = update.result;
    merged.steps.push(...update.steps);
  }
  return merged;
}

describe("codex backend", () => {
  it("builds the exec arguments and resumes a thread before the prompt", () => {
    expect(codexArgs("P", "/cwd", "/m")).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--cd", "/cwd", "--add-dir", "/m", "--skip-git-repo-check", "P"]);
    expect(codexArgs("P", "/cwd", "/m", "th-1")).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--cd", "/cwd", "--add-dir", "/m", "--skip-git-repo-check", "resume", "th-1", "P"]);
  });

  it("parses a recorded codex exec --json turn into steps, thread id and reply", () => {
    const lines = readFileSync("test/fixtures/agent/codex-exec.jsonl", "utf8").trim().split("\n");
    const run = feed(codexParser(), lines);
    expect(run.sessionId).toBe("01a12558-ffdb-7743-8779-477b3ef5a9d3");
    expect(run.steps).toEqual([
      { kind: "text", summary: "I will add a City attribute to SUPPLIER and check the model with lint." },
      { kind: "tool", summary: "Shell cat" },
      { kind: "tool", summary: "Edit ternary.er.yaml" },
      { kind: "tool", summary: "Shell npx" },
      { kind: "text", summary: "City is added; the lint command has no output yet, waiting for it to finish." },
      { kind: "tool", summary: "Shell ls" },
      { kind: "tool", summary: "Shell node" },
      { kind: "text", summary: expect.stringMatching(/^Added a City attribute to SUPPLIER/) },
    ]);
    expect(run.lastText).toMatch(/found 0 errors\.$/);
    expect(run.result).toEqual({ text: "", isError: false });
    expect(classifyExit({ code: 0, cancelled: false, bin: "codex", kind: "codex", stderr: "Reading additional input from stdin...\n", result: run.result, lastText: run.lastText }))
      .toEqual({ status: "ok", reply: run.lastText });
  });

  it("marks errors and failed turns, and clears a retried error when the turn completes", () => {
    const limit = "You've hit your usage limit. Try again in 2 hours.";
    const failed = feed(codexParser(), [JSON.stringify({ type: "error", message: limit }), JSON.stringify({ type: "turn.failed", error: { message: limit } })]);
    expect(failed.result).toEqual({ text: limit, isError: true });
    expect(classifyExit({ code: 1, cancelled: false, bin: "codex", kind: "codex", stderr: "", result: failed.result })).toMatchObject({ status: "limit", errorKind: "limit" });
    const login = feed(codexParser(), [JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } })]);
    expect(classifyExit({ code: 1, cancelled: false, bin: "codex", kind: "codex", stderr: "", result: login.result })).toMatchObject({ status: "error", errorKind: "not-logged-in" });
    const retried = feed(codexParser(), [JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }), '{"type":"turn.completed","usage":{}}']);
    expect(retried.result).toEqual({ text: "", isError: false });
    expect(feed(codexParser(), ["junk", "[]", '{"type":"item.completed"}', '{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"x"}}'])).toEqual({ steps: [] });
    const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    expect(classifyExit({ code: null, cancelled: false, bin: "codex", kind: "codex", stderr: "", spawnError: missing }))
      .toMatchObject({ status: "error", errorKind: "not-found", error: "The codex command was not found. Install the Codex CLI, then run `codex login`." });
    expect(classifyExit({ code: 1, cancelled: false, bin: "codex", kind: "codex", stderr: "Error: Not logged in. Run codex login" }).errorKind).toBe("not-logged-in");
  });

  it("shows each tool item once, at its first event, and an agent message only when completed", () => {
    const parse = codexParser();
    const started = { type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc \"git status\"", status: "in_progress" } };
    expect(parse(JSON.stringify(started)).steps).toEqual([{ kind: "tool", summary: "Shell git" }]);
    expect(parse(JSON.stringify({ ...started, type: "item.completed" })).steps).toEqual([]);
    expect(parse(JSON.stringify({ type: "item.updated", item: { id: "m", type: "agent_message", text: "partial" } })).steps).toEqual([]);
    expect(parse(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: " Done. " } }))).toEqual({ steps: [{ kind: "text", summary: "Done." }], lastText: "Done." });
    expect(summarizeCodexItem({ type: "file_change", changes: [{ path: "/a/x.er.yaml", kind: "add" }] })).toEqual({ kind: "tool", summary: "Create x.er.yaml" });
    expect(summarizeCodexItem({ type: "file_change", changes: [{ path: "/a/x.yaml", kind: "add" }, { path: "/b/y.yaml", kind: "update" }] })).toEqual({ kind: "tool", summary: "Edit x.yaml, y.yaml" });
    expect(summarizeCodexItem({ type: "mcp_tool_call", server: "chen-er", tool: "lint_er" })).toEqual({ kind: "tool", summary: "mcp__chen-er__lint_er" });
    expect(summarizeCodexItem({ type: "web_search", query: "x" })).toEqual({ kind: "tool", summary: "Web search" });
    expect(summarizeCodexItem({ type: "todo_list", items: [] })).toBeUndefined();
    expect(commandWord("/bin/zsh -lc 'npx tsx a lint b'")).toBe("npx");
    expect(commandWord("bash -c \"/usr/bin/sed -n 1p f\"")).toBe("sed");
    expect(commandWord("ls -la")).toBe("ls");
    expect(commandWord("")).toBeUndefined();
  });
});

describe("agent thread file", () => {
  const model = "/m/club.er.yaml";
  const turn = { id: "t1", text: "a", selection: [], startedAt: "2026-10-10T10:00:00.000Z", status: "ok", steps: [{ kind: "tool", summary: "Edit x" }] };
  const thread = { version: 1, model, kind: "codex", sessionId: "s", entries: [{ turn, beforeRevision: "absent", afterRevision: "a".repeat(64), before: null }] };
  it("names the file like the layout file", () => {
    expect(agentStatePathFor("/m/club.er.yaml")).toBe("/m/club.er.agent.json");
    expect(agentStatePathFor("/m/Club.YML")).toBe("/m/Club.er.agent.json");
  });
  it("loads only a well-formed thread of the same model and agent kind", () => {
    expect(parseThread(JSON.stringify(thread), model, "codex")).toEqual(thread);
    expect(parseThread(JSON.stringify(thread), model, "claude")).toBeUndefined();
    expect(parseThread(JSON.stringify(thread), "/other/club.er.yaml", "codex")).toBeUndefined();
    expect(parseThread("{", model, "codex")).toBeUndefined();
    const bad = (patch: object) => parseThread(JSON.stringify({ ...thread, entries: [{ ...thread.entries[0], ...patch }] }), model, "codex");
    expect(bad({ beforeRevision: "nope" })).toBeUndefined();
    expect(bad({ before: "not base64!" })).toBeUndefined();
    expect(bad({ turn: { ...turn, status: "weird" } })).toBeUndefined();
    expect(bad({ turn: { ...turn, id: "../x" } })).toBeUndefined();
    expect(bad({ turn: { ...turn, steps: [{ kind: "tool" }] } })).toBeUndefined();
    expect(parseThread(JSON.stringify({ ...thread, entries: [thread.entries[0], thread.entries[0]] }), model, "codex")).toBeUndefined();
    expect(parseThread(JSON.stringify({ ...thread, version: 2 }), model, "codex")).toBeUndefined();
  });
});
