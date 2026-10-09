import type { Box, Diagram, Point } from "../core/geometry.js";
import type { Severity } from "../core/diagnostics.js";
import type { ViewerDiagnostic } from "../app/serve.js";

export const severities: Severity[] = ["error", "course", "heuristic", "info"];
export const glyphs: Record<Severity, string> = { error: "✕", course: "△", heuristic: "○", info: "•" };
export interface Finding extends ViewerDiagnostic { number: number }
export function findings(diagnostics: readonly ViewerDiagnostic[]): Finding[] {
  return diagnostics.map((d, index) => ({ d, index }))
    .sort((a, b) => severities.indexOf(a.d.severity) - severities.indexOf(b.d.severity) || a.index - b.index)
    .map(({ d }, index) => ({ ...d, number: index + 1 }));
}
export function snap(point: Point, free = false): Point {
  return free ? { ...point } : { x: Math.round(point.x / 8) * 8, y: Math.round(point.y / 8) * 8 };
}
export function yamlExcerpt(yaml: string, line: number | undefined, radius = 3) {
  if (!line || !Number.isInteger(line)) return [];
  const lines = yaml.split("\n");
  if (line < 1 || line > lines.length) return [];
  return lines.slice(Math.max(0, line - radius - 1), line + radius).map((text, index) => ({
    text, line: Math.max(1, line - radius) + index, target: Math.max(1, line - radius) + index === line,
  }));
}
export function targetBox(diagram: Diagram | null, target: string | undefined): Box | undefined {
  if (!diagram || !target) return undefined;
  const node = diagram.nodes.find((n) => n.id === target);
  if (node) return node.box;
  const edge = diagram.edges.find((e) => e.id === target || `edge:${e.end}` === target);
  if (edge?.points.length) {
    const xs = edge.points.map((p) => p.x), ys = edge.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return diagram.labels.find((label) => label.id === target)?.box;
}
