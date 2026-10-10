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

// Every hard geometry target is a veto, including attribute clearances and canvas bounds.
const HARD = ["diagonalEnds", "overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose",
  "labelOnOwnEdge", "labelOnAnyEdge", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments",
  "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts", "spokeEdgeViolations", "spokeLabelViolations"] as const;
const outsideCount = (q: QualityReport) => q.issues.filter((issue) => issue.kind === "out-of-canvas").length;

/** Veto any hard regression, then compare hierarchy and only break hierarchy ties with soft metrics. */
export function preferFresh(incremental: QualityReport, fresh: QualityReport): boolean {
  if (!incremental.implemented || !fresh.implemented || fresh.pinDrift !== 0) return false;
  if (HARD.some((key) => fresh[key] > incremental[key]) || outsideCount(fresh) > outsideCount(incremental)) return false;
  if (fresh.hierarchyViolations !== incremental.hierarchyViolations) return fresh.hierarchyViolations < incremental.hierarchyViolations;
  return incremental.edgeCrossings - fresh.edgeCrossings >= 2
    || (incremental.longEdgeMax > 0 && fresh.longEdgeMax <= incremental.longEdgeMax * .8);
}
