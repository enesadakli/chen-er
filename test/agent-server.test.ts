import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo, Turn } from "../src/app/agent.js";
import { layoutPathFor } from "../src/app/render.js";
import { serve, type AgentOptions } from "../src/app/serve.js";

const FAKE = resolve("test/fixtures/agent/fake-claude.mjs");
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
    expect(first!.args).toEqual(["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--add-dir", dir]);
    expect(prompt).toContain(`Model file: ${model}`);
    expect(prompt).toContain("E:MEMBER (MEMBER)\nA:MEMBER.MemberId (MemberId)\nE:NOPE\n");
    expect(prompt).toMatch(/run `(npx tsx|node) \S+ lint \S+club\.er\.yaml` and fix any errors/);
    expect(prompt).toContain("Never edit *.er.layout.json files.");
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
    expect(failed.error!.split("\n")).toEqual(Array.from({ length: 20 }, (_, i) => `stderr line ${i + 6}`));
    process.env.FAKE_AGENT_MODE = "limit";
    await send("limit");
    expect((await settled()).turns[1]!.status).toBe("limit");
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
  });
});
