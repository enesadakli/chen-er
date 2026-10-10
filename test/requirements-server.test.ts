import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo, Turn } from "../src/app/agent.js";
import { agentStatePathFor } from "../src/app/agent-store.js";
import type { RequirementsView } from "../src/app/requirements.js";
import { initFile, lintText } from "../src/app/render.js";
import { serve } from "../src/app/serve.js";
import { parseRequirements, textHash } from "../src/core/requirements.js";

const FAKE = resolve("test/fixtures/agent/fake-claude.mjs");
const MODEL = `# Requirements test model.
title: Club
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

let dir: string, model: string, file: string, log: string;
let viewer: Awaited<ReturnType<typeof serve>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-req-"));
  model = join(dir, "club.er.yaml");
  file = join(dir, "club.er.requirements.md");
  log = join(dir, "..", `${dir.split("/").at(-1)}-args.jsonl`);
  writeFileSync(model, MODEL);
  process.env.CHEN_AGENT_BIN = FAKE;
  process.env.FAKE_AGENT_LOG = log;
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_TRACE;
});
afterEach(async () => {
  await viewer?.close();
  viewer = undefined;
  for (const path of [dir, log]) rmSync(path, { recursive: true, force: true });
});

async function start(agent = true) {
  viewer = await serve(model, { port: 0, watch: false, ...(agent ? { agent: { kind: "claude" as const, cwd: dir } } : {}) });
  return viewer;
}
const api = (path: string, init: RequestInit = {}, token = viewer!.token) =>
  fetch(viewer!.url + path, { ...init, headers: { ...(token ? { "X-Chen-Token": token } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers as Record<string, string> } });
const view = async () => await (await api("/api/requirements")).json() as RequirementsView;
const save = (items: { id: string; text: string }[], expectedRevision: string) =>
  api("/api/requirements", { method: "PUT", body: JSON.stringify({ items, expectedRevision }) });
const apply = (expectedRevision?: string) => api("/api/agent/requirements/apply", { method: "POST", body: JSON.stringify(expectedRevision ? { expectedRevision } : {}) });
const info = async () => await (await api("/api/agent")).json() as AgentInfo;
async function eventually(test: () => Promise<boolean> | boolean, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await test()) return; await new Promise((done) => setTimeout(done, 20)); }
  throw new Error("Condition not met in time.");
}
async function settled(): Promise<AgentInfo> {
  await eventually(async () => (await info()).running === null);
  return info();
}
const prompts = () => readFileSync(log, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { args: string[] }).args[1]!);

describe("requirements file routes", () => {
  it("reads an absent file as an empty list and creates it on the first save, atomically", async () => {
    await start(false);
    const empty = await view();
    expect(empty).toMatchObject({ file: "club.er.requirements.md", exists: false, items: [], agent: null });
    expect((await save([], empty.revision)).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    const res = await save([{ id: "r1", text: "Every member joins at least one club." }, { id: "r2", text: "A club has a name." }], empty.revision);
    expect(res.status).toBe(200);
    const saved = await res.json() as RequirementsView;
    expect(saved).toMatchObject({ exists: true, title: "Requirements: Club", items: [{ id: "r1" }, { id: "r2" }] });
    expect(saved.revision).not.toBe(empty.revision);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^# Requirements: Club\n/);
    expect(text).toContain('1. Every member joins at least one club. <!-- chen-er {"id":"r1"} -->\n2. A club has a name.');
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(model, "utf8")).toBe(MODEL);
  });

  it("answers 409 on a stale revision and keeps machine state the client does not send", async () => {
    await start(false);
    const hash = textHash("Members have ids.");
    writeFileSync(file, `# Reqs\n\n1. Members have ids. <!-- chen-er {"id":"r1","applied":"${hash}","trace":["E:MEMBER"]} -->\n`);
    const current = await view();
    expect(current.items).toEqual([{ id: "r1", text: "Members have ids.", applied: hash, trace: ["E:MEMBER"] }]);
    const res = await save([{ id: "r1", text: "Members have ids." }, { id: "r2", text: "Clubs have ids." }], current.revision);
    expect(res.status).toBe(200);
    const doc = parseRequirements(readFileSync(file, "utf8"));
    expect(doc.title).toBe("Reqs");
    expect(doc.items).toEqual([{ id: "r1", text: "Members have ids.", applied: hash, trace: ["E:MEMBER"] }, { id: "r2", text: "Clubs have ids." }]);
    const stale = await save([{ id: "r1", text: "changed" }], current.revision);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toMatch(/changed outside the viewer/);
    // An outside edit to the text also moves the revision.
    const before = (await view()).revision;
    writeFileSync(file, readFileSync(file, "utf8").replace("Clubs have ids.", "Clubs have names."));
    expect((await save([{ id: "r1", text: "x" }], before)).status).toBe(409);
  });

  it("validates bodies and refuses links and oversized files", async () => {
    await start(false);
    const { revision } = await view();
    expect((await save([{ id: "bad", text: "x" }], revision)).status).toBe(400);
    expect((await api("/api/requirements", { method: "PUT", body: JSON.stringify({ items: [] }) })).status).toBe(400);
    expect((await api("/api/requirements", { method: "PUT", body: "x", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    const target = join(dir, "elsewhere.md");
    writeFileSync(target, "1. hidden\n");
    symlinkSync(target, file);
    expect((await api("/api/requirements")).status).toBe(403);
    expect((await save([{ id: "r1", text: "x" }], revision)).status).toBe(403);
    expect(readFileSync(target, "utf8")).toBe("1. hidden\n");
    rmSync(file);
    linkSync(target, file);
    expect((await save([{ id: "r1", text: "x" }], revision)).status).toBe(403);
    rmSync(file);
    writeFileSync(file, "x".repeat(1_048_577));
    expect((await api("/api/requirements")).status).toBe(413);
  });

  it("refuses requests from another origin or host", async () => {
    await start(false);
    const { revision } = await view();
    expect((await api("/api/requirements", { method: "PUT", body: JSON.stringify({ items: [], expectedRevision: revision }), headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("announces outside edits on the event stream", async () => {
    viewer = await serve(model, { port: 0 });
    const abort = new AbortController();
    const events = await fetch(`${viewer.url}/api/events`, { signal: abort.signal });
    const reader = events.body!.getReader();
    let text = "";
    const reading = (async () => {
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } }
      catch { /* aborted */ }
    })();
    try {
      writeFileSync(file, "# R\n\n- Written in Obsidian\n");
      await eventually(() => /event: requirements\ndata: .*Written in Obsidian/.test(text));
    } finally { abort.abort(); await reading; }
  });
});

describe("requirements apply", () => {
  it("is an agent route: 404 without --agent, 403 without the token", async () => {
    await start(false);
    expect((await apply()).status).toBe(404);
    await viewer!.close();
    await start();
    expect((await api("/api/agent/requirements/apply", { method: "POST", body: "{}" }, "")).status).toBe(403);
    expect((await view()).agent).toBe("claude");
  });

  it("serves an empty init and fills it through Requirements Apply", async () => {
    initFile(model, true, { empty: true, title: "Club" });
    const emptySource = readFileSync(model, "utf8");
    process.env.FAKE_AGENT_MODE = "empty";
    await start();
    const before = await (await api("/api/state")).json();
    expect(before.diagram).toMatchObject({ title: "Club", nodes: [], edges: [], labels: [] });
    expect(before.svg).toContain('data-id="title"');
    expect(before.diagnostics.filter((d: { severity: string }) => d.severity === "error")).toEqual([]);
    const current = await (await save([{ id: "r1", text: "Members have an id and a birth date." }], (await view()).revision)).json() as RequirementsView;
    expect((await apply(current.revision)).status).toBe(202);
    const turn = (await settled()).turns.at(-1)!;
    expect(turn.status).toBe("ok");
    expect(turn.changes!.added).toEqual(expect.arrayContaining(["E:MEMBER", "A:MEMBER.MemberId", "A:MEMBER.BirthDate"]));
    await eventually(async () => (await view()).items[0]!.applied !== undefined);
    expect((await view()).items[0]!.trace).toEqual(["A:MEMBER.BirthDate", "E:MEMBER"]);
    expect(lintText(readFileSync(model, "utf8")).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const after = await (await api("/api/state")).json();
    expect(after.diagram.nodes.map((n: { id: string }) => n.id)).toContain("E:MEMBER");
    expect((await api(`/api/agent/turns/${turn.id}/undo`, { method: "POST" })).status).toBe(200);
    expect(readFileSync(model, "utf8")).toBe(emptySource);
  });

  it("applies only new and changed lines, validates the trace and records it per line", async () => {
    await start();
    let current = await view();
    expect((await apply(current.revision)).status).toBe(409); // nothing to apply
    const items = [
      { id: "r1", text: "Members have a birth date." },
      { id: "r2", text: "A member joins clubs." },
      { id: "r3", text: "Clubs meet in rooms." },
      { id: "r4", text: "Each room has a capacity." },
    ];
    current = await (await save(items, current.revision)).json() as RequirementsView;
    expect((await apply("stale")).status).toBe(409);
    const res = await apply(current.revision);
    expect(res.status).toBe(202);
    const { turnId } = await res.json() as { turnId: string };
    const thread = await settled();
    const turn = thread.turns.find((t) => t.id === turnId)!;
    expect(turn).toMatchObject({ status: "ok", text: "Apply requirements R1, R2, R3, R4 to the model", reply: "Added BirthDate to MEMBER.",
      changes: { added: ["A:MEMBER.BirthDate"], removed: [], modified: [] } });
    expect(turn.requirements).toMatchObject({ ids: ["r1", "r2", "r3", "r4"], labels: ["R1", "R2", "R3", "R4"],
      trace: { r1: { elements: ["A:MEMBER.BirthDate", "E:MEMBER"], why: "MEMBER records the birth date.", dropped: ["E:GHOST"] }, r2: { elements: [] } } });
    const prompt = prompts()[0]!;
    expect(prompt).toContain("Requirements to apply now (new or changed since the last apply):\nr1 (R1): Members have a birth date.  [new]\n");
    expect(prompt).toContain("All requirements, for context:\n");
    await eventually(async () => (await view()).items[0]!.applied !== undefined);
    const after = await view();
    expect(after.revision).toBe(current.revision);
    expect(after.items[0]).toEqual({ id: "r1", text: "Members have a birth date.", applied: textHash("Members have a birth date."), trace: ["A:MEMBER.BirthDate", "E:MEMBER"], why: "MEMBER records the birth date." });
    expect(after.items[1]).toMatchObject({ applied: textHash("A member joins clubs."), trace: [], why: "Nothing in the model covers it yet." });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("   *→ BirthDate (MEMBER), MEMBER. MEMBER records the birth date.*");
    expect(text).toContain("   *△ Not reflected in the model. Nothing in the model covers it yet.*");

    // Change one line: only that line goes to the agent; the rest stays context.
    const changed = await (await save([items[0]!, { id: "r2", text: "A member joins one or more clubs." }, items[2]!, items[3]!], after.revision)).json() as RequirementsView;
    expect(changed.items[1]).toMatchObject({ applied: textHash("A member joins clubs."), trace: [] });
    expect((await apply(changed.revision)).status).toBe(202);
    await settled();
    const second = prompts()[1]!;
    const now = second.split("Requirements to apply now (new or changed since the last apply):\n")[1]!.split("\n\n")[0];
    expect(now).toBe("r2 (R2): A member joins one or more clubs.  [changed]");
    expect(second).toContain("r1 (R1): Members have a birth date.\nr2 (R2): A member joins one or more clubs.\nr3 (R3)");
  });

  it("marks every applied line not covered when no trace comes back, and leaves lines unapplied when the turn fails", async () => {
    await start();
    process.env.FAKE_AGENT_TRACE = "none";
    let current = await (await save([{ id: "r1", text: "Members have a birth date." }], (await view()).revision)).json() as RequirementsView;
    await apply(current.revision);
    let turn = (await settled()).turns.at(-1)!;
    expect(turn.requirements).toMatchObject({ noTrace: true, trace: {} });
    await eventually(async () => (await view()).items[0]!.applied !== undefined);
    expect((await view()).items[0]).toMatchObject({ trace: [] });

    process.env.FAKE_AGENT_MODE = "error";
    current = await (await save([{ id: "r1", text: "Members have a birth date." }, { id: "r2", text: "x" }], (await view()).revision)).json() as RequirementsView;
    await apply(current.revision);
    turn = (await settled()).turns.at(-1)!;
    expect(turn.status).toBe("error");
    expect((await view()).items[1]).toEqual({ id: "r2", text: "x" });
  });

  it("undo of the apply turn restores the model and the lines' earlier state", async () => {
    await start();
    const current = await (await save([{ id: "r1", text: "Members have a birth date." }], (await view()).revision)).json() as RequirementsView;
    await apply(current.revision);
    const turn = (await settled()).turns.at(-1)! as Turn;
    await eventually(async () => (await view()).items[0]!.applied !== undefined);
    const undo = await api(`/api/agent/turns/${turn.id}/undo`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(readFileSync(model, "utf8")).toBe(MODEL);
    expect((await view()).items[0]).toEqual({ id: "r1", text: "Members have a birth date." });
    // The thread file keeps the apply meta, so undo state survives a restart.
    const stored = JSON.parse(readFileSync(agentStatePathFor(model), "utf8")) as { entries: { turn: Turn }[] };
    expect(stored.entries[0]!.turn).toMatchObject({ status: "undone", requirements: { ids: ["r1"], before: { r1: {} } } });
  });
});
