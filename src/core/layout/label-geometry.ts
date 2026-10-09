import { center, type Box, type DEdge, type Point } from "../geometry.js";
import { distance, drawnPaths, segments } from "./shapes.js";

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from the occupied text rectangle, rather than its center. */
export function boxSegmentDistance(box: Box, a: Point, b: Point): number {
  const right = box.x + box.w, bottom = box.y + box.h;
  let low = 0, high = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.x, right], [a.y, b.y - a.y, box.y, bottom]] as const) {
    if (!delta) {
      if (start < min || start > max) { high = -1; break; }
    } else {
      const t0 = (min - start) / delta, t1 = (max - start) / delta;
      low = Math.max(low, Math.min(t0, t1));
      high = Math.min(high, Math.max(t0, t1));
    }
  }
  if (low <= high) return 0;
  const toBox = (p: Point) => Math.hypot(Math.max(box.x - p.x, 0, p.x - right), Math.max(box.y - p.y, 0, p.y - bottom));
  return Math.min(toBox(a), toBox(b),
    pointSegmentDistance({ x: box.x, y: box.y }, a, b), pointSegmentDistance({ x: right, y: box.y }, a, b),
    pointSegmentDistance({ x: right, y: bottom }, a, b), pointSegmentDistance({ x: box.x, y: bottom }, a, b));
}

export function labelAmbiguityReasons(box: Box, edge: DEdge, edges: DEdge[]): string[] {
  const end = edge.points.at(-1), previous = edge.points.at(-2);
  if (!end || !previous) return ["missing entity-end segment"];
  const own = Math.min(...drawnPaths(edge).map((path) => boxSegmentDistance(box, path.at(-2)!, path.at(-1)!)));
  const length = distance(end, previous);
  const c = center(box);
  const along = length ? ((c.x - end.x) * (previous.x - end.x) + (c.y - end.y) * (previous.y - end.y)) / length : Infinity;
  const reasons: string[] = [];
  if (own > 14 + 1e-7) reasons.push("more than 14px from entity-end segment");
  if (edges.some((other) => other.kind === "end" && other.id !== edge.id && drawnPaths(other).flatMap(segments).some(([a, b]) => boxSegmentDistance(box, a, b) < own - 1e-7))) reasons.push("closer to another end edge");
  if (Math.abs(along) > 60 + 1e-7) reasons.push("more than 60px along the edge from entity end");
  return reasons;
}
