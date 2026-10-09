import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import type { Diagram, LayoutOptions, Point } from "../core/geometry.js";
import { layout } from "../core/layout/index.js";
import { parseModel, type NModel } from "../core/normalize.js";
import { renderSvg } from "../core/render/svg.js";
import { lint, type LintOptions } from "../core/lint/index.js";
import { assessQuality } from "../core/quality.js";
import { LayoutFile } from "../core/schema.js";

/**
 * Application services shared by the CLI and the MCP server. These are the only
 * functions that touch the file system.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** assets/ lives at the package root both from src/app and from dist/app. */
export const FONT_DIR = join(here, "..", "..", "assets", "fonts");
export const FONT_FILES = ["Inter_400Regular.ttf", "Inter_700Bold.ttf"].map((f) => join(FONT_DIR, f));

/** `model.er.yaml` → `model.er.layout.json`. */
export const layoutPathFor = (modelPath: string) => modelPath.replace(/(\.er)?\.ya?ml$/i, "") + ".er.layout.json";

export interface RenderOutput {
  model?: NModel;
  diagram?: Diagram;
  svg?: string;
  diagnostics: Diagnostic[];
}

export function readPins(modelPath: string): { options: LayoutOptions; diagnostics: Diagnostic[] } {
  const path = layoutPathFor(modelPath);
  if (!existsSync(path)) return { options: {}, diagnostics: [] };
  try {
    const parsed = LayoutFile.parse(JSON.parse(readFileSync(path, "utf8")));
    return { options: { pins: parsed.pins, engine: parsed.engine, positions: parsed.positions }, diagnostics: [] };
  } catch (err) {
    return {
      options: {},
      diagnostics: [{ rule: "layout-file", severity: "error", message: `${path}: ${(err as Error).message}`, hint: "Fix or delete the layout file." }],
    };
  }
}

export async function renderText(text: string, options: LayoutOptions = {}): Promise<RenderOutput> {
  const parsed = lintText(text);
  if (!parsed.model || hasErrors(parsed.diagnostics)) return { diagnostics: parsed.diagnostics };
  const result = await layout(parsed.model, options);
  return {
    model: parsed.model,
    diagram: result.diagram,
    svg: renderSvg(result.diagram),
    diagnostics: [...parsed.diagnostics, ...result.diagnostics],
  };
}

export async function renderFile(modelPath: string, options: LayoutOptions = {}): Promise<RenderOutput> {
  const pins = readPins(modelPath);
  const out = await renderText(readFileSync(modelPath, "utf8"), { ...pins.options, ...options });
  out.diagnostics.unshift(...pins.diagnostics);
  return out;
}

/** SVG → PNG with the bundled fonts, so the PNG matches the measured text. */
export function svgToPng(svg: string, scale = 2): Buffer {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be a positive finite number.");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
    background: "white",
  });
  return resvg.render().asPng();
}

export function lintText(text: string, options: LintOptions = {}) {
  const parsed = parseModel(text);
  return {
    ...parsed,
    diagnostics: [...parsed.diagnostics, ...(parsed.model ? lint(parsed.model, options) : [])],
  };
}

export function lintFile(path: string, options: LintOptions = {}) {
  return lintText(readFileSync(path, "utf8"), options);
}

export function quality(diagram: Diagram, pins: Record<string, Point> = {}) {
  return assessQuality(diagram, pins);
}

export interface LayoutFilePatch {
  pins?: Record<string, Point>;
  engine?: LayoutOptions["engine"];
  /** `null` removes the soft positions (fresh layout next time). */
  positions?: Record<string, Point> | null;
}

/**
 * Merge a patch into *.er.layout.json and return the exact text written, so callers that watch
 * the file can recognise their own writes. Keys are sorted and coordinates rounded for stable diffs.
 */
export function writeLayoutFile(modelPath: string, patch: LayoutFilePatch): string {
  const path = layoutPathFor(modelPath);
  let current: { pins: Record<string, Point>; engine?: LayoutOptions["engine"]; positions?: Record<string, Point> } = { pins: {} };
  if (existsSync(path)) current = LayoutFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const pins = patch.pins ?? current.pins;
  const engine = patch.engine ?? current.engine;
  const positions = patch.positions === null ? undefined : (patch.positions ?? current.positions);
  const sorted = (r: Record<string, Point>) =>
    Object.fromEntries(Object.keys(r).sort().map((id) => [id, { x: round(r[id]!.x), y: round(r[id]!.y) }]));
  const file = LayoutFile.parse({ version: 1, ...(engine ? { engine } : {}), pins: sorted(pins), ...(positions ? { positions: sorted(positions) } : {}) });
  const text = JSON.stringify(file, null, 2) + "\n";
  writeFileSync(path, text);
  return text;
}

const round = (v: number) => Math.round(v * 10) / 10;

export function writePins(modelPath: string, pins: Record<string, Point>): void {
  writeLayoutFile(modelPath, { pins });
}

/** Node id → center for every node of a diagram: the soft positions of the next incremental layout. */
export function diagramPositions(diagram: Diagram): Record<string, Point> {
  return Object.fromEntries(diagram.nodes.map((n) => [n.id, { x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h / 2 }]));
}

export function writeRenderOutputs(svg: string, out: string, png = false, scale = 2): string[] {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be a positive finite number.");
  const pngPath = out.replace(/\.svg$/i, "") + ".png";
  if (png && pngPath === out) throw new Error("SVG and PNG output paths must differ.");
  const buffer = png ? svgToPng(svg, scale) : undefined;
  writeFileSync(out, svg);
  if (buffer) writeFileSync(pngPath, buffer);
  return buffer ? [out, pngPath] : [out];
}

export const STARTER_MODEL = `# Chen ER model, version 1. Run chen lint before rendering.
version: 1
title: Course enrollment
entities:
  STUDENT:
    attrs: [StudentId, Name]
    keys: [[StudentId]]
  COURSE:
    attrs: [CourseId, Title]
    keys: [[CourseId]]
relationships:
  ENROLLS:
    ends:
      - entity: STUDENT
        card: 0..N
      - entity: COURSE
        card: 0..N
# Add free-form notes below the diagram.
notes: []
`;

export function initFile(path = "model.er.yaml", force = false): void {
  writeFileSync(path, STARTER_MODEL, { flag: force ? "w" : "wx" });
}
