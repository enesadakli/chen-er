import type { Box, DEdge, Diagram, DNode, Point } from "../geometry.js";
import { distance, drawnPaths, polygon, segmentBoxGap, segmentIntersection, segmentShapeGap, segments } from "./shapes.js";

export interface ClearanceQuality {
  /** Smallest gap in px between an attribute spoke and a parallel end edge beside it; Infinity when none. */
  spokeEdgeClearance: number;
  /** Parallel spoke/end-edge pairs closer than MIN_SPOKE_EDGE_CLEARANCE. */
  spokeEdgeViolations: number;
  /** Smallest gap in px between an attribute oval and any participation label; Infinity when none. */
  spokeLabelClearance: number;
  /** Ovals closer than MIN_OVAL_LABEL_CLEARANCE to a label. */
  spokeLabelViolations: number;
}

export const MIN_SPOKE_EDGE_CLEARANCE = 12;
export const MIN_OVAL_LABEL_CLEARANCE = 8;
const PARALLEL_SIN = Math.sin((15 * Math.PI) / 180);

/** Perpendicular gap of two nearly parallel segments whose projections overlap; undefined otherwise. */
export function parallelGap(a: Point, b: Point, c: Point, d: Point): number | undefined {
  const len = Math.hypot(b.x - a.x, b.y - a.y), other = Math.hypot(d.x - c.x, d.y - c.y);
  if (len < 20 || other < 20) return undefined;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  if (Math.abs(ux * (d.y - c.y) - uy * (d.x - c.x)) / other > PARALLEL_SIN) return undefined;
  const along = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  const lo = Math.max(0, Math.min(along(c), along(d))), hi = Math.min(len, Math.max(along(c), along(d)));
  if (hi - lo < 8) return undefined;
  return Math.abs(-(c.x - a.x) * uy + (c.y - a.y) * ux);
}

export const boxGap = (a: Box, b: Box): number =>
  Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));

export function clearanceQuality(diagram: Diagram): ClearanceQuality {
  const spokes = diagram.edges.filter((e) => e.kind !== "end").flatMap((e) => segments(e.points));
  const ends = diagram.edges.filter((e) => e.kind === "end").flatMap((e) => segments(e.points));
  let spokeEdgeClearance = Infinity, spokeEdgeViolations = 0;
  for (const [a, b] of spokes) for (const [c, d] of ends) {
    const gap = parallelGap(a, b, c, d);
    if (gap === undefined) continue;
    spokeEdgeClearance = Math.min(spokeEdgeClearance, gap);
    if (gap < MIN_SPOKE_EDGE_CLEARANCE) spokeEdgeViolations++;
  }
  let spokeLabelClearance = Infinity, spokeLabelViolations = 0;
  for (const n of diagram.nodes) if (n.kind === "attribute") {
    const gap = Math.min(Infinity, ...diagram.labels.map((l) => boxGap(n.box, l.box)));
    spokeLabelClearance = Math.min(spokeLabelClearance, gap);
    if (gap < MIN_OVAL_LABEL_CLEARANCE) spokeLabelViolations++;
  }
  return { spokeEdgeClearance, spokeEdgeViolations, spokeLabelClearance, spokeLabelViolations };
}

/** 14px separates a foreign end edge from a node and its nearby endpoint crossing. */
export const MIN_EDGE_NODE_CLEARANCE = 14;

type Segment = [Point, Point];
export interface EdgeNodeContext {
  lines: Map<string, Segment[]>;
  crossings: Map<string, Segment[]>;
  outlines: Map<DNode, Point[]>;
}

export function edgeNodeContext(edges: DEdge[]): EdgeNodeContext {
  return { lines: new Map(edges.map((e) => [e.id, drawnPaths(e).flatMap(segments)])), crossings: new Map(), outlines: new Map() };
}

function crossingSegments(edge: DEdge, context: EdgeNodeContext): Segment[] {
  const cached = context.crossings.get(edge.id);
  if (cached) return cached;
  const hits: Segment[] = [];
  for (const [a, b] of context.lines.get(edge.id)!) for (const [id, lines] of context.lines) {
    if (id === edge.id) continue;
    for (const [c, d] of lines) {
      const hit = segmentIntersection(a, b, c, d);
      if (hit && hit !== "overlap") hits.push([hit, hit]);
      else if (hit === "overlap") {
        const len = distance(a, b);
        if (!len) continue;
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        const along = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
        const lo = Math.max(0, Math.min(along(c), along(d))), hi = Math.min(len, Math.max(along(c), along(d)));
        hits.push([{ x: a.x + lo * ux, y: a.y + lo * uy }, { x: a.x + hi * ux, y: a.y + hi * uy }]);
      }
    }
  }
  context.crossings.set(edge.id, hits);
  return hits;
}

function parallelsOutline(a: Point, b: Point, c: Point, d: Point): boolean {
  const len = distance(a, b), other = distance(c, d);
  if (len < 1e-6 || other < 1e-6) return false;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  if (Math.abs(ux * (d.y - c.y) - uy * (d.x - c.x)) / other > PARALLEL_SIN) return false;
  const along = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  return Math.min(len, Math.max(along(c), along(d))) - Math.max(0, Math.min(along(c), along(d))) > 1e-6;
}

/** Gap for parallel flat-outline skims or an edge crossing beside a foreign node. */
export function edgeNodeGap(edge: DEdge, node: DNode, edges: DEdge[], context = edgeNodeContext([edge, ...edges.filter((e) => e.id !== edge.id)])): number {
  if (edge.kind !== "end" || node.id === edge.from || node.id === edge.to) return Infinity;
  let gap = Infinity;
  let outline = context.outlines.get(node);
  if (!outline) context.outlines.set(node, outline = node.kind === "attribute" ? [] : polygon(node));
  const lines = context.lines.get(edge.id)!;
  for (const [a, b] of lines) for (let i = 0; i < outline.length; i++) {
    const c = outline[i]!, d = outline[(i + 1) % outline.length]!;
    if (parallelsOutline(a, b, c, d) && segmentBoxGap(a, b, node.box) < gap) gap = Math.min(gap, segmentShapeGap(a, b, node));
  }
  // Only crossings in the band need outline distance checks.
  if (lines.some(([a, b]) => segmentBoxGap(a, b, node.box) < MIN_EDGE_NODE_CLEARANCE)) {
    for (const [a, b] of crossingSegments(edge, context)) {
      if (segmentBoxGap(a, b, node.box) < MIN_EDGE_NODE_CLEARANCE) gap = Math.min(gap, segmentShapeGap(a, b, node));
    }
  }
  return gap;
}

/** Spokes and own endpoints are exempt; unrelated crossings far from nodes are allowed. */
export function edgeNodeClear(edge: DEdge, nodes: DNode[], edges: DEdge[] = []): boolean {
  if (edge.kind !== "end") return true;
  const context = edgeNodeContext([edge, ...edges.filter((e) => e.id !== edge.id)]);
  return nodes.every((n) => edgeNodeGap(edge, n, edges, context) >= MIN_EDGE_NODE_CLEARANCE - 1e-6);
}
