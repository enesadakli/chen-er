import { center, type Box, type DEdge, type DLabel, type DNode, type Point } from "../geometry.js";
import { boxShape, distance, drawnPaths, polygon, segments, shapesOverlap } from "./shapes.js";

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from the occupied text rectangle, rather than its center. */
export function boxSegmentDistance(box: Box, a: Point, b: Point): number {
  const right = box.x + box.w, bottom = box.y + box.h;
  if (a.x === b.x) return Math.hypot(Math.max(box.x - a.x, a.x - right, 0), Math.max(box.y - Math.max(a.y, b.y), Math.min(a.y, b.y) - bottom, 0));
  if (a.y === b.y) return Math.hypot(Math.max(box.x - Math.max(a.x, b.x), Math.min(a.x, b.x) - right, 0), Math.max(box.y - a.y, a.y - bottom, 0));
  const dx = b.x - a.x, dy = b.y - a.y;
  const tx0 = (box.x - a.x) / dx, tx1 = (right - a.x) / dx;
  const ty0 = (box.y - a.y) / dy, ty1 = (bottom - a.y) / dy;
  if (Math.max(0, Math.min(tx0, tx1), Math.min(ty0, ty1)) <= Math.min(1, Math.max(tx0, tx1), Math.max(ty0, ty1))) return 0;
  const lengthSquared = dx * dx + dy * dy;
  const cornerDistance = (x: number, y: number) => {
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
    return (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2;
  };
  const endpointDistance = (p: Point) => Math.max(box.x - p.x, 0, p.x - right) ** 2 + Math.max(box.y - p.y, 0, p.y - bottom) ** 2;
  return Math.sqrt(Math.min(endpointDistance(a), endpointDistance(b), cornerDistance(box.x, box.y), cornerDistance(right, box.y),
    cornerDistance(right, bottom), cornerDistance(box.x, bottom)));
}

export function labelAmbiguityReasons(box: Box, edge: DEdge, edges: DEdge[], geometry?: LabelGeometry): string[] {
  const end = edge.points.at(-1), previous = edge.points.at(-2);
  if (!end || !previous) return ["missing entity-end segment"];
  const own = Math.min(...(geometry?.first.get(edge.id) ?? drawnPaths(edge).map((path) => [path.at(-2)!, path.at(-1)!] as [Point, Point])).map(([a, b]) => boxSegmentDistance(box, a, b)));
  const length = distance(end, previous);
  const c = center(box);
  const along = length ? ((c.x - end.x) * (previous.x - end.x) + (c.y - end.y) * (previous.y - end.y)) / length : Infinity;
  const reasons: string[] = [];
  if (own > 14 + 1e-7) reasons.push("more than 14px from entity-end segment");
  if (edges.some((other) => other.kind === "end" && other.id !== edge.id && (geometry?.lines.get(other.id) ?? drawnPaths(other).flatMap(segments)).some(([a, b]) => boxSegmentDistance(box, a, b) < own - 1e-7))) reasons.push("closer to another end edge");
  if (Math.abs(along) > 60 + 1e-7) reasons.push("more than 60px along the edge from entity end");
  return reasons;
}

export function boxDistance(a: Box, b: Box): number {
  return Math.hypot(Math.max(a.x - b.x - b.w, b.x - a.x - a.w, 0), Math.max(a.y - b.y - b.h, b.y - a.y - a.h, 0));
}

export interface LabelGeometry {
  edges: ReadonlyMap<string, DEdge>;
  lines: ReadonlyMap<string, [Point, Point][]>;
  first: ReadonlyMap<string, [Point, Point][]>;
  shapes: { node: DNode; outline?: [Point, Point][] }[];
}

export function labelGeometry(nodes: DNode[], edges: DEdge[], paths?: ReadonlyMap<string, Point[][]>): LabelGeometry {
  const ends = edges.filter((edge) => edge.kind === "end");
  const drawn = new Map(ends.map((edge) => [edge.id, paths?.get(edge.id) ?? drawnPaths(edge)]));
  return {
    edges: new Map(edges.map((edge) => [edge.id, edge])),
    lines: new Map(ends.map((edge) => [edge.id, drawn.get(edge.id)!.flatMap(segments)])),
    first: new Map(ends.map((edge) => [edge.id, drawn.get(edge.id)!.filter((path) => path.length >= 2)
      .map((path) => [path.at(-2)!, path.at(-1)!] as [Point, Point])])),
    shapes: nodes.map((node) => ({ node })),
  };
}

/** The entity is the last endpoint in the relationship-to-entity polyline. */
export function labelLooseReasons(label: DLabel, edge: DEdge, geometry: LabelGeometry, labels: DLabel[] = [], stopAtFirst = false): string[] {
  const end = edge.points.at(-1), previous = edge.points.at(-2);
  if (!end || !previous || distance(end, previous) < 1e-7) return ["missing entity-end segment"];
  const length = distance(end, previous), ux = (previous.x - end.x) / length, uy = (previous.y - end.y) / length;
  const c = center(label.box);
  const along = (c.x - end.x) * ux + (c.y - end.y) * uy;
  const own = Math.min(...(geometry.first.get(edge.id) ?? [[previous, end]]).map(([a, b]) => boxSegmentDistance(label.box, a, b)));
  const normal = -(c.x - end.x) * uy + (c.y - end.y) * ux;
  const radius = (label.box.w * Math.abs(uy) + label.box.h * Math.abs(ux)) / 2;
  const reasons: string[] = [];
  if (along < -1e-7 || along > Math.min(48, length) + 1e-7) reasons.push("outside first 48px of entity-end segment");
  if (Math.abs(normal) < radius - 1e-7) reasons.push("straddles entity-end segment");
  if (own > 8 + 1e-7) reasons.push("more than 8px from entity-end segment");
  if (stopAtFirst && reasons.length) return reasons;
  const required = 2 * own - 1e-7;
  for (const [id, lines] of geometry.lines) if (id !== edge.id && lines.some(([a, b]) => boxSegmentDistance(label.box, a, b) < required)) {
    reasons.push("another end edge is less than twice as far away");
    if (stopAtFirst) return reasons;
    break;
  }
  for (const shape of geometry.shapes) {
    if (boxDistance(label.box, shape.node.box) >= required) continue;
    if (shape.node.kind === "entity") { reasons.push("a shape is less than twice as far away"); break; }
    if (!shape.outline) {
      const points = polygon(shape.node);
      shape.outline = points.map((p, i) => [p, points[(i + 1) % points.length]!] as [Point, Point]);
    }
    if (shapesOverlap(boxShape(label.box), shape.node) || shape.outline.some(([a, b]) => boxSegmentDistance(label.box, a, b) < required)) {
      reasons.push("a shape is less than twice as far away");
      break;
    }
  }
  if (stopAtFirst && reasons.length) return reasons;
  if (labels.some((other) => other.id !== label.id && geometry.edges.get(other.edge)?.to === edge.to && boxDistance(label.box, other.box) < 10 - 1e-7)) reasons.push("another label of the entity is less than 10px away");
  return reasons;
}
