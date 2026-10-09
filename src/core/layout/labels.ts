import { boxAround, intersects, type Box, type DEdge, type DLabel, type DNode } from "../geometry.js";
import type { NEnd, NModel } from "../normalize.js";
import { cardText, labelSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import { labelAmbiguityReasons } from "./label-geometry.js";
import { boxShape, distance, drawnPaths, segments, segmentThrough, shapesNear } from "./shapes.js";

export function placeLabels(model: NModel, nodes: DNode[], edges: DEdge[], metrics: TextMetrics): DLabel[] {
  const ends = model.relationships.flatMap((r) => r.ends);
  let best = buildLabels(ends, nodes, edges, metrics);
  const violations = (labels: DLabel[]) => labels.reduce((sum, l) => {
    const edge = edges.find((e) => e.id === l.edge)!;
    return sum + collisionCount(l.box, edge, nodes, edges, labels.filter((other) => other !== l), 0) + labelAmbiguityReasons(l.box, edge, edges).length;
  }, 0);
  let cost = violations(best);
  const competing = () => best.some((l, i) => best.slice(i + 1).some((other) => intersects(l.box, other.box)));
  if (cost && competing()) for (const order of [[...ends].reverse(), [...ends].sort((a, b) => Number(!!b.role) - Number(!!a.role))]) {
    const labels = buildLabels(order, nodes, edges, metrics), next = violations(labels);
    if (next < cost) { best = labels; cost = next; }
    if (!cost) break;
  }
  if (cost && competing()) {
    const choices = new Map<string, DLabel[][]>();
    buildLabels(ends, nodes, edges, metrics, choices);
    const resolved = resolveLabels([...choices.values()]);
    if (resolved) best = resolved;
  }
  const rank = new Map(ends.map((end, i) => [`edge:${end.id}`, i]));
  return best.sort((a, b) => rank.get(a.edge)! - rank.get(b.edge)!);
}

function buildLabels(ends: NEnd[], nodes: DNode[], edges: DEdge[], metrics: TextMetrics, choices?: Map<string, DLabel[][]>): DLabel[] {
  const labels: DLabel[] = [];
  for (const end of ends) {
    const edge = edges.find((e) => e.end === end.id);
    if (!edge) continue;
    const options: DLabel[][] = [];
    const texts: { text: string; kind: DLabel["kind"] }[] = [{ text: cardText(end.min, end.max), kind: "cardinality" }];
    if (end.role) texts.push({ text: end.role, kind: "role" });
    const sizes = texts.map(({ text, kind }) => {
      const size = labelSize(text, metrics);
      return { ...size, w: size.w + (kind === "role" ? 8 : 0) };
    });
    const endPoint = edge.points.at(-1)!, previous = edge.points.at(-2) ?? endPoint;
    const length = distance(endPoint, previous) || 1;
    const ux = (previous.x - endPoint.x) / length, uy = (previous.y - endPoint.y) / length;
    let best: DLabel[] = [], bestCost = Infinity;
    search: for (const along of [20, 30, 40, 15, 10, 35, 25]) for (const sign of [1, -1]) for (const gap of [6, 10, 3, 12]) {
      let position = along;
      const candidate = texts.map(({ text, kind }, i): DLabel => {
        const size = sizes[i]!;
        if (i) position += (sizes[i - 1]!.w * Math.abs(ux) + sizes[i - 1]!.h * Math.abs(uy) + size.w * Math.abs(ux) + size.h * Math.abs(uy)) / 2 + 4;
        const side = sign * (gap + size.w / 2 * Math.abs(uy) + size.h / 2 * Math.abs(ux));
        return { id: `label:${edge.id}:${kind}`, kind, text, edge: edge.id, box: boxAround({ x: endPoint.x + ux * position - uy * side, y: endPoint.y + uy * position + ux * side }, size.w, size.h) };
      });
      const collisions = candidate.reduce((sum, l, i) => sum + collisionCount(l.box, edge, nodes, edges, [...(choices ? [] : labels), ...candidate.slice(0, i)]), 0);
      const ambiguity = candidate.filter((l) => labelAmbiguityReasons(l.box, edge, edges).length).length;
      const cost = (collisions + ambiguity) * 100000 + along + gap;
      if (cost < bestCost) { bestCost = cost; best = candidate; }
      if (!collisions && !ambiguity) {
        options.push(candidate);
        if (!choices) break search;
      }
    }
    choices?.set(edge.id, options);
    if (choices && !options.length) return labels;
    labels.push(...best);
  }
  return labels;
}

/** Reconsider earlier choices when neighbouring labels compete for space. */
function resolveLabels(groups: DLabel[][][]): DLabel[] | undefined {
  const ordered = [...groups].sort((a, b) => a.length - b.length);
  let remaining = 4096;
  function search(index: number, placed: DLabel[]): DLabel[] | undefined {
    if (index === ordered.length) return placed;
    for (const candidate of ordered[index]!) {
      if (--remaining < 0) return undefined;
      if (candidate.some((l) => placed.some((other) => intersects(l.box, other.box, 3)))) continue;
      const result = search(index + 1, [...placed, ...candidate]);
      if (result) return result;
    }
    return undefined;
  }
  return search(0, []);
}

function collisionCount(box: Box, edge: DEdge, nodes: DNode[], edges: DEdge[], labels: DLabel[], gap = 3): number {
  const shape = boxShape(box);
  return nodes.filter((n) => shapesNear(shape, n, gap)).length + labels.filter((l) => intersects(box, l.box, gap)).length + edges.filter((e) => e.id !== edge.id && drawnPaths(e).flatMap(segments).some(([a, b]) => segmentThrough(a, b, boxShape({ x: box.x - gap, y: box.y - gap, w: box.w + gap * 2, h: box.h + gap * 2 })))).length;
}
