import type { Box, Diagram, Point } from "../geometry.js";
import { segments } from "./shapes.js";

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
