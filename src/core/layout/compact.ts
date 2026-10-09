import { boxAround, center, intersects, type LayoutResult, type Point } from "../geometry.js";
import { assessQuality, type QualityReport } from "../quality.js";
import type { NModel } from "../normalize.js";
import type { Cluster } from "./clusters.js";
import { distance, segments } from "./shapes.js";

// Leave room for an end's cardinality near its entity rather than squeezing
// the diamond against the entity. User-specified fixed ends remain exact.
function readableEnds(result: LayoutResult): boolean {
  return result.diagram.edges.filter((e) => e.kind === "end").every((e) => {
    const fixed = result.diagram.nodes.find((n) => n.id === e.from)?.pinned && result.diagram.nodes.find((n) => n.id === e.to)?.pinned;
    return fixed || segments(e.points).reduce((sum, [a, b]) => sum + distance(a, b), 0) >= 60;
  });
}

/** Hard violations reject a candidate. Semantic weights: hierarchy 12, midpoint
 * offset 10, proximity inversions 3, off-axis ends 2; degree centrality 0.5,
 * grid isolation and inward fans 0.25 each. Crossings cost 2, mean edge ratio 1,
 * related distance 0.1, aspect overflow 6, and density earns 4. Mean ratio
 * overflow above 3.5 costs 1; longest ratio overflow above 7 costs 4. */
export function layoutScore(q: QualityReport): number {
  if (q.overlaps || q.shapeCrossings || q.labelCollisions || q.labelAmbiguity || q.labelLoose || q.pinDrift || q.attributeEdgeBends || q.edgeOverlap || q.tinySegments || q.endPortCrowding || q.diamondVertexViolations || q.doubleEdgeArtifacts) return Infinity;
  const aspectPenalty = Math.max(0, 0.6 - q.aspect, q.aspect - 1.8);
  return q.edgeCrossings * 2 + q.hierarchyViolations * 12 + q.diamondOffset * 10 + q.proximityInversions * 3 + (1 - q.axisAligned) * 2
    + q.centralityOffset * 0.5 + q.gridMisalignment * 0.25 + q.attributeInwardRatio * 0.25 + q.relatedDistance * 0.1
    + q.meanEdgeRatio + Math.max(0, q.longestEdgeRatio - 7) * 4 + Math.max(0, q.meanEdgeRatio - 3.5) + aspectPenalty * 6 - q.density * 4;
}

export function compactCandidates(clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Record<string, Point>, model?: NModel): LayoutResult[] {
  const results = [build(clusters)];
  if (!clusters.some((c) => !c.node.pinned)) return results;
  const centers = clusters.map((c) => center(c.node.box));
  const centroid = { x: centers.reduce((s, p) => s + p.x, 0) / centers.length, y: centers.reduce((s, p) => s + p.y, 0) / centers.length };
  const scaled = (factor: number, sx = 1, sy = 1) => clusters.map((c, i) => ({ ...c, node: { ...c.node, box: c.node.pinned ? { ...c.node.box } : boxAround({ x: centroid.x + (centers[i]!.x - centroid.x) * factor * sx, y: centroid.y + (centers[i]!.y - centroid.y) * factor * sy }, c.node.box.w, c.node.box.h) } }));
  // Evaluate actual attribute placement and routes at every binary-search step;
  // an envelope-only clearance check leaves most of the canvas unused.
  let low = 0.12, high = 1;
  for (let step = 0; step < 7; step++) {
    const factor = (low + high) / 2;
    const cs = scaled(factor);
    if (cs.some((c, i) => cs.slice(i + 1).some((other) => intersects(c.node.box, other.node.box, 16)))) { low = factor; continue; }
    const result = build(cs);
    const readable = readableEnds(result);
    if (readable) results.push(result);
    if (readable && Number.isFinite(layoutScore(assessQuality(result.diagram, pins, model)))) high = factor;
    else low = factor;
  }
  for (const [sx, sy] of [[0.75, 1], [1, 0.75], [0.65, 1.25], [1.25, 0.65]]) {
    const result = build(scaled(high, sx, sy));
    if (readableEnds(result)) results.push(result);
  }
  return results;
}

export function compactLocally(initial: LayoutResult, clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Record<string, Point>, model?: NModel): LayoutResult {
  let best = initial;
  let score = layoutScore(assessQuality(best.diagram, pins, model));
  if (!Number.isFinite(score)) return best;
  const neighbours = new Map(clusters.map((c) => [c.node.id, new Set<string>()]));
  for (const e of initial.diagram.edges.filter((e) => e.kind === "end")) {
    neighbours.get(e.from)?.add(e.to);
    neighbours.get(e.to)?.add(e.from);
  }
  const ranked = clusters.filter((c) => !c.node.pinned).map((c) => {
    const own = center(initial.diagram.nodes.find((n) => n.id === c.node.id)!.box);
    const length = [...neighbours.get(c.node.id)!].reduce((sum, id) => {
      const p = center(initial.diagram.nodes.find((n) => n.id === id)!.box);
      return sum + Math.hypot(own.x - p.x, own.y - p.y);
    }, 0);
    return { cluster: c, length };
  }).sort((a, b) => b.length - a.length || a.cluster.node.id.localeCompare(b.cluster.node.id));
  // Bound work independently of model size. Every accepted move rebuilds the
  // attributes, routes and labels and retains all five hard guarantees.
  for (const { cluster } of ranked.slice(0, 8)) {
    const cs = clusters.map((c) => ({ ...c, node: { ...c.node, box: { ...best.diagram.nodes.find((n) => n.id === c.node.id)!.box } } }));
    const own = cs.find((c) => c.node.id === cluster.node.id)!;
    const adjacent = [...neighbours.get(own.node.id)!].map((id) => center(cs.find((c) => c.node.id === id)!.node.box));
    if (!adjacent.length) continue;
    const p = center(own.node.box);
    const dx = adjacent.reduce((sum, n) => sum + n.x - p.x, 0) / adjacent.length;
    const dy = adjacent.reduce((sum, n) => sum + n.y - p.y, 0) / adjacent.length;
    const step = Math.min(0.15, 32 / (Math.hypot(dx, dy) || 1));
    own.node.box = boxAround({ x: p.x + dx * step, y: p.y + dy * step }, own.node.box.w, own.node.box.h);
    const next = build(cs);
    if (!readableEnds(next)) continue;
    const value = layoutScore(assessQuality(next.diagram, pins, model));
    if (value < score) { best = next; score = value; }
  }
  return best;
}

/** Compress gaps using only shapes facing an adjacent row in the same corridor. */
export function compactRows(initial: LayoutResult, clusters: Cluster[], ranks: Map<string, number>, build: (cs: Cluster[]) => LayoutResult, model: NModel): LayoutResult {
  const diagram = initial.diagram;
  const owners = new Map(diagram.nodes.filter((n) => n.kind === "entity").map((n) => [n.id, n.id]));
  for (const r of model.relationships) if (r.ends.every((e) => e.entity === r.ends[0]!.entity)) owners.set(r.id, `E:${r.ends[0]!.entity}`);
  for (const e of diagram.edges.filter((e) => e.kind !== "end")) if (owners.has(e.from)) owners.set(e.to, owners.get(e.from)!);
  const entities = new Map(diagram.nodes.filter((n) => n.kind === "entity").map((n) => [n.id, center(n.box)]));
  const rows = [...new Set(ranks.values())].sort((a, b) => a - b);
  const positions = new Map<number, number>();
  for (const [i, rank] of rows.entries()) {
    const original = entities.get([...ranks].find(([, r]) => r === rank)![0])!.y;
    if (!i) { positions.set(rank, original); continue; }
    const previous = rows[i - 1]!;
    const previousY = entities.get([...ranks].find(([, r]) => r === previous)![0])!.y;
    // A 64px diamond, two readable 60px ends, and two 23px entity halves.
    let gap = 240;
    const upper = diagram.nodes.filter((n) => ranks.get(owners.get(n.id) ?? "") === previous);
    const lower = diagram.nodes.filter((n) => ranks.get(owners.get(n.id) ?? "") === rank);
    for (const a of upper) for (const b of lower) if (a.box.x < b.box.x + b.box.w + 32 && b.box.x < a.box.x + a.box.w + 32) {
      gap = Math.max(gap, a.box.y + a.box.h - previousY + original - b.box.y + 32);
    }
    positions.set(rank, positions.get(previous)! + Math.min(original - previousY, Math.ceil(gap / 16) * 16));
  }
  const shifts = new Map([...ranks].map(([id, rank]) => [id, positions.get(rank)! - entities.get(id)!.y]));
  const cs = clusters.map((c) => ({ ...c, node: { ...c.node, box: { ...c.node.box } } }));
  for (const c of cs) if (c.node.kind === "entity") c.node.box.y += shifts.get(c.node.id)!;
  for (const r of model.relationships) {
    const diamond = cs.find((c) => c.node.id === r.id)!.node;
    const shift = r.ends.reduce((sum, e) => sum + shifts.get(`E:${e.entity}`)!, 0) / r.ends.length;
    diamond.box.y += shift;
  }
  const next = build(cs), before = assessQuality(diagram, {}, model), after = assessQuality(next.diagram, {}, model);
  return Number.isFinite(layoutScore(after)) && readableEnds(next) && after.edgeCrossings <= before.edgeCrossings ? next : initial;
}
