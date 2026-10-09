import { boxAround, intersects, type Box, type DEdge, type DLabel, type DNode } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { cardText, labelSize, style } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import { boxDistance, boxSegmentDistance, labelAmbiguityReasons, labelGeometry, labelLooseReasons, type LabelGeometry } from "./label-geometry.js";
import { boxShape, distance, drawnPaths, segments, shapesNear } from "./shapes.js";

interface Slot {
  label: DLabel;
  edge: DEdge;
}

export function placeLabels(model: NModel, nodes: DNode[], edges: DEdge[], metrics: TextMetrics): DLabel[] {
  const paths = new Map(edges.map((edge) => [edge.id, drawnPaths(edge)]));
  const geometry = labelGeometry(nodes, edges, paths);
  const lines = new Map(edges.map((edge) => [edge.id, paths.get(edge.id)!.flatMap(segments)]));
  const slots: Slot[] = model.relationships.flatMap((r) => r.ends).flatMap((end) => {
    const edge = edges.find((e) => e.end === end.id);
    if (!edge) return [];
    const texts: { text: string; kind: DLabel["kind"] }[] = [{ text: cardText(end.min, end.max), kind: "cardinality" }];
    if (end.role) texts.push({ text: end.role, kind: "role" });
    return texts.map(({ text, kind }) => ({ edge, label: { id: `label:${edge.id}:${kind}`, kind, text, edge: edge.id,
      box: { x: 0, y: 0, ...labelSize(text, metrics) } } }));
  });
  const collides = (label: DLabel, edge: DEdge, ownershipClear = false) => {
    const box = label.box, shape = boxShape(box);
    const expanded = { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 };
    // Valid ownership slots already clear shapes and other ends by at least four pixels.
    return edges.some((other) => other.id !== edge.id && (!ownershipClear || other.kind !== "end") && lines.get(other.id)!.some(([a, b]) => boxSegmentDistance(expanded, a, b) < 1e-7))
      || (!ownershipClear && nodes.some((node) => shapesNear(shape, node, 2)));
  };
  const options = new Map<string, DLabel[]>();
  const labels: DLabel[] = [];
  let needsResolution = false;
  for (const slot of slots) {
    let best: DLabel | undefined;
    const valid: DLabel[] = [];
    for (const candidate of candidates(slot)) {
      if (labelLooseReasons(candidate, slot.edge, geometry, [], true).length || collides(candidate, slot.edge, true)) continue;
      valid.push(candidate);
      best ??= candidate;
      if (!labels.some((other) => incompatible(candidate, other, geometry))) { best = candidate; break; }
    }
    if (!best) {
      let bestCost = Infinity;
      for (const candidate of candidates(slot)) {
        const cost = (Number(collides(candidate, slot.edge)) + labelAmbiguityReasons(candidate.box, slot.edge, edges, geometry).length) * 1000
          + Number(labels.some((other) => incompatible(candidate, other, geometry)));
        if (cost < bestCost) { best = candidate; bestCost = cost; }
        if (!cost) break;
      }
    }
    best ??= slot.label;
    needsResolution ||= !valid.length || labels.some((other) => incompatible(best!, other, geometry));
    options.set(slot.label.id, valid);
    labels.push(best);
  }
  if (!needsResolution || [...options.values()].some((group) => !group.length)) return labels;
  // Static geometry stays fixed while earlier choices are reconsidered.
  for (const slot of slots) {
    const valid = options.get(slot.label.id)!;
    for (const candidate of candidates(slot)) {
      if (valid.some((other) => sameBox(candidate.box, other.box))) continue;
      if (labelLooseReasons(candidate, slot.edge, geometry, [], true).length || collides(candidate, slot.edge, true)) continue;
      valid.push(candidate);
      if (valid.length >= 32) break;
    }
  }
  const resolved = resolveLabels([...options.values()], geometry);
  if (!resolved) return labels;
  const byId = new Map(resolved.map((label) => [label.id, label]));
  return slots.map((slot) => byId.get(slot.label.id)!);
}

function* candidates({ label, edge }: Slot): Generator<DLabel> {
  const end = edge.points.at(-1), previous = edge.points.at(-2);
  if (!end || !previous) return;
  const length = distance(end, previous) || 1;
  const ux = (previous.x - end.x) / length, uy = (previous.y - end.y) / length;
  const { w, h } = label.box;
  const alongRadius = (w * Math.abs(ux) + h * Math.abs(uy)) / 2;
  const normalRadius = (w * Math.abs(uy) + h * Math.abs(ux)) / 2;
  for (const gap of [2, 4, 8]) {
    const start = Math.min(48, alongRadius + gap * 2 + 2);
    const positions = [start, 30, 40, 48, 20, 10];
    for (const along of new Set(positions)) for (const sign of [1, -1]) {
      const side = sign * (normalRadius + gap + (edge.double ? style.doubleEdgeGap / 2 : 0));
      yield { ...label, box: boxAround({ x: end.x + ux * along - uy * side, y: end.y + uy * along + ux * side }, w, h) };
    }
  }
}

function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
}

function incompatible(a: DLabel, b: DLabel, geometry: LabelGeometry): boolean {
  return geometry.edges.get(a.edge)?.to === geometry.edges.get(b.edge)?.to ? boxDistance(a.box, b.box) < 10 - 1e-7 : intersects(a.box, b.box, 3);
}

function resolveLabels(groups: DLabel[][], geometry: LabelGeometry): DLabel[] | undefined {
  const ordered = [...groups].sort((a, b) => a.length - b.length);
  let remaining = 4096;
  function search(index: number, placed: DLabel[]): DLabel[] | undefined {
    if (index === ordered.length) return placed;
    for (const candidate of ordered[index]!) {
      if (--remaining < 0) return undefined;
      if (placed.some((other) => incompatible(candidate, other, geometry))) continue;
      const result = search(index + 1, [...placed, candidate]);
      if (result) return result;
    }
    return undefined;
  }
  return search(0, []);
}
