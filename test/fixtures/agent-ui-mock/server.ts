/**
 * Dev-only mock of the agent API (docs/agent-panel.md) for manual viewer checks. Not shipped, not a test.
 * Runs the real `serve` upstream and proxies it, adding /api/agent* routes and `agent-turn` SSE events.
 *   npx tsx test/fixtures/agent-ui-mock/server.ts [--port 5190] [--scenario empty|thread] [--no-agent]
 */
import { createServer, request, type ServerResponse } from "node:http";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../../../src/app/serve.js";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg("--port") ?? 5190);
const scenario = arg("--scenario") ?? "empty";
const agentOn = !process.argv.includes("--no-agent");
const token = "mock-token";
const dir = mkdtempSync(join(tmpdir(), "chen-agent-mock-"));
const model = join(dir, "library.er.yaml");
copyFileSync(new URL("../../../examples/library.er.yaml", import.meta.url), model);
const upstreamPort = port + 1;
await serve(model, { port: upstreamPort });

type Turn = Record<string, unknown> & { id: string; status: string; steps: { kind: string; summary: string }[] };
const turns: Turn[] = [];
const snapshots = new Map<string, string>();
let running: string | null = null;
let seq = 0;
const clients = new Set<ServerResponse>();
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const emit = (turn: Turn) => { for (const c of clients) c.write(`event: agent-turn\ndata: ${JSON.stringify(turn)}\n\n`); };

if (scenario === "thread") {
  turns.push(
    { id: "t1", text: "Add a Phone attribute to MEMBER", selection: ["E:MEMBER"], startedAt: iso(-600000), finishedAt: iso(-590000), status: "ok",
      reply: "Added Phone to MEMBER and made BORROWS carry a ReturnDate.", steps: [{ kind: "tool", summary: "Read library.er.yaml" }, { kind: "tool", summary: "Edit library.er.yaml" }, { kind: "tool", summary: "Bash chen lint library.er.yaml" }],
      changes: { added: ["A:MEMBER.Email"], modified: ["R:BORROWS"], removed: ["R:HAS"] } },
    { id: "t2", text: "Rename COPY to ITEM", selection: [], startedAt: iso(-400000), finishedAt: iso(-398000), status: "error", steps: [],
      error: "Error: stream closed unexpectedly\n    at Socket.<anonymous> (cli.js:12:3)\nexit code 1" },
    { id: "t3", text: "Explain the heuristic findings", selection: [], startedAt: iso(-300000), finishedAt: iso(-299000), status: "limit", steps: [] },
    { id: "t4", text: "Make BORROWS one-to-many", selection: ["R:BORROWS", "E:MEMBER"], startedAt: iso(-200000), finishedAt: iso(-190000), status: "ok",
      reply: "BORROWS now allows many copies per member but one member per copy.", steps: [{ kind: "tool", summary: "Edit library.er.yaml" }],
      changes: { added: [], modified: ["R:BORROWS"], removed: [] } },
    { id: "t5", text: "Add a Genre attribute to BOOK and keep it optional", selection: ["E:BOOK"], startedAt: iso(-12000), status: "running",
      steps: [{ kind: "tool", summary: "Read library.er.yaml" }, { kind: "tool", summary: "Edit library.er.yaml" }] },
  );
  running = "t5";
}

function run(turn: Turn) {
  const before = readFileSync(model, "utf8");
  snapshots.set(turn.id, before);
  const step = (summary: string, delay: number) => setTimeout(() => { if (turn.status !== "running") return; turn.steps.push({ kind: "tool", summary }); emit(turn); }, delay);
  step("Read library.er.yaml", 600); step("Edit library.er.yaml", 1400); step("Bash chen lint library.er.yaml", 2200);
  const done = setTimeout(() => {
    if (turn.status !== "running") return;
    const text = String(turn.text);
    if (/fail/i.test(text)) Object.assign(turn, { status: "error", error: "claude: Credit balance check failed\nexit 1", finishedAt: iso() });
    else if (/missing/i.test(text)) Object.assign(turn, { status: "error", error: "spawn claude ENOENT", finishedAt: iso() });
    else {
      writeFileSync(model, before.replace("attrs: [ISBN, Title,", "attrs: [ISBN, Title, Genre,"));
      Object.assign(turn, { status: "ok", reply: "Added Genre to BOOK as a simple attribute.", changes: { added: ["A:BOOK.Genre"], removed: [], modified: [] }, finishedAt: iso() });
    }
    running = null; emit(turn);
  }, 3200);
  turn.cancel = () => { clearTimeout(done); Object.assign(turn, { status: "cancelled", finishedAt: iso() }); running = null; emit(turn); };
}

const send = (res: ServerResponse, status: number, value?: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
const read = (req: import("node:http").IncomingMessage) => new Promise<string>((ok) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => ok(s)); });

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith("/api/agent")) {
    if (!agentOn) return send(res, 404, { error: "Not found" });
    if (req.headers["x-chen-token"] !== token) return send(res, 403, {});
    if (req.method === "GET" && url.pathname === "/api/agent") return send(res, 200, { enabled: true, kind: "claude", cwd: dir, running, turns });
    if (req.method === "POST" && url.pathname === "/api/agent/turns") {
      const body = JSON.parse(await read(req)) as { text: string; selection: string[] };
      if (running) return send(res, 409, { error: "A turn is running." });
      const turn: Turn = { id: `m${++seq}`, text: body.text, selection: body.selection, startedAt: iso(), status: "running", steps: [] };
      turns.push(turn); running = turn.id; send(res, 202, { turnId: turn.id }); emit(turn); run(turn); return;
    }
    const match = /^\/api\/agent\/turns\/([^/]+)\/(cancel|undo)$/.exec(url.pathname);
    const turn = match && turns.find((t) => t.id === decodeURIComponent(match[1]!));
    if (req.method === "POST" && turn && match[2] === "cancel") { if (turn.status === "running") (turn.cancel as () => void)?.(); return send(res, 200, { status: turn.status }); }
    if (req.method === "POST" && turn && match[2] === "undo") {
      const snap = snapshots.get(turn.id);
      if (!snap) return send(res, 409, { error: "the model changed after this turn" });
      writeFileSync(model, snap); turn.status = "undone"; emit(turn); return send(res, 200, { status: "undone" });
    }
    return send(res, 404, { error: "Not found" });
  }
  const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
  delete headers.origin;
  const upstream = request({ host: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    if (url.pathname === "/api/events") { clients.add(res); req.on("close", () => clients.delete(res)); }
    up.pipe(res);
  });
  req.pipe(upstream);
}).listen(port, "127.0.0.1", () => console.log(`mock: http://127.0.0.1:${port}/?t=${token}  (model ${model})`));
