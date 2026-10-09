import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import type { Diagram, LayoutOptions, Point } from "../core/geometry.js";
import { DEFAULT_ENGINE, layout } from "../core/layout/index.js";
import { renderSvg } from "../core/render/svg.js";
import type { QualityReport } from "../core/quality.js";
import { LayoutFile } from "../core/schema.js";
import { diagramPositions, layoutPathFor, lintText, quality, readPins, svgToPng, writeLayoutFile, type LayoutFilePatch } from "./render.js";
import { diagnosticTarget } from "./targets.js";

export interface ViewerDiagnostic extends Diagnostic { target?: string }
export interface ViewerState {
  modelPath: string;
  title: string;
  engine: NonNullable<LayoutOptions["engine"]>;
  svg: string | null;
  diagram: Diagram | null;
  diagnostics: ViewerDiagnostic[];
  quality: QualityReport | null;
  pins: Record<string, Point>;
  yaml: string;
  updatedAt: string;
}
export interface ServeOptions { port?: number; open?: boolean; engine?: LayoutOptions["engine"] }
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
  async function refresh(fresh = false): Promise<ViewerState> {
    let yaml = "";
    let diagnostics: ViewerDiagnostic[] = [];
    let diagram: Diagram | null = null;
    let svg: string | null = null;
    let title = basename(modelPath);
    const saved = readPins(modelPath);
    const pins = saved.options.pins ?? {};
    const engine = requestedEngine ?? saved.options.engine ?? DEFAULT_ENGINE;
    try {
      yaml = readFileSync(modelPath, "utf8");
      const parsed = lintText(yaml);
      title = parsed.model?.title ?? title;
      let all = [...parsed.diagnostics, ...saved.diagnostics];
      if (parsed.model && !hasErrors(parsed.diagnostics)) {
        // Incremental by default: the last accepted positions keep untouched nodes in place.
        const positions = fresh ? undefined : saved.options.positions;
        const result = await layout(parsed.model, { engine, pins, positions });
        diagram = result.diagram;
        svg = renderSvg(diagram);
        all = [...all, ...result.diagnostics];
        if (!saved.diagnostics.length) {
          try { writeLayout({ positions: diagramPositions(diagram) }); }
          catch (error) { all.push({ rule: "layout-file", severity: "warning", message: `Positions not saved: ${(error as Error).message}` }); }
        }
      }
      diagnostics = all.map((d) => ({ ...d, target: diagnosticTarget(d.path, parsed.model) }));
    } catch (error) {
      diagnostics = [{ rule: "io", severity: "error", message: (error as Error).message, hint: "Restore the model file and save it again." }];
    }
    updatedTime = Math.max(Date.now(), updatedTime + 1);
    state = { modelPath, title, engine, svg, diagram, diagnostics, pins, yaml,
      quality: diagram ? quality(diagram, pins) : null, updatedAt: new Date(updatedTime).toISOString() };
    for (const client of clients) client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
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
  function writeLayout(patch: LayoutFilePatch): void {
    guardLayoutPath();
    lastWrite = writeLayoutFile(modelPath, patch);
  }
  function persist(pins: Record<string, Point>, engine?: LayoutOptions["engine"]): void {
    const parsed = LayoutFile.parse({ version: 1, pins, ...(engine ? { engine } : {}) });
    writeLayout({ pins: parsed.pins, ...(parsed.engine ? { engine: parsed.engine } : {}) });
  }
  const server = createServer((req, res) => {
    void (async () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const origin = `http://127.0.0.1:${actualPort}`;
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
      if (req.method === "POST" && path === "/api/relayout") {
        const next = await serial(async () => {
          writeLayout({ positions: null });
          return refresh(true);
        });
        return json(res, 200, next);
      }
      const pinsRoute = path === "/api/pins" || path.startsWith("/api/pins/");
      if ((req.method === "POST" && path === "/api/pins") || (req.method === "DELETE" && pinsRoute) || (req.method === "POST" && path === "/api/engine")) {
        const hasBody = Number(req.headers["content-length"]) > 0 || !!req.headers["transfer-encoding"];
        const value = req.method === "POST" || hasBody ? await body(req) : {};
        if (req.method === "DELETE") onlyKeys(value, []);
        const next = await serial(async () => {
          const saved = readPins(modelPath).options;
          const pins = { ...saved.pins };
          let engine = saved.engine;
          if (path === "/api/engine") {
            onlyKeys(value, ["engine"]);
            const parsed = LayoutFile.safeParse({ version: 1, engine: value.engine, pins });
            if (!parsed.success || !parsed.data.engine) throw new HttpError(400, "Engine must be layered, stress or simple.");
            engine = parsed.data.engine;
          } else if (req.method === "POST") {
            onlyKeys(value, ["pins"]);
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
          if (path === "/api/engine") {
            requestedEngine = undefined;
            // A new engine means a new drawing: start from scratch instead of keeping old positions.
            writeLayout({ positions: null });
            return refresh(true);
          }
          return refresh();
        });
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
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dirname(modelPath), (_event, filename) => {
    if (filename && ![basename(modelPath), basename(pinsPath)].includes(filename.toString())) return;
    if (filename?.toString() === basename(pinsPath) && lastWrite !== undefined) {
      try { if (readFileSync(pinsPath, "utf8") === lastWrite) return; } catch { /* deleted: refresh */ }
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (!closed) void serial(refresh); }, 100);
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": keepalive\n\n"); }, 15000);
  heartbeat.unref();
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); });
  } catch (error) { watcher.close(); clearInterval(heartbeat); throw error; }
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  if (options.open) {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.on("error", (error) => console.error(`Open ${url} manually: ${error.message}`));
    child.unref();
  }
  return { server, url, async close() {
    closed = true;
    watcher.close(); clearTimeout(debounce); clearInterval(heartbeat);
    await queue;
    for (const client of clients) client.end();
    const closing = new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    server.closeAllConnections();
    await closing;
  } };
}
