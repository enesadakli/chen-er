import { boxAround, center, intersects, type LayoutResult, type Point } from "../geometry.js";
import { assessQuality, type QualityReport } from "../quality.js";
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

/** A crossing costs two entity widths of mean edge length. Aspect outside the
 * page-friendly interval costs six widths; density rewards using the page.
 * Hard violations are never traded for a better soft score. */
export function layoutScore(q: QualityReport): number {
  if (q.overlaps || q.shapeCrossings || q.labelCollisions || q.labelAmbiguity || q.pinDrift) return Infinity;
  const aspectPenalty = Math.max(0, 0.6 - q.aspect, q.aspect - 1.8);
  return q.edgeCrossings * 2 + q.meanEdgeRatio + aspectPenalty * 6 - q.density * 4;
}

export function compactCandidates(clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Record<string, Point>): LayoutResult[] {
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
    if (readable && Number.isFinite(layoutScore(assessQuality(result.diagram, pins)))) high = factor;
    else low = factor;
  }
  for (const [sx, sy] of [[0.75, 1], [1, 0.75], [0.65, 1.25], [1.25, 0.65]]) {
    const result = build(scaled(high, sx, sy));
    if (readableEnds(result)) results.push(result);
  }
  return results;
}

export function compactLocally(initial: LayoutResult, clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Record<string, Point>): LayoutResult {
  let best = initial;
  let score = layoutScore(assessQuality(best.diagram, pins));
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
    const value = layoutScore(assessQuality(next.diagram, pins));
    if (value < score) { best = next; score = value; }
  }
  return best;
}
