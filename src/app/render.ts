import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import type { Diagram, LayoutOptions } from "../core/geometry.js";
import { layout } from "../core/layout/index.js";
import { parseModel, type NModel } from "../core/normalize.js";
import { renderSvg } from "../core/render/svg.js";
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
    return { options: { pins: parsed.pins, engine: parsed.engine }, diagnostics: [] };
  } catch (err) {
    return {
      options: {},
      diagnostics: [{ rule: "layout-file", severity: "error", message: `${path}: ${(err as Error).message}`, hint: "Fix or delete the layout file." }],
    };
  }
}

export async function renderText(text: string, options: LayoutOptions = {}): Promise<RenderOutput> {
  const parsed = parseModel(text);
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
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
    background: "white",
  });
  return resvg.render().asPng();
}
