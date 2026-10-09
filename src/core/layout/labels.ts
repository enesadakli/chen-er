import { boxAround, intersects, type Box, type DEdge, type DLabel, type DNode } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { cardText, labelSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import { boxShape, distance, drawnPaths, segments, segmentThrough, shapesNear } from "./shapes.js";

export function placeLabels(model: NModel, nodes: DNode[], edges: DEdge[], metrics: TextMetrics): DLabel[] {
  const labels: DLabel[] = [];
  for (const r of model.relationships) for (const end of r.ends) {
    const e = edges.find((e) => e.end === end.id);
    if (!e) continue;
    labels.push(placeLabel(e, cardText(end.min, end.max), "cardinality", metrics, nodes, edges, labels));
    if (end.role) labels.push(placeLabel(e, end.role, "role", metrics, nodes, edges, labels));
  }
  return labels;
}

function placeLabel(edge: DEdge, text: string, kind: DLabel["kind"], metrics: TextMetrics, nodes: DNode[], edges: DEdge[], labels: DLabel[]): DLabel {
  const end = edge.points.at(-1)!, previous = edge.points.at(-2) ?? end;
  const length = distance(end, previous) || 1, ux = (previous.x - end.x) / length, uy = (previous.y - end.y) / length;
  const measured = labelSize(text, metrics);
  // Italic role glyphs may overhang their regular advance width.
  const size = { w: measured.w + (kind === "role" ? 8 : 0), h: measured.h };
  const baseSide = 10 + size.w / 2 * Math.abs(uy) + size.h / 2 * Math.abs(ux);
  let best: Box = boxAround(end, size.w, size.h), bestCost = Infinity;
  for (const along of [30, 55, 80, 110, 145, 190, 250, 330]) for (const extra of [0, 14, 32, 60, 100, 160, 240]) for (const sign of [1, -1]) {
    const side = sign * (baseSide + extra);
    const box = boxAround({ x: end.x + ux * along - uy * side, y: end.y + uy * along + ux * side }, size.w, size.h);
    const shape = boxShape(box);
    const collisions = nodes.filter((n) => shapesNear(shape, n, 3)).length + labels.filter((l) => intersects(box, l.box, 4)).length + edges.filter((e) => e.id !== edge.id && drawnPaths(e).flatMap(segments).some(([a, b]) => segmentThrough(a, b, boxShape({ x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 })))).length;
    const cost = collisions * 100000 + along + extra * 2;
    if (cost < bestCost) { bestCost = cost; best = box; }
    if (collisions === 0) return { id: `label:${edge.id}:${kind}`, kind, text, box, edge: edge.id };
  }
  return { id: `label:${edge.id}:${kind}`, kind, text, box: best, edge: edge.id };
}
