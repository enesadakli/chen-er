import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERRUPTED, type AgentInfo, type Turn } from "../src/app/agent.js";
import { agentStatePathFor } from "../src/app/agent-store.js";
import { layoutPathFor } from "../src/app/render.js";
import { serve, type AgentOptions } from "../src/app/serve.js";

const FAKE = resolve("test/fixtures/agent/fake-claude.mjs");
const FAKE_CODEX = resolve("test/fixtures/agent/fake-codex.mjs");
const MODEL = `# Agent test model.
version: 1
entities:
  MEMBER:
    attrs:
      - MemberId
    keys:
      - [MemberId]
  CLUB:
    attrs:
      - ClubId
    keys:
      - [ClubId]
relationships:
  JOINS:
    ends:
      - entity: MEMBER
        card: 0..N
      - entity: CLUB
        card: 1..N
`;

let dir: string, cwd: string, model: string, log: string;
let viewer: Awaited<ReturnType<typeof serve>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "chen-agent-cwd-"));
  model = join(dir, "club.er.yaml");
  log = join(dir, "..", `${dir.split("/").at(-1)}-args.jsonl`);
  writeFileSync(model, MODEL);
  process.env.CHEN_AGENT_BIN = FAKE;
  process.env.FAKE_AGENT_LOG = log;
  delete process.env.FAKE_AGENT_MODE;
});
afterEach(async () => {
  await viewer?.close();
  viewer = undefined;
  for (const path of [dir, cwd, log]) rmSync(path, { recursive: true, force: true });
});

async function start(agent: Partial<AgentOptions> | null = {}) {
  viewer = await serve(model, { port: 0, ...(agent ? { agent: { kind: "claude", cwd, ...agent } } : {}) });
  return viewer;
}
const api = (path: string, init: RequestInit = {}, token = viewer!.token) =>
  fetch(viewer!.url + path, { ...init, headers: { ...(token ? { "X-Chen-Token": token } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers as Record<string, string> } });
const send = (text: string, selection: string[] = []) => api("/api/agent/turns", { method: "POST", body: JSON.stringify({ text, selection }) });
const info = async () => await (await api("/api/agent")).json() as AgentInfo;
async function eventually(test: () => Promise<boolean> | boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await test()) return; await new Promise((done) => setTimeout(done, 20)); }
  throw new Error("Condition not met in time.");
}
async function settled(): Promise<AgentInfo> {
  await eventually(async () => (await info()).running === null);
  return info();
}
const rawStatus = (path: string, headers: Record<string, string>) => new Promise<number>((done, reject) => {
  const req = request(viewer!.url + path, { headers }, (res) => { res.resume(); done(res.statusCode!); });
  req.on("error", reject); req.end();
});
const args = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string });

describe("agent routes", () => {
  it("returns 404 for every agent route without --agent", async () => {
    await start(null);
    expect(viewer!.token).toBeUndefined();
    expect(viewer!.pageUrl).toBe(viewer!.url);
    expect((await api("/api/agent", {}, "x")).status).toBe(404);
    expect((await api("/api/agent/turns", { method: "POST", body: "{}" }, "x")).status).toBe(404);
    expect((await api("/api/agent/turns/t1/undo", { method: "POST" }, "x")).status).toBe(404);
  });

  it("requires the token, a local Host and a local Origin and answers 403 without detail", async () => {
    await start();
    expect(viewer!.pageUrl).toBe(`${viewer!.url}/?t=${viewer!.token}`);
    expect(Buffer.from(viewer!.token!, "base64url")).toHaveLength(32);
    const missing = await api("/api/agent", {}, "");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "Forbidden." });
    expect((await api("/api/agent", {}, "wrong")).status).toBe(403);
    expect((await api("/api/agent", {}, viewer!.token!.slice(1) + "A")).status).toBe(403);
    const port = new URL(viewer!.url).port;
    expect(await rawStatus("/api/agent", { "X-Chen-Token": viewer!.token!, Host: "evil.example" })).toBe(403);
    expect(await rawStatus("/api/agent", { "X-Chen-Token": viewer!.token!, Host: `localhost:${port}` })).toBe(200);
    expect((await api("/api/agent", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await api("/api/agent", { headers: { Origin: `http://localhost:${port}` } })).status).toBe(200);
    expect((await send("hi", ["E:MEMBER"])).status).toBe(202);
    await settled();
  });

  it("runs a turn, streams agent-turn events and reports the change set", async () => {
    await start();
    expect(await info()).toMatchObject({ enabled: true, kind: "claude", cwd, running: null, turns: [] });
    const abort = new AbortController();
    const events = await fetch(`${viewer!.url}/api/events`, { signal: abort.signal });
    const reader = events.body!.getReader();
    let text = "";
    const reading = (async () => {
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } }
      catch { /* aborted */ }
    })();
    try {
      const response = await send("Add a BirthDate attribute", ["E:MEMBER"]);
      expect(response.status).toBe(202);
      const { turnId } = await response.json() as { turnId: string };
      const done = await settled();
      const turn = done.turns.find((t) => t.id === turnId)!;
      expect(turn).toMatchObject({ status: "ok", text: "Add a BirthDate attribute", selection: ["E:MEMBER"], reply: "Added BirthDate to the first entity." });
      expect(turn.finishedAt).toBeTruthy();
      expect(turn.steps).toEqual([
        { kind: "text", summary: "Adding the attribute." },
        { kind: "tool", summary: "Edit club.er.yaml" },
        { kind: "tool", summary: "Bash npx" },
      ]);
      expect(turn.changes).toEqual({ added: ["A:MEMBER.BirthDate"], removed: [], modified: [] });
      await eventually(() => text.includes("BirthDate") && text.includes('"status":"ok"'));
      const turns = [...text.matchAll(/event: agent-turn\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1]!) as Turn);
      expect(turns[0]).toMatchObject({ id: turnId, status: "running", steps: [] });
      expect(turns.filter((t) => t.status === "running").length).toBeGreaterThanOrEqual(4);
      expect(turns.at(-1)).toMatchObject({ id: turnId, status: "ok" });
      // The existing state event picks the agent's write up through the file watcher.
      await eventually(() => /event: state\ndata: .*A:MEMBER\.BirthDate/.test(text));
    } finally { abort.abort(); await reading; }
  });

  it("passes the contract arguments and resumes the captured session on the next turn", async () => {
    await start();
    await send("first", ["E:MEMBER", "A:MEMBER.MemberId", "E:NOPE"]);
    await settled();
    await send("second");
    await settled();
    const [first, second] = args();
    expect(first!.cwd).toBe(realpathSync(cwd));
    const prompt = first!.args[1]!;
    const lint = /run `(.+) \S+club\.er\.yaml` and fix any errors/.exec(prompt)?.[1];
    expect(lint).toMatch(/^(npx tsx|node|\S+\/node_modules\/\.bin\/tsx) \S+ lint$/);
    expect(first!.args).toEqual(["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--allowedTools", `Bash(${lint}:*)`, "mcp__chen-er__lint_er", "mcp__chen-er__render_er", "mcp__chen-er__get_schema", "--add-dir", dir]);
    expect(prompt).toContain(`Model file: ${model}`);
    expect(prompt).toContain("E:MEMBER (MEMBER)\nA:MEMBER.MemberId (MemberId)\nE:NOPE\n");
    expect(prompt).toMatch(/run `\S+ (\S+ )?lint \S+club\.er\.yaml` and fix any errors/);
    expect(prompt).toContain("Never edit *.er.layout.json, *.er.agent.json or *.er.requirements.md files.");
    expect(prompt.endsWith("Request:\nfirst")).toBe(true);
    expect(second!.args.slice(-2)).toEqual(["--resume", "fake-session-1"]);
  });

  it("validates turn requests", async () => {
    await start();
    expect((await send("")).status).toBe(400);
    expect((await send("x".repeat(4001))).status).toBe(400);
    expect((await send("ok", Array.from({ length: 21 }, (_, i) => `E:${i}`))).status).toBe(400);
    expect((await api("/api/agent/turns", { method: "POST", body: JSON.stringify({ text: "a", extra: 1 }) })).status).toBe(400);
    expect((await api("/api/agent/turns/t9/cancel", { method: "POST" })).status).toBe(404);
  });

  it("allows one turn at a time and cancels a running turn", async () => {
    process.env.FAKE_AGENT_MODE = "slow";
    await start();
    const { turnId } = await (await send("slow")).json() as { turnId: string };
    expect((await send("again")).status).toBe(409);
    await eventually(async () => (await info()).turns[0]!.steps.length > 0);
    expect((await info()).running).toBe(turnId);
    const cancel = await api(`/api/agent/turns/${turnId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ status: "cancelled" });
    expect((await info()).running).toBeNull();
  });

  it("kills an agent that ignores SIGTERM", async () => {
    process.env.FAKE_AGENT_MODE = "stubborn";
    await start({ killAfterMs: 200 });
    const { turnId } = await (await send("slow")).json() as { turnId: string };
    await eventually(async () => (await info()).turns[0]!.steps.length > 0);
    expect(await (await api(`/api/agent/turns/${turnId}/cancel`, { method: "POST" })).json()).toEqual({ status: "cancelled" });
  });

  it("reports errors with the stderr tail and usage limits", async () => {
    process.env.FAKE_AGENT_MODE = "error";
    await start();
    await send("fail");
    const failed = (await settled()).turns[0]!;
    expect(failed.status).toBe("error");
    expect(failed.errorKind).toBe("other");
    expect(failed.error!.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `stderr line ${i + 6}`));
    process.env.FAKE_AGENT_MODE = "limit";
    await send("limit");
    expect((await settled()).turns[1]).toMatchObject({ status: "limit", errorKind: "limit" });
    process.env.FAKE_AGENT_MODE = "login";
    await send("login");
    expect((await settled()).turns[2]).toMatchObject({ status: "error", errorKind: "not-logged-in" });
  });

  it("undoes the latest model change and restores the exact bytes", async () => {
    await start();
    const { turnId } = await (await send("add")).json() as { turnId: string };
    await settled();
    expect(readFileSync(model, "utf8")).toContain("- BirthDate");
    const undo = await api(`/api/agent/turns/${turnId}/undo`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ status: "undone" });
    expect(readFileSync(model, "utf8")).toBe(MODEL);
    expect((await info()).turns[0]!.status).toBe("undone");
    expect((await api(`/api/agent/turns/${turnId}/undo`, { method: "POST" })).status).toBe(409);
  });

  it("refuses undo after an external edit or for an older turn", async () => {
    await start();
    const first = (await (await send("one")).json() as { turnId: string }).turnId;
    await settled();
    const second = (await (await send("two")).json() as { turnId: string }).turnId;
    await settled();
    const older = await api(`/api/agent/turns/${first}/undo`, { method: "POST" });
    expect(older.status).toBe(409);
    const edited = readFileSync(model, "utf8") + "# edited by hand\n";
    writeFileSync(model, edited);
    const refused = await api(`/api/agent/turns/${second}/undo`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "The model changed after this turn." });
    expect(readFileSync(model, "utf8")).toBe(edited);
  });

  it("never leaves an agent write in the layout file", async () => {
    await start();
    const layout = layoutPathFor(model);
    const before = readFileSync(layout, "utf8");
    process.env.FAKE_AGENT_MODE = "layout";
    await send("touch layout");
    const turn = (await settled()).turns[0]!;
    expect(turn.steps.some((s) => s.summary.startsWith("Reverted a change to the layout file"))).toBe(true);
    expect(turn.changes!.added).toEqual(["A:MEMBER.BirthDate"]);
    expect(readFileSync(layout, "utf8")).not.toContain("E:X");
    expect(JSON.parse(readFileSync(layout, "utf8")).pins).toEqual(JSON.parse(before).pins);
    // The ordinary path never touches the layout file either.
    process.env.FAKE_AGENT_MODE = "noedit";
    await send("nothing");
    const quiet = (await settled()).turns[1]!;
    expect(quiet.changes).toEqual({ added: [], removed: [], modified: [] });
    expect(quiet.steps.some((s) => s.summary.startsWith("Reverted"))).toBe(false);
  });

  it("reports a missing agent executable as an error", async () => {
    await start({ bin: join(dir, "no-such-claude") });
    await send("hello");
    const turn = (await settled()).turns[0]!;
    expect(turn.status).toBe("error");
    expect(turn.error).toMatch(/not found.*\/login/);
    expect(turn.errorKind).toBe("not-found");
  });
});

describe("codex backend", () => {
  beforeEach(() => { process.env.CHEN_AGENT_BIN = FAKE_CODEX; });
  const codex = (agent: Partial<AgentOptions> = {}) => start({ kind: "codex", ...agent });

  it("runs a turn through codex exec --json and resumes its thread", async () => {
    await codex();
    expect(await info()).toMatchObject({ kind: "codex", turns: [] });
    const { turnId } = await (await send("Add a BirthDate attribute", ["E:MEMBER"])).json() as { turnId: string };
    const turn = (await settled()).turns.find((t) => t.id === turnId)!;
    expect(turn).toMatchObject({ status: "ok", reply: "Added BirthDate to the first entity.", changes: { added: ["A:MEMBER.BirthDate"], removed: [], modified: [] } });
    expect(turn.steps).toEqual([
      { kind: "text", summary: "Adding the attribute." },
      { kind: "tool", summary: "Shell cat" },
      { kind: "tool", summary: "Edit club.er.yaml" },
      { kind: "tool", summary: "Shell npx" },
    ]);
    process.env.FAKE_AGENT_MODE = "noedit";
    await send("second");
    await settled();
    const [first, second] = args();
    const prompt = first!.args.at(-1)!;
    expect(first!.cwd).toBe(realpathSync(cwd));
    expect(first!.args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--cd", cwd, "--add-dir", dir, "--skip-git-repo-check", prompt]);
    expect(prompt).toContain(`Model file: ${model}`);
    expect(prompt).toContain("E:MEMBER (MEMBER)");
    expect(second!.args.slice(-3)).toEqual(["resume", "fake-thread-1", second!.args.at(-1)]);
    expect(second!.args.at(-1)!.endsWith("Request:\nsecond")).toBe(true);
  });

  it("classifies codex errors, limits and login failures", async () => {
    process.env.FAKE_AGENT_MODE = "error";
    await codex();
    await send("fail");
    const failed = (await settled()).turns[0]!;
    expect(failed).toMatchObject({ status: "error", errorKind: "other" });
    expect(failed.error!.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `stderr line ${i + 6}`));
    process.env.FAKE_AGENT_MODE = "limit";
    await send("limit");
    expect((await settled()).turns[1]).toMatchObject({ status: "limit", errorKind: "limit", error: "You've hit your usage limit. Try again in 2 hours." });
    process.env.FAKE_AGENT_MODE = "login";
    await send("login");
    expect((await settled()).turns[2]).toMatchObject({ status: "error", errorKind: "not-logged-in" });
  });

  it("cancels a running codex turn and undoes its change", async () => {
    process.env.FAKE_AGENT_MODE = "stubborn";
    await codex({ killAfterMs: 200 });
    const slow = (await (await send("slow")).json() as { turnId: string }).turnId;
    await eventually(async () => (await info()).turns[0]!.steps.length > 0);
    expect((await info()).turns[0]!.steps).toEqual([{ kind: "tool", summary: "Shell cat" }]);
    expect(await (await api(`/api/agent/turns/${slow}/cancel`, { method: "POST" })).json()).toEqual({ status: "cancelled" });
    process.env.FAKE_AGENT_MODE = "ok";
    const { turnId } = await (await send("add")).json() as { turnId: string };
    await settled();
    expect((await api(`/api/agent/turns/${turnId}/undo`, { method: "POST" })).status).toBe(200);
    expect(readFileSync(model, "utf8")).toBe(MODEL);
  });

  it("reports a missing codex executable with the codex login hint", async () => {
    await codex({ bin: join(dir, "no-such-codex") });
    await send("hello");
    const turn = (await settled()).turns[0]!;
    expect(turn).toMatchObject({ status: "error", errorKind: "not-found" });
    expect(turn.error).toMatch(/not found\. Install the Codex CLI, then run `codex login`\./);
  });
});

describe("agent thread persistence", () => {
  const stateFile = () => agentStatePathFor(model);
  const restart = async (agent: Partial<AgentOptions> = {}) => { await viewer?.close(); viewer = undefined; return start(agent); };

  it("keeps the thread, the session and undo across a restart, and never stores the token", async () => {
    await start();
    const { turnId } = await (await send("Add a BirthDate attribute", ["E:MEMBER"])).json() as { turnId: string };
    const before = await settled();
    const token = viewer!.token!;
    const stored = JSON.parse(readFileSync(stateFile(), "utf8")) as { version: number; model: string; kind: string; sessionId: string; entries: { before?: string }[] };
    expect(stored).toMatchObject({ version: 1, model, kind: "claude", sessionId: "fake-session-1" });
    expect(Buffer.from(stored.entries[0]!.before!, "base64").toString("utf8")).toBe(MODEL);
    expect(readFileSync(stateFile(), "utf8")).not.toContain(token);
    await restart();
    expect(viewer!.token).not.toBe(token);
    const after = await info();
    expect(after.turns).toEqual(before.turns);
    expect(after.running).toBeNull();
    await send("again");
    await settled();
    expect(args()[1]!.args.slice(-2)).toEqual(["--resume", "fake-session-1"]);
    expect((await info()).turns.map((t) => t.id)).toEqual([turnId, "t2"]);
    // t2 also added an attribute, so t1 is no longer the latest change; undo t2 after another restart.
    await restart();
    expect((await api(`/api/agent/turns/${turnId}/undo`, { method: "POST" })).status).toBe(409);
    expect((await api("/api/agent/turns/t2/undo", { method: "POST" })).status).toBe(200);
    expect(readFileSync(model, "utf8").match(/BirthDate/g)).toHaveLength(1);
    await restart();
    expect((await info()).turns[1]!.status).toBe("undone");
    expect((await api("/api/agent/turns/t2/undo", { method: "POST" })).status).toBe(409);
  });

  it("refuses undo after a restart when the model changed since the turn", async () => {
    await start();
    const { turnId } = await (await send("add")).json() as { turnId: string };
    await settled();
    await viewer!.close(); viewer = undefined;
    const edited = readFileSync(model, "utf8") + "# edited while the server was down\n";
    writeFileSync(model, edited);
    await start();
    const refused = await api(`/api/agent/turns/${turnId}/undo`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "The model changed after this turn." });
    expect(readFileSync(model, "utf8")).toBe(edited);
  });

  it("turns a turn that was running when the server died into a cancelled one", async () => {
    process.env.FAKE_AGENT_MODE = "slow";
    await start({ killAfterMs: 200 });
    await send("slow");
    await eventually(async () => (await info()).turns[0]!.steps.length > 0);
    const crashed = readFileSync(stateFile(), "utf8");
    expect(JSON.parse(crashed).entries[0].turn.status).toBe("running");
    await viewer!.close(); viewer = undefined;
    // Simulate a crash: the file still says running, and the agent had already edited the model.
    writeFileSync(stateFile(), crashed);
    writeFileSync(model, MODEL.replace("      - MemberId\n", "      - MemberId\n      - Nick\n"));
    process.env.FAKE_AGENT_MODE = "ok";
    await start();
    const turn = (await info()).turns[0]!;
    expect(turn).toMatchObject({ status: "cancelled", notice: INTERRUPTED, changes: { added: ["A:MEMBER.Nick"], removed: [], modified: [] } });
    expect(turn.finishedAt).toBeTruthy();
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).entries[0].turn.status).toBe("cancelled");
    expect((await api(`/api/agent/turns/${turn.id}/undo`, { method: "POST" })).status).toBe(200);
    expect(readFileSync(model, "utf8")).toBe(MODEL);
  });

  it("starts fresh for another agent kind or a broken file, and can stay in memory only", async () => {
    await start();
    await send("add");
    await settled();
    process.env.CHEN_AGENT_BIN = FAKE_CODEX;
    await restart({ kind: "codex" });
    expect((await info()).turns).toEqual([]);
    await viewer!.close(); viewer = undefined;
    writeFileSync(stateFile(), "{ not json");
    await start();
    expect((await info()).turns).toEqual([]);
    rmSync(stateFile());
    await restart({ persist: false });
    await send("add");
    await settled();
    expect(existsSync(stateFile())).toBe(false);
  });
});
