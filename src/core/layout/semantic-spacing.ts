import type { Box, LayoutResult, Point } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { assessQuality, type QualityReport } from "../quality.js";
import type { Cluster } from "./clusters.js";
import { layoutScore } from "./compact.js";
import { placeSemantically, type SemanticPlacement } from "./semantic.js";

export interface Spacing { columns: number; rows: number }

/**
 * Candidate budget for the spacing and Z-route searches. One build costs roughly the square of the
 * model size, so beyond 12 entities a search keeps a share that shrinks with the square, never below
 * one candidate. Large drawings rarely pass those searches' route limits anyway. Counts depend only
 * on the model, so the same input always gives the same drawing.
 */
export const searchBudget = (count: number, model: NModel): number =>
  Math.max(1, Math.ceil(count * Math.min(1, (12 / Math.max(1, model.entities.length)) ** 2)));

/** A bounded grid at or below the default cell size; the default always comes first. */
function spacingCandidates(base: number): Spacing[] {
  const columns = [...new Set([base, 520, 480].filter((s) => s <= base))];
  const rows = [...new Set([base, 520, 430, 380, 340].filter((s) => s <= base))];
  return columns.flatMap((c) => rows.map((r) => ({ columns: c, rows: r })));
}

/** Skeleton scores at or above this carry a route penalty (a third bend or a long detour). */
const SKELETON_LIMIT = 1000;

/**
 * Score a candidate on its relationship skeleton only. Attribute ovals are left out on purpose:
 * entity cells must not depend on attributes, or a one-attribute edit would move the drawing.
 */
function skeletonSpacingScore(result: LayoutResult, model: NModel): number {
  const q = assessQuality(result.diagram, {}, model);
  const value = layoutScore(q);
  if (!Number.isFinite(value)) return Infinity;
  const ends = result.diagram.edges.filter((e) => e.kind === "end").length;
  // Every diagonal fallback end costs as much as two extra bends.
  return value + q.edgeCrossings * 14 + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4 + (1 - q.axisAligned) * ends * 4
    + Math.max(0, q.endBendsMax - 2) * 1000 + Math.max(0, q.routeDetourMax - 1.5) * 100;
}

const withoutAttributes = (clusters: Cluster[]): Cluster[] => clusters.map((c) => ({ ...c, attrs: [], node: { ...c.node, box: { ...c.node.box } } }));

/** A tighter grid is only kept when the finished drawing stays within the route and spoke limits. */
const fullSpacingAccepted = (q: QualityReport): boolean =>
  Number.isFinite(layoutScore(q)) && q.endBendsMax <= 2 && q.routeDetourMax <= 1.6 && q.attributeSpokeMax <= 2.5;

/**
 * Bounded spacing search for larger unpinned models. Candidates are ranked on the skeleton; the
 * first one whose full drawing passes the limits wins, otherwise the default grid stays.
 */
export function chooseSpacing(clusters: Cluster[], model: NModel, placement: SemanticPlacement, base: number, reserved: Box[], pins: Record<string, Point>,
  build: (cs: Cluster[]) => LayoutResult): { spacing: Spacing; initial?: LayoutResult } {
  const fallback = { spacing: { columns: base, rows: base } };
  if (Object.keys(pins).length || model.entities.length <= 4) return fallback;
  const candidates = spacingCandidates(base);
  const ranked = candidates.slice(0, searchBudget(candidates.length, model)).map((candidate) => {
    placeSemantically(clusters, model, placement, candidate.columns, reserved, candidate.rows);
    return { candidate, score: skeletonSpacingScore(build(withoutAttributes(clusters)), model) };
  }).filter((c) => c.score < SKELETON_LIMIT).sort((a, b) => a.score - b.score);
  for (const { candidate } of ranked) {
    if (candidate.columns === base && candidate.rows === base) break;
    placeSemantically(clusters, model, placement, candidate.columns, reserved, candidate.rows);
    const initial = build(clusters);
    if (fullSpacingAccepted(assessQuality(initial.diagram, pins, model))) return { spacing: candidate, initial };
  }
  return fallback;
}
