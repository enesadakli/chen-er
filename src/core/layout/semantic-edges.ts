import { center, type Box, type DEdge, type Diagram, type DNode, type Point } from "../geometry.js";
import { style } from "../style.js";
import { distance, segmentIntersection, segments } from "./shapes.js";

export const MIN_ROUTE_SEGMENT = 12;
export const MIN_END_SEPARATION = 16;
const EPS = 1e-6;

/** Match the renderer's mitered offsets, including endpoint normals. */
export function visibleEdgePaths(edge: DEdge): Point[][] {
  if (!edge.double) return [edge.points];
  const normals = segments(edge.points).map(([a, b]) => {
    const length = distance(a, b);
    return length > EPS ? { x: -(b.y - a.y) / length, y: (b.x - a.x) / length } : undefined;
  });
  return [-style.doubleEdgeGap / 2, style.doubleEdgeGap / 2].map((gap) => edge.points.map((p, i) => {
    const before = normals.slice(0, i).reverse().find((n) => n !== undefined);
    const after = normals.slice(i).find((n) => n !== undefined);
    const a = before ?? after ?? { x: 0, y: 0 }, b = after ?? a;
    const denominator = 1 + a.x * b.x + a.y * b.y;
    const shift = denominator > EPS ? { x: (a.x + b.x) * gap / denominator, y: (a.y + b.y) * gap / denominator } : { x: a.x * gap, y: a.y * gap };
    return { x: p.x + shift.x, y: p.y + shift.y };
  }));
}

export function orthogonalPath(points: Point[]): boolean {
  return points.length >= 2 && segments(points).every(([a, b]) => Math.abs(a.x - b.x) <= EPS || Math.abs(a.y - b.y) <= EPS);
}

export function reverses(points: Point[]): boolean {
  return points.some((b, i) => {
    const a = points[i - 1], c = points[i + 1];
    if (!a || !c) return false;
    return Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) <= EPS
      && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -EPS;
  });
}

export function edgesOverlap(a: DEdge, b: DEdge): boolean {
  return visibleEdgePaths(a).flatMap(segments).some(([p, q]) => visibleEdgePaths(b).flatMap(segments).some(([r, s]) => segmentIntersection(p, q, r, s) === "overlap"));
}

export function dominantVertex(diamond: DNode, entity: DNode): { point: Point; normal: Point } | undefined {
  const c = center(diamond.box), target = center(entity.box), dx = target.x - c.x, dy = target.y - c.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return { point: { x: c.x + Math.sign(dx) * diamond.box.w / 2, y: c.y }, normal: { x: Math.sign(dx), y: 0 } };
  if (Math.abs(dy) > Math.abs(dx) * 1.5) return { point: { x: c.x, y: c.y + Math.sign(dy) * diamond.box.h / 2 }, normal: { x: 0, y: Math.sign(dy) } };
  return undefined;
}

function endpointSides(p: Point, box: Box): number[] {
  const distances = [Math.abs(p.x - box.x), Math.abs(p.y - box.y), Math.abs(p.x - box.x - box.w), Math.abs(p.y - box.y - box.h)];
  return distances.flatMap((d, side) => d <= EPS ? [side] : []);
}

export interface EdgeQuality {
  /** Number of attribute/part edges with more than one nonzero segment. */
  attributeEdgeBends: number;
  /** Number of edge pairs (including an edge with itself) sharing rendered segment length. */
  edgeOverlap: number;
  /** Number of sub-12px segments in orthogonal routes, including rendered copies. */
  tinySegments: number;
  /** Number of end pairs less than 16px apart on the same entity side. */
  endPortCrowding: number;
  /** Orthogonal nonrecursive ends departing a nonmatching dominant diamond vertex. */
  diamondVertexViolations: number;
  /** Double edges with reversals, self-overlap, or intersecting parallel copies. */
  doubleEdgeArtifacts: number;
}

export function edgeQuality(diagram: Diagram): EdgeQuality {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  let edgeOverlap = 0, tinySegments = 0, endPortCrowding = 0, diamondVertexViolations = 0, doubleEdgeArtifacts = 0;
  const visible = new Map(diagram.edges.map((e) => [e.id, visibleEdgePaths(e).flatMap(segments)]));
  for (let i = 0; i < diagram.edges.length; i++) {
    const e = diagram.edges[i]!;
    const lines = visible.get(e.id)!;
    if (lines.some(([a, b], j) => lines.slice(j + 1).some(([c, d]) => segmentIntersection(a, b, c, d) === "overlap"))) edgeOverlap++;
    for (const other of diagram.edges.slice(i + 1)) if (lines.some(([a, b]) => visible.get(other.id)!.some(([c, d]) => segmentIntersection(a, b, c, d) === "overlap"))) edgeOverlap++;
    if (orthogonalPath(e.points)) {
      // Count centerline segments once, even if both copies have the same short segment.
      const copies = [e.points, ...visibleEdgePaths(e)];
      tinySegments += segments(e.points).filter((_, j) => copies.some((ps) => distance(ps[j]!, ps[j + 1]!) < MIN_ROUTE_SEGMENT - EPS)).length;
    }
    if (e.kind !== "end") continue;
    if (orthogonalPath(e.points)) {
      const diamond = byId.get(e.from), entity = byId.get(e.to);
      const recursive = diagram.edges.filter((other) => other.kind === "end" && other.from === e.from).every((other) => other.to === e.to);
      if (diamond?.kind === "relationship" && entity && !recursive) {
        const vertex = dominantVertex(diamond, entity), first = e.points[0]!, second = e.points[1]!;
        if (vertex && (distance(first, vertex.point) > EPS || (second.x - first.x) * vertex.normal.x + (second.y - first.y) * vertex.normal.y <= EPS)) diamondVertexViolations++;
      }
    }
    const end = e.points.at(-1), entity = byId.get(e.to);
    if (end && entity?.kind === "entity") for (const other of diagram.edges.slice(i + 1).filter((other) => other.kind === "end" && other.to === e.to)) {
      const p = other.points.at(-1);
      if (p && endpointSides(end, entity.box).some((side) => endpointSides(p, entity.box).includes(side)) && distance(end, p) < MIN_END_SEPARATION - EPS) endPortCrowding++;
    }
    if (e.double) {
      const copies = visibleEdgePaths(e), a = copies[0]!, b = copies[1]!;
      const selfOverlap = copies.some((ps) => segments(ps).some(([p, q], j, lines) => lines.slice(j + 1).some(([r, s]) => segmentIntersection(p, q, r, s) === "overlap")));
      const intersecting = segments(a).some(([p, q]) => segments(b).some(([r, s]) => !!segmentIntersection(p, q, r, s)));
      if (reverses(e.points) || selfOverlap || intersecting) doubleEdgeArtifacts++;
    }
  }
  return { attributeEdgeBends: diagram.edges.filter((e) => e.kind !== "end" && segments(e.points).filter(([a, b]) => distance(a, b) > EPS).length > 1).length,
    edgeOverlap, tinySegments, endPortCrowding, diamondVertexViolations, doubleEdgeArtifacts };
}
