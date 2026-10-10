import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, extname, join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import type { Diagram, LayoutOptions, Pins, Point } from "../core/geometry.js";
import { DEFAULT_ENGINE, layout } from "../core/layout/index.js";
import { renderSvg } from "../core/render/svg.js";
import type { QualityReport } from "../core/quality.js";
import { LayoutFile } from "../core/schema.js";
import { diagramPositions, layoutPathFor, lintText, quality, readPins, svgToPng, formatLayoutFile, type LayoutFilePatch } from "./render.js";
import { diagnosticTarget } from "./targets.js";
import { fileBytes, GuardError, replaceBytes, revision } from "./file-guard.js";
import { selectionMetadata, type SelectionMetadata } from "../viewer/selection.js";
import { AgentError, createAgent, parseTurnRequest, type AgentController, type AgentKind, type Turn } from "./agent.js";
import { lintCommandFor } from "./agent-prompt.js";
import { agentStatePathFor } from "./agent-store.js";
import { createRequirements, requirementsPathFor, RequirementsError, type RequirementsView } from "./requirements.js";
import { modelStructure, preferFresh } from "./auto-relayout.js";

export interface ViewerDiagnostic extends Diagnostic { target?: string }
export interface ViewerState {
  modelPath: string;
  title: string;
  engine: NonNullable<LayoutOptions["engine"]>;
  svg: string | null;
  diagram: Diagram | null;
  diagnostics: ViewerDiagnostic[];
  quality: QualityReport | null;
  pins: Pins;
  yaml: string;
  updatedAt: string;
  layoutRevision: string;
  computing: boolean;
  /** The accepted layout was automatically replaced after a structural model change. */
  autoRelayout?: boolean;
  history: { canUndo: boolean; canRedo: boolean };
  selection: SelectionMetadata;
}
export interface AgentOptions {
  kind: AgentKind;
  /** Agent working directory (default: the model's directory). */
  cwd?: string;
  /** Executable (default: env CHEN_AGENT_BIN, then the kind: "claude" or "codex"). */
  bin?: string;
  /** Command prefix the agent runs as `<lintCommand> <model>` (default: derived from how this process started). */
  lintCommand?: string;
  /** Delay between SIGTERM and SIGKILL on cancel (default 3000 ms). */
  killAfterMs?: number;
  /** Keep the thread in `<model>.er.agent.json` across restarts (default true). */
  persist?: boolean;
}
export interface ServeOptions {
  port?: number; open?: boolean; engine?: LayoutOptions["engine"]; agent?: AgentOptions;
  /** Use fs.watch for fast reaction to file edits (default true). The stat poll always runs as a fallback. */
  watch?: boolean;
}
/** How often the fallback poll compares the model and layout file stats. */
const POLL_MS = 1000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let viewerBuild: Promise<void> | undefined;

async function ensureViewer(): Promise<string> {
  const viewer = join(root, "dist/viewer");
  if (!existsSync(join(viewer, "index.html"))) {
    viewerBuild ??= (async () => {
      try {
        const vite = await import("vite");
        await vite.build({ configFile: join(root, "vite.config.ts"), logLevel: "warn" });
      } catch (error) {
        throw new Error(`Build the viewer with vite build before serving: ${(error as Error).message}`);
      }
    })();
    await viewerBuild;
  }
  return viewer;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Use application/json.");
  }
  if (Number(req.headers["content-length"]) > 1_048_576) throw new HttpError(413, "Body exceeds 1 MB.");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1_048_576) throw new HttpError(413, "Body exceeds 1 MB.");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "Expected a JSON object."); }
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new HttpError(400, "Unexpected field.");
}

export async function serve(model: string, options: ServeOptions = {}) {
  const port = options.port ?? 5178;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535.");
  if (options.engine && !["simple", "layered", "stress"].includes(options.engine)) throw new Error("Unknown engine.");
  const modelPath = resolve(model);
  readFileSync(modelPath, "utf8");
  const pinsPath = layoutPathFor(modelPath);
  if (pinsPath === modelPath) throw new Error("Model and layout paths must differ.");
  const agentCwd = options.agent ? resolve(options.agent.cwd ?? dirname(modelPath)) : undefined;
  if (agentCwd && (!existsSync(agentCwd) || !lstatSync(agentCwd).isDirectory())) throw new Error(`Agent working directory not found: ${agentCwd}`);
  const viewer = await ensureViewer();
  const clients = new Set<ServerResponse>();
  let requestedEngine = options.engine;
  let state: ViewerState;
  let updatedTime = 0;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };
  /** Text of our last write to the layout file; the watcher ignores events that only see it. */
  let lastWrite: string | undefined;
  /** While an agent turn runs the server does not auto-save positions, so any layout change is a deliberate write. */
  let agentRunning = (): boolean => false;
  // A running turn may publish intermediate models, but cannot advance the accepted structure.
  let goodStructure: string | undefined;
  type Snapshot = { model: Buffer | null; layout: Buffer | null; engine: typeof requestedEngine };
  // History holds layout-file bytes and the engine only; the model file is never part of it.
  type LayoutSnap = Pick<Snapshot, "layout" | "engine">;
  type Entry = { before: LayoutSnap; after: LayoutSnap };
  const undo: Entry[] = [], redo: Entry[] = [];
  let externalEpoch = 0;
  const snapshot = (): Snapshot => ({ model: fileBytes(modelPath), layout: fileBytes(pinsPath), engine: requestedEngine });
  let observed = snapshot();
  const same = (a: Snapshot, b: Snapshot) => revision(a.model) === revision(b.model) && revision(a.layout) === revision(b.layout);
  function publish() {
    updatedTime = Math.max(Date.now(), updatedTime + 1);
    state.updatedAt = new Date(updatedTime).toISOString();
    state.history = { canUndo: undo.length > 0, canRedo: redo.length > 0 };
    for (const client of clients) client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }
  function boundary() {
    const current = snapshot();
    if (!same(current, observed)) { externalEpoch++; undo.length = 0; redo.length = 0; observed = current; }
  }
  async function synchronize(value: Record<string, unknown>, required = false) {
    guardLayoutPath();
    const current = snapshot();
    const changed = !same(current, observed);
    boundary();
    const bad = required && typeof value.expectedLayoutRevision !== "string";
    const stale = value.expectedLayoutRevision !== undefined && value.expectedLayoutRevision !== revision(current.layout);
    if (changed) await refresh();
    if (bad) throw new HttpError(400, "Expected layout revision is required.");
    if (stale) throw new HttpError(409, "The model or layout changed. Review the current diagram and retry.");
    return snapshot();
  }
  async function edit(value: Record<string, unknown>, task: () => Promise<ViewerState>) {
    const before = await synchronize(value);
    const epoch = externalEpoch;
    try {
      const next = await task();
      const after = snapshot();
      if (epoch !== externalEpoch || !same(after, observed)) { boundary(); throw new HttpError(409, "The files changed externally while computing. Reload and retry."); }
      if (revision(before.layout) !== revision(after.layout) || before.engine !== after.engine) {
        undo.push({ before: { layout: before.layout, engine: before.engine }, after: { layout: after.layout, engine: after.engine } }); if (undo.length > 50) undo.shift(); redo.length = 0;
      }
      publish(); return next;
    } catch (error) {
      boundary();
      await refresh();
      throw error;
    }
  }
  async function refresh(fresh = false, savePositions = true): Promise<ViewerState> {
    boundary();
    const inputs = snapshot();
    const duringTurn = agentRunning();
    if (state) { state.computing = true; publish(); }
    let yaml = "";
    let diagnostics: ViewerDiagnostic[] = [];
    let diagram: Diagram | null = null;
    let svg: string | null = null;
    let selection: SelectionMetadata = { owners: [], relationships: [] };
    let title = basename(modelPath);
    let nextStructure: string | undefined;
    let autoRelayout = false;
    let measured: QualityReport | null = null;
    const saved = readPins(modelPath);
    let pins = saved.options.pins ?? {};
    const engine = requestedEngine ?? saved.options.engine ?? DEFAULT_ENGINE;
    try {
      yaml = readFileSync(modelPath, "utf8");
      const parsed = lintText(yaml);
      title = parsed.model?.title ?? title;
      selection = selectionMetadata(parsed.model);
      let all = [...parsed.diagnostics, ...saved.diagnostics];
      if (parsed.model && !hasErrors(parsed.diagnostics)) {
        // Incremental by default: the last accepted positions keep untouched nodes in place.
        const positions = fresh ? undefined : saved.options.positions;
        nextStructure = modelStructure(parsed.model);
        let result = await layout(parsed.model, { engine, pins, positions });
        let freshWins = false;
        if (!fresh && savePositions && !duringTurn && !agentRunning() && !saved.diagnostics.length
          && goodStructure !== undefined && nextStructure !== goodStructure) {
          measured = quality(result.diagram, pins);
          const candidate = await layout(parsed.model, { engine, pins });
          const candidateQuality = quality(candidate.diagram, pins);
          if (preferFresh(measured, candidateQuality)) {
            result = candidate; measured = candidateQuality; freshWins = true;
          }
        }
        diagram = result.diagram;
        svg = renderSvg(diagram);
        all = [...all, ...result.diagnostics];
        if (savePositions && !duringTurn && !agentRunning() && !saved.diagnostics.length && same(snapshot(), inputs)) {
          try {
            writeLayout({ positions: diagramPositions(diagram) }, inputs, diagram);
            pins = readPins(modelPath).options.pins ?? {};
            if (freshWins && revision(inputs.layout) !== revision(fileBytes(pinsPath))) {
              undo.push({ before: { layout: inputs.layout, engine: inputs.engine }, after: { layout: fileBytes(pinsPath), engine: requestedEngine } });
              if (undo.length > 50) undo.shift(); redo.length = 0;
              autoRelayout = true;
            }
          }
          catch (error) { all.push({ rule: "layout-file", severity: "warning", message: `Positions not saved: ${(error as Error).message}` }); }
        }
      }
      diagnostics = all.map((d) => ({ ...d, target: diagnosticTarget(d.path, parsed.model) }));
    } catch (error) {
      diagnostics = [{ rule: "io", severity: "error", message: (error as Error).message, hint: "Restore the model file and save it again." }];
    }
    const current = snapshot();
    if (revision(current.model) !== revision(inputs.model) || (revision(current.layout) !== revision(inputs.layout) && fileBytes(pinsPath)?.toString("utf8") !== lastWrite)) {
      boundary();
      return refresh(fresh, savePositions);
    }
    observed = current;
    if (diagram && nextStructure !== undefined && !duringTurn && !agentRunning()) goodStructure = nextStructure;
    state = { modelPath, title, engine, svg, diagram, diagnostics, pins, yaml, selection,
      layoutRevision: revision(current.layout), computing: false, autoRelayout,
      history: { canUndo: undo.length > 0, canRedo: redo.length > 0 },
      quality: diagram ? measured ?? quality(diagram, pins) : null, updatedAt: "" };
    publish();
    return state;
  }
  await refresh();
  function guardLayoutPath(): void {
    // Refuse symlinks so a layout file cannot redirect a write to another file.
    let stat;
    try { stat = lstatSync(pinsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new HttpError(403, "The layout path must be a regular file without links.");
    }
    if (existsSync(pinsPath)) {
      try { LayoutFile.parse(JSON.parse(readFileSync(pinsPath, "utf8"))); }
      catch { throw new HttpError(409, "Fix or delete the invalid layout file before writing pins."); }
    }
  }
  function writeLayout(patch: LayoutFilePatch, expected?: Snapshot, diagram: Diagram | null = state?.diagram ?? null): void {
    guardLayoutPath();
    if (expected && !same(snapshot(), expected)) throw new HttpError(409, "The files changed externally during layout.");
    const before = fileBytes(pinsPath);
    const current = before ? LayoutFile.parse(JSON.parse(before.toString("utf8"))) : { pins: {} };
    const text = formatLayoutFile(current, patch, diagram ?? undefined);
    if (expected && revision(fileBytes(modelPath)) !== revision(expected.model)) throw new HttpError(409, "The model changed externally during layout.");
    replaceBytes(pinsPath, before, Buffer.from(text));
    lastWrite = text;
  }
  function persist(pins: Pins, engine?: LayoutOptions["engine"]): void {
    const parsed = LayoutFile.parse({ version: 1, pins, ...(engine ? { engine } : {}) });
    writeLayout({ pins: parsed.pins, ...(parsed.engine ? { engine: parsed.engine } : {}) });
  }
  const token = options.agent ? randomBytes(32).toString("base64url") : undefined;
  const lintCommand = options.agent?.lintCommand ?? lintCommandFor(process.argv[1], root);
  const requirementsPath = requirementsPathFor(modelPath);
  if ([modelPath, pinsPath].includes(requirementsPath)) throw new Error("Model and requirements paths must differ.");
  const requirements = createRequirements({
    path: requirementsPath, modelPath, agent: options.agent?.kind ?? null, lintCommand, serial,
    emit: (view: RequirementsView) => { for (const client of clients) client.write(`event: requirements\ndata: ${JSON.stringify(view)}\n\n`); },
  });
  const agent: AgentController | undefined = options.agent && agentCwd ? createAgent({
    kind: options.agent.kind,
    cwd: agentCwd,
    modelPath,
    layoutPath: pinsPath,
    bin: options.agent.bin ?? process.env.CHEN_AGENT_BIN ?? options.agent.kind,
    lintCommand,
    killAfterMs: options.agent.killAfterMs,
    ...(options.agent.persist !== false ? { statePath: agentStatePathFor(modelPath) } : {}),
    emit: (turn: Turn) => { for (const client of clients) client.write(`event: agent-turn\ndata: ${JSON.stringify(turn)}\n\n`); },
    writeModel: (expected, next) => serial(async () => { replaceBytes(modelPath, expected, next); }),
    writeLayout: (expected, next) => serial(async () => { guardLayoutPath(); replaceBytes(pinsPath, expected, next); }),
    isServerLayout: (bytes) => bytes !== null && lastWrite !== undefined && bytes.toString("utf8") === lastWrite,
    afterTurn: (modelChanged) => { if (modelChanged && !closed) void serial(() => refresh()).catch(() => undefined); },
    onUndo: (turn) => requirements.undo(turn),
  }) : undefined;
  if (agent) agentRunning = () => agent.info().running !== null;
  const tokenMatches = (value: string | string[] | undefined): boolean => {
    if (!token || typeof value !== "string") return false;
    const a = Buffer.from(value), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  async function agentRoute(req: IncomingMessage, res: ServerResponse, path: string, trusted: boolean): Promise<void> {
    // 403 without detail: do not reveal which check failed.
    if (!trusted) throw new HttpError(403, "Forbidden.");
    if (!agent) throw new HttpError(404, "Unknown route.");
    if (!tokenMatches(req.headers["x-chen-token"])) throw new HttpError(403, "Forbidden.");
    if (req.method === "GET" && path === "/api/agent") return json(res, 200, agent.info());
    if (req.method === "POST" && path === "/api/agent/turns") {
      const turnId = agent.start(parseTurnRequest(await body(req)));
      return json(res, 202, { turnId });
    }
    if (req.method === "POST" && path === "/api/agent/requirements/apply") {
      const value = Number(req.headers["content-length"]) > 0 || !!req.headers["transfer-encoding"] ? await body(req) : {};
      if (agent.info().running) throw new HttpError(409, "A turn is already running.");
      const { text, plan } = requirements.plan(value);
      return json(res, 202, { turnId: agent.start({ text, selection: [] }, plan) });
    }
    const match = /^\/api\/agent\/turns\/([\w-]{1,64})\/(cancel|undo)$/.exec(path);
    if (req.method === "POST" && match) {
      req.resume();
      return json(res, 200, match[2] === "cancel" ? await agent.cancel(match[1]!) : await agent.undo(match[1]!));
    }
    throw new HttpError(404, "Unknown route.");
  }
  const server = createServer((req, res) => {
    void (async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const origin = `http://127.0.0.1:${actualPort}`;
      const hostOk = req.headers.host === `127.0.0.1:${actualPort}` || req.headers.host === `localhost:${actualPort}`;
      const originOk = !req.headers.origin || req.headers.origin === origin || req.headers.origin === `http://localhost:${actualPort}`;
      const rawPath = (req.url ?? "/").split("?")[0]!;
      if (rawPath === "/api/agent" || rawPath.startsWith("/api/agent/")) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        return agentRoute(req, res, rawPath, hostOk && originOk);
      }
      if (req.headers.host !== `127.0.0.1:${actualPort}` && req.headers.host !== `localhost:${actualPort}`) {
        throw new HttpError(403, "Invalid host.");
      }
      if (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== `http://localhost:${actualPort}`) {
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/state") { await queue; return json(res, 200, state); }
      if (req.method === "GET" && path === "/api/requirements") { await queue; return json(res, 200, requirements.view()); }
      if (req.method === "PUT" && path === "/api/requirements") return json(res, 200, await requirements.save(await body(req)));
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && ["/api/export.svg", "/api/export.png"].includes(path)) {
        await queue;
        if (!state.svg) throw new HttpError(409, "Fix model errors before exporting.");
        const png = path.endsWith(".png");
        const scale = Number(url.searchParams.get("scale") ?? 2);
        if (png && (!Number.isFinite(scale) || scale <= 0 || scale > 8)) throw new HttpError(400, "Scale must be greater than 0 and at most 8.");
        res.writeHead(200, { "Content-Type": png ? "image/png" : "image/svg+xml", "Content-Disposition": `attachment; filename="diagram.${png ? "png" : "svg"}"`, "Cache-Control": "no-store" });
        res.end(png ? svgToPng(state.svg, scale) : state.svg);
        return;
      }
      if (req.method === "POST" && ["/api/history/undo", "/api/history/redo"].includes(path)) {
        const value = await body(req); onlyKeys(value, ["expectedLayoutRevision"]);
        const next = await serial(async () => {
          const before = await synchronize(value, true);
          const source = path.endsWith("undo") ? undo : redo, target = path.endsWith("undo") ? redo : undo;
          const entry = source.at(-1);
          if (!entry) throw new HttpError(409, "No history remains. External edits start a new history boundary.");
          const restored = path.endsWith("undo") ? entry.before : entry.after;
          if (!same(snapshot(), before)) { boundary(); throw new HttpError(409, "The files changed externally. History was cleared."); }
          try {
            if (revision(before.layout) !== revision(restored.layout)) replaceBytes(pinsPath, before.layout, restored.layout);
          } catch (error) { boundary(); await refresh(false, false); throw error; }
          requestedEngine = restored.engine;
          lastWrite = restored.layout?.toString("utf8");
          observed = snapshot(); source.pop(); target.push(entry);
          const epoch = externalEpoch;
          const next = await refresh(false, false);
          if (epoch !== externalEpoch) throw new HttpError(409, "The files changed externally while restoring. History was cleared.");
          return next;
        });
        return json(res, 200, next);
      }
      if (req.method === "POST" && path === "/api/relayout") {
        const hasBody = Number(req.headers["content-length"]) > 0 || !!req.headers["transfer-encoding"];
        const value = hasBody ? await body(req) : {}; onlyKeys(value, ["expectedLayoutRevision"]);
        const next = await serial(() => edit(value, async () => {
          writeLayout({ positions: null });
          observed = snapshot();
          return refresh(true);
        }));
        return json(res, 200, next);
      }
      const pinsRoute = path === "/api/pins" || path.startsWith("/api/pins/");
      if ((req.method === "POST" && path === "/api/pins") || (req.method === "DELETE" && pinsRoute) || (req.method === "POST" && path === "/api/engine")) {
        const hasBody = Number(req.headers["content-length"]) > 0 || !!req.headers["transfer-encoding"];
        const value = req.method === "POST" || hasBody ? await body(req) : {};
        if (req.method === "DELETE") onlyKeys(value, ["expectedLayoutRevision"]);
        const next = await serial(() => edit(value, async () => {
          const saved = readPins(modelPath).options;
          const pins = { ...saved.pins };
          let engine = saved.engine;
          if (path === "/api/engine") {
            onlyKeys(value, ["engine", "expectedLayoutRevision"]);
            const parsed = LayoutFile.safeParse({ version: 1, engine: value.engine, pins });
            if (!parsed.success || !parsed.data.engine) throw new HttpError(400, "Engine must be layered, stress or simple.");
            engine = parsed.data.engine;
          } else if (req.method === "POST") {
            onlyKeys(value, ["pins", "expectedLayoutRevision"]);
            const parsed = LayoutFile.safeParse({ version: 1, pins: value.pins });
            if (!parsed.success || !value.pins) throw new HttpError(400, "Expected finite pin coordinates.");
            const ids = new Set(state.diagram?.nodes.map((n) => n.id));
            for (const [id, point] of Object.entries(parsed.data.pins)) {
              if (!ids.has(id)) throw new HttpError(400, `Unknown diagram node: ${id}`);
              pins[id] = point;
            }
          } else if (path === "/api/pins") {
            for (const id of Object.keys(pins)) delete pins[id];
          } else {
            let id: string;
            try { id = decodeURIComponent(path.slice("/api/pins/".length)); }
            catch { throw new HttpError(400, "Invalid pin id."); }
            delete pins[id];
          }
          persist(pins, engine);
          observed = snapshot();
          if (path === "/api/engine") {
            requestedEngine = undefined;
            // A new engine means a new drawing: start from scratch instead of keeping old positions.
            writeLayout({ positions: null });
            observed = snapshot();
            return refresh(true);
          }
          return refresh();
        }));
        return json(res, 200, next);
      }
      if (path.startsWith("/api/") || req.method !== "GET") throw new HttpError(404, "Unknown route.");
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, "Invalid path."); }
      const file = resolve(viewer, decoded === "/" ? "index.html" : `.${decoded}`);
      if (!file.startsWith(viewer + sep) || !existsSync(file) || !lstatSync(file).isFile() || !realpathSync(file).startsWith(realpathSync(viewer) + sep)) {
        throw new HttpError(404, "File not found.");
      }
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, error instanceof HttpError || error instanceof GuardError || error instanceof AgentError || error instanceof RequirementsError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  // fs.watch reacts fast but can miss changes (on macOS its FSEvents stream starts asynchronously and
  // may drop or coalesce events), so it only schedules a check; the decision is made in the queue,
  // and a cheap stat poll catches anything the watcher never reported.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const check = () => serial(async () => { if (!closed && !same(snapshot(), observed)) await refresh(); });
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (!closed) void check().catch(() => undefined); }, 100);
  };
  // The requirements file only needs re-reading (and announcing), never a layout.
  let requirementsDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRequirements = () => {
    clearTimeout(requirementsDebounce);
    requirementsDebounce = setTimeout(() => { if (!closed) void serial(async () => requirements.check()).catch(() => undefined); }, 100);
  };
  const watcher: FSWatcher | undefined = options.watch === false ? undefined : watch(dirname(modelPath), (_event, filename) => {
    if (filename?.toString() === basename(requirementsPath)) { scheduleRequirements(); return; }
    if (filename && ![basename(modelPath), basename(pinsPath)].includes(filename.toString())) return;
    if (filename?.toString() === basename(pinsPath) && lastWrite !== undefined) {
      try { if (readFileSync(pinsPath, "utf8") === lastWrite) return; } catch { /* deleted: check */ }
    }
    schedule();
  });
  const stamp = (path: string) => {
    try { const stat = statSync(path, { throwIfNoEntry: false }); return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "-"; }
    catch { return "?"; }
  };
  const stamps = () => `${stamp(modelPath)}|${stamp(pinsPath)}`;
  let polled = ""; // The first tick always compares bytes, covering edits made while the server started.
  let polledRequirements = "";
  const poll = setInterval(() => {
    const requirementsStamp = stamp(requirementsPath);
    if (requirementsStamp !== polledRequirements) { polledRequirements = requirementsStamp; scheduleRequirements(); }
    const now = stamps();
    if (now === polled) return;
    polled = now;
    schedule();
  }, POLL_MS);
  poll.unref();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": keepalive\n\n"); }, 15000);
  heartbeat.unref();
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); });
  } catch (error) { watcher?.close(); clearInterval(poll); clearTimeout(debounce); clearTimeout(requirementsDebounce); clearInterval(heartbeat); throw error; }
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  // With the agent panel, the page reads the one-time token from `t` and removes it from the address bar.
  const pageUrl = token ? `${url}/?t=${token}` : url;
  if (options.open) {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [pageUrl], { stdio: "ignore" });
    child.on("error", (error) => console.error(`Open ${pageUrl} manually: ${error.message}`));
    child.unref();
  }
  return { server, url, pageUrl, token, async close() {
    closed = true;
    await agent?.close();
    watcher?.close(); clearInterval(poll); clearTimeout(debounce); clearTimeout(requirementsDebounce); clearInterval(heartbeat);
    await queue;
    for (const client of clients) client.end();
    const closing = new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    server.closeAllConnections();
    await closing;
  } };
}
