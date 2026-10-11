import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import { lint } from "../core/lint/index.js";
import { buildReport, reportHtml, reportMarkdown, type ReportDoc } from "../core/report/index.js";
import { parseRequirements } from "../core/requirements.js";
import { modelIndex, requirementsPathFor } from "./requirements.js";
import { renderFile, renderText, type RenderOutput } from "./render.js";
import { mapText } from "./map.js";

export type ReportFormat = "md" | "html";
export interface ReportOutput { doc?: ReportDoc; svg?: string; diagnostics: Diagnostic[] }
export interface ReportFileOptions { format?: ReportFormat; out?: string; noPins?: boolean }

function document(result: RenderOutput, yaml: string, fileName: string, requirements?: string): ReportOutput {
  if (!result.model || !result.svg || hasErrors(result.diagnostics)) return { diagnostics: result.diagnostics };
  const index = modelIndex(yaml)!;
  const mapping = mapText(yaml);
  const diagnostics = [...new Map([...result.diagnostics, ...mapping.diagnostics].map((d) =>
    [JSON.stringify([d.rule, d.severity, d.message, d.path, d.hint]), d])).values()];
  return {
    doc: buildReport({ model: result.model, fileName, liveIds: index.ids, labels: index.labels,
      ...(requirements !== undefined ? { requirements: parseRequirements(requirements) } : {}), diagnostics: lint(result.model), mapping }),
    svg: result.svg, diagnostics,
  };
}

export async function reportText(yaml: string): Promise<ReportOutput> {
  return document(await renderText(yaml), yaml, "model.er.yaml");
}

export async function reportFile(modelPath: string, options: { noPins?: boolean } = {}): Promise<ReportOutput> {
  const yaml = readFileSync(modelPath, "utf8");
  const rendered = await renderFile(modelPath, {}, { noPins: options.noPins, advise: true });
  if (hasErrors(rendered.diagnostics)) return { diagnostics: rendered.diagnostics };
  const path = requirementsPathFor(modelPath);
  return document(rendered, yaml, basename(modelPath), existsSync(path) ? readFileSync(path, "utf8") : undefined);
}

export function reportContent(result: ReportOutput, format: ReportFormat, svgFile?: string): string {
  if (!result.doc || !result.svg) throw new Error("Cannot format an invalid model report.");
  return format === "html" ? reportHtml(result.doc, { svg: result.svg }) : reportMarkdown(result.doc, { svgFile });
}

function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  if (realpathSync(a) === realpathSync(b)) return true;
  const left = statSync(a), right = statSync(b);
  return left.dev === right.dev && left.ino === right.ino;
}

export async function writeReport(modelPath: string, options: ReportFileOptions = {}): Promise<ReportOutput & { paths: string[] }> {
  const format = options.format ?? "md";
  if (format !== "md" && format !== "html") throw new Error("Format must be md or html.");
  const out = options.out ?? modelPath.replace(/(\.er)?\.ya?ml$/i, "") + `.report.${format}`;
  const svgPath = out.replace(/\.[^./\\]+$/, "") + ".svg";
  if (sameFile(modelPath, out) || (format === "md" && sameFile(modelPath, svgPath))) {
    throw new Error("Report output must differ from the input model path.");
  }
  if (format === "md" && sameFile(out, svgPath)) throw new Error("Report and SVG output paths must differ.");
  const result = await reportFile(modelPath, options);
  if (!result.doc || !result.svg) return { ...result, paths: [] };
  const content = reportContent(result, format, basename(svgPath));
  if (format === "md") writeFileSync(svgPath, result.svg);
  writeFileSync(out, content);
  return { ...result, paths: format === "md" ? [out, svgPath] : [out] };
}
