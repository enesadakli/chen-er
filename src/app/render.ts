import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import type { Diagram, LayoutOptions, Point } from "../core/geometry.js";
import { DEFAULT_ENGINE, layout } from "../core/layout/index.js";
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
  /** Plain-words remarks for the CLI (stderr), e.g. which engine the layout file chose. */
  notes?: string[];
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

export interface RenderFileFlags {
  /** Ignore the layout file entirely: no pins, no soft positions, no stored engine. */
  noPins?: boolean;
  /** CLI only: add the engine note and the stale-pin comparison (costs one extra layout when pins exist). */
  advise?: boolean;
}

export async function renderFile(modelPath: string, options: LayoutOptions = {}, flags: RenderFileFlags = {}): Promise<RenderOutput> {
  const saved = flags.noPins ? { options: {} as LayoutOptions, diagnostics: [] as Diagnostic[] } : readPins(modelPath);
  const engine = options.engine ?? saved.options.engine;
  const merged: LayoutOptions = { ...saved.options, ...options, ...(engine ? { engine } : {}) };
  const out = await renderText(readFileSync(modelPath, "utf8"), merged);
  out.diagnostics.unshift(...saved.diagnostics);
  if (flags.advise) {
    const note = engineNote(modelPath, options.engine, saved.options.engine);
    if (note) out.notes = [note];
    const pinned = activePins(out.diagram, merged.pins);
    if (out.model && out.diagram && !hasErrors(out.diagnostics) && Object.keys(pinned).length) {
      const warning = await pinsDegradeDiagnostic(out.model, out.diagram, pinned, options.engine);
      if (warning) out.diagnostics.push(warning);
    }
  }
  return out;
}

/** Say so when the layout file, not the caller, picked a non-default engine. */
function engineNote(modelPath: string, requested: LayoutOptions["engine"], stored: LayoutOptions["engine"]): string | undefined {
  if (requested || !stored || stored === DEFAULT_ENGINE) return undefined;
  return `using engine '${stored}' from ${basename(layoutPathFor(modelPath))} (default is '${DEFAULT_ENGINE}'); pass --engine to override`;
}

/** Pins that name a node of the diagram; the others cannot affect the drawing. */
function activePins(diagram: Diagram | undefined, pins: Record<string, Point> = {}): Record<string, Point> {
  const ids = new Set(diagram?.nodes.map((n) => n.id));
  return Object.fromEntries(Object.entries(pins).filter(([id]) => ids.has(id)));
}

const HARD_METRICS = ["overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const;

/**
 * Lay the model out once without pins or positions and compare. Returns a diagnostic when the
 * pinned drawing is clearly worse: area over 1.5x, at least 3 more edge crossings, or any hard metric worse.
 * `engine` is the explicit engine, if any, so the baseline matches what `--no-pins` would produce.
 */
export async function pinsDegradeDiagnostic(
  model: NModel, pinned: Diagram, pins: Record<string, Point>, engine?: LayoutOptions["engine"],
): Promise<Diagnostic | undefined> {
  const baseline = (await layout(model, engine ? { engine } : {})).diagram;
  const withPins = assessQuality(pinned, pins, model);
  const without = assessQuality(baseline, {}, model);
  const areaRatio = (pinned.width * pinned.height) / Math.max(1, baseline.width * baseline.height);
  const worse = HARD_METRICS.filter((m) => withPins[m] > without[m]);
  const moreCrossings = withPins.edgeCrossings - without.edgeCrossings;
  if (areaRatio <= 1.5 && moreCrossings < 3 && !worse.length) return undefined;
  const size = (d: Diagram) => `${Math.round(d.width)}x${Math.round(d.height)} px`;
  const details = [
    `size ${size(pinned)} with pins vs ${size(baseline)} without`,
    `edge crossings ${withPins.edgeCrossings} vs ${without.edgeCrossings}`,
    ...worse.map((m) => `${m} ${withPins[m]} vs ${without[m]}`),
  ];
  return {
    rule: "pins-degrade-layout",
    severity: "heuristic",
    message: `The saved pins make this layout clearly worse than an unpinned one (${details.join("; ")}).`,
    hint: "run with --no-pins to compare, or use Reset pins in `chen serve`",
  };
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
