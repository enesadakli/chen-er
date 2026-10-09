import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeSet } from "../src/app/agent-changes.js";
import { agentCommand, parseTurnRequest } from "../src/app/agent.js";
import { buildPrompt, claudeArgs, lintCommandFor, selectionLabels } from "../src/app/agent-prompt.js";
import { classifyExit } from "../src/app/agent-runner.js";
import { parseStreamLine, summarizeTool } from "../src/app/agent-stream.js";
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
    expect(classifyExit({ ...base, code: 1, stderr: "Error: You've hit your limit" }).status).toBe("limit");
    expect(classifyExit({ ...base, code: 2, stderr: "a\nb\n" })).toEqual({ status: "error", error: "a\nb" });
    expect(classifyExit({ ...base, code: 0, result: { text: "Invalid API key · Please run /login", isError: true } }))
      .toEqual({ status: "error", error: "Invalid API key · Please run /login" });
    const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    expect(classifyExit({ ...base, code: null, spawnError: missing }).error).toMatch(/claude command was not found/);
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
    expect(prompt).toContain("Reply with one or two plain sentences");
    expect(buildPrompt({ modelPath: "/m", lintCommand: "x", selection: [], text: "t" })).toContain("Selected elements:\n(none)\n");
    expect(claudeArgs("P", "/m", "s1")).toEqual(["-p", "P", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--add-dir", "/m", "--resume", "s1"]);
    expect(claudeArgs("P", "/m")).not.toContain("--resume");
  });

  it("derives the lint command from how the server was started", () => {
    expect(lintCommandFor("/repo/src/cli/index.ts", "/repo")).toBe("npx tsx /repo/src/cli/index.ts lint");
    expect(lintCommandFor("/repo/bin/chen.js", "/repo")).toBe("node /repo/bin/chen.js lint");
    expect(lintCommandFor("/usr/lib/node_modules/chen-er/dist/cli/index.js", "/x")).toBe("node /usr/lib/node_modules/chen-er/dist/cli/index.js lint");
    expect(lintCommandFor("/other/vitest.mjs", resolve("."))).toMatch(/^(npx tsx \S+src\/cli\/index\.ts|node \S+bin\/chen\.js) lint$/);
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
  it("maps flags and rejects codex and a stray --agent-cwd", () => {
    expect(agentOptions({})).toBeUndefined();
    expect(agentOptions({ agent: "claude", agentCwd: "/v" })).toEqual({ kind: "claude", cwd: "/v" });
    expect(() => agentOptions({ agent: "codex" })).toThrow("--agent codex is not supported yet. Use --agent claude.");
    expect(() => agentOptions({ agentCwd: "/v" })).toThrow("--agent-cwd requires --agent claude.");
  });

  it("exits with a usage error for --agent codex", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "serve", join("test/fixtures/viewer-focus/binary.er.yaml"), "--agent", "codex", "--port", "0"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--agent codex is not supported yet");
  }, 20000);
});
