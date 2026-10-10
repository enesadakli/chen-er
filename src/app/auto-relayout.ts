import type { NModel } from "../core/normalize.js";
import type { QualityReport } from "../core/quality.js";

/** Labels, attributes, roles and cardinalities do not change the graph's identity. */
export function modelStructure(model: NModel): string {
  return JSON.stringify({
    entities: model.entities.map((e) => e.id).sort(),
    relationships: model.relationships.map((r) => r.id).sort(),
    ends: model.relationships.flatMap((r) => r.ends.map((e) => [e.id, e.entity])).sort(),
  });
}

// Hard geometry targets from the quality benchmark, plus canvas bounds.
const HARD = ["diagonalEnds", "overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose",
  "labelOnOwnEdge", "labelOnAnyEdge", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments",
  "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts"] as const;
export function layoutViolations(q: QualityReport): number {
  return HARD.reduce((sum, key) => sum + q[key], q.hierarchyViolations)
    + q.issues.filter((issue) => issue.kind === "out-of-canvas").length;
}

/** Keep incremental on ties; never accept fresh geometry that drifts a pin. */
export function preferFresh(incremental: QualityReport, fresh: QualityReport): boolean {
  if (!incremental.implemented || !fresh.implemented || fresh.pinDrift !== 0) return false;
  const before = layoutViolations(incremental), after = layoutViolations(fresh);
  if (before !== after) return after < before;
  return incremental.edgeCrossings - fresh.edgeCrossings >= 2
    || (incremental.longEdgeMax > 0 && fresh.longEdgeMax <= incremental.longEdgeMax * .8);
}
