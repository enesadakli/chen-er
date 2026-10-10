import { center, intersects, type Box, type DEdge, type DNode, type Point } from "../geometry.js";

import { style } from "../style.js";

const EPS = 1e-7;
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

export function polygon(node: Pick<DNode, "kind" | "box">): Point[] {
  const b = node.box;
  const c = center(b);
  if (node.kind === "entity") return [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ];
  if (node.kind === "relationship") return [
    { x: c.x, y: b.y }, { x: b.x + b.w, y: c.y },
    { x: c.x, y: b.y + b.h }, { x: b.x, y: c.y },
  ];
  // A tight circumscribed polygon bounds ellipse error to 0.054% of its radius.
  const count = 96;
  const scale = 1 / Math.cos(Math.PI / count);
  return Array.from({ length: count }, (_, i) => ({
    x: c.x + b.w / 2 * scale * Math.cos(2 * Math.PI * (i + 0.5) / count),
    y: c.y + b.h / 2 * scale * Math.sin(2 * Math.PI * (i + 0.5) / count),
  }));
}

export function pointInside(p: Point, node: Pick<DNode, "kind" | "box">, strict = false): boolean {
  const c = center(node.box);
  const x = Math.abs(p.x - c.x) / (node.box.w / 2);
  const y = Math.abs(p.y - c.y) / (node.box.h / 2);
  const v = node.kind === "entity" ? Math.max(x, y) : node.kind === "relationship" ? x + y : x * x + y * y;
  return strict ? v < 1 - EPS : v <= 1 + EPS;
}

export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | "overlap" | undefined {
  // Disjoint bounding boxes never meet; one pixel exceeds every EPS tolerance below.
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) - 1 || Math.max(c.x, d.x) < Math.min(a.x, b.x) - 1
    || Math.max(a.y, b.y) < Math.min(c.y, d.y) - 1 || Math.max(c.y, d.y) < Math.min(a.y, b.y) - 1) return undefined;
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < EPS) {
    if (Math.abs(cross(a, b, c)) > EPS) return undefined;
    const len = rx * rx + ry * ry;
    if (len < EPS) return pointSegmentDistance(a, c, d) < EPS ? a : undefined;
    const t0 = ((c.x - a.x) * rx + (c.y - a.y) * ry) / len;
    const t1 = ((d.x - a.x) * rx + (d.y - a.y) * ry) / len;
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
    if (hi < lo - EPS) return undefined;
    if (hi - lo > EPS) return "overlap";
    return { x: a.x + lo * rx, y: a.y + lo * ry };
  }
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? { x: a.x + t * rx, y: a.y + t * ry } : undefined;
}

export function segmentThrough(a: Point, b: Point, node: Pick<DNode, "kind" | "box">): boolean {
  const box = node.box;
  if (Math.max(a.x, b.x) < box.x - 1 || Math.min(a.x, b.x) > box.x + box.w + 1 || Math.max(a.y, b.y) < box.y - 1 || Math.min(a.y, b.y) > box.y + box.h + 1) return false;
  if (pointInside(a, node, true) || pointInside(b, node, true)) return true;
  if (node.kind === "attribute") {
    const c = center(node.box), rx = node.box.w / 2, ry = node.box.h / 2;
    const x = (a.x - c.x) / rx, y = (a.y - c.y) / ry;
    const dx = (b.x - a.x) / rx, dy = (b.y - a.y) / ry;
    const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
    return (x + t * dx) ** 2 + (y + t * dy) ** 2 < 1 - EPS;
  }
  const ps = polygon(node);
  const hits: Point[] = [];
  for (let i = 0; i < ps.length; i++) {
    const hit = segmentIntersection(a, b, ps[i]!, ps[(i + 1) % ps.length]!);
    if (hit && hit !== "overlap") hits.push(hit);
  }
  return hits.some((p) => hits.some((q) => distance(p, q) > EPS && pointInside({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, node, true)));
}

const sides = (ps: Point[]): [Point, Point][] => ps.map((p, i) => [p, ps[(i + 1) % ps.length]!]);
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function insidePolygon(p: Point, ps: Point[]): boolean {
  return sides(ps).every(([a, b]) => cross(a, b, p) >= -EPS);
}
export function shapesNear(a: Pick<DNode, "kind" | "box">, b: Pick<DNode, "kind" | "box">, gap = 0): boolean {
  if (!intersects(a.box, b.box, gap + EPS)) return false;
  const pa = polygon(a), pb = polygon(b);
  if (insidePolygon(pa[0]!, pb) || insidePolygon(pb[0]!, pa)) return true;
  const sa = sides(pa), sb = sides(pb);
  for (const [p, q] of sa) for (const [r, s] of sb) {
    if (segmentIntersection(p, q, r, s)) return true;
    if (gap > 0 && Math.min(pointSegmentDistance(p, r, s), pointSegmentDistance(q, r, s), pointSegmentDistance(r, p, q), pointSegmentDistance(s, p, q)) < gap - EPS) return true;
  }
  return false;
}
export const boxShape = (box: Box): Pick<DNode, "kind" | "box"> => ({ kind: "entity", box });
export const segments = (ps: readonly Point[]): [Point, Point][] => ps.slice(1).map((p, i) => [ps[i]!, p]);

/** Positive-area intersection, excluding contact along a label boundary. */
export function shapesOverlap(a: Pick<DNode, "kind" | "box">, b: Pick<DNode, "kind" | "box">): boolean {
  if (!intersects(a.box, b.box)) return false;
  const pa = polygon(a), pb = polygon(b);
  for (const [p, q] of [...sides(pa), ...sides(pb)]) {
    const axis = { x: p.y - q.y, y: q.x - p.x };
    const project = (v: Point) => v.x * axis.x + v.y * axis.y;
    const aa = pa.map(project), bb = pb.map(project);
    if (Math.min(Math.max(...aa), Math.max(...bb)) - Math.max(Math.min(...aa), Math.min(...bb)) <= EPS) return false;
  }
  return true;
}

/** Match the renderer's two parallel copies of a double polyline. */
export function drawnPaths(edge: DEdge): Point[][] {
  if (!edge.double) return [edge.points];
  return [-style.doubleEdgeGap / 2, style.doubleEdgeGap / 2].map((gap) => edge.points.map((p, i, ps) => {
    const a = ps[Math.max(0, i - 1)]!, b = ps[Math.min(ps.length - 1, i + 1)]!;
    const len = distance(a, b) || 1;
    return { x: p.x - (b.y - a.y) / len * gap, y: p.y + (b.x - a.x) / len * gap };
  }));
}
