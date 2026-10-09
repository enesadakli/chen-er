import type { Diagram, Point } from "./geometry.js";

/**
 * Quality contract: measures the final geometry exactly as it will be drawn.
 * Implemented by the layout lane; until then every count is 0 and `implemented` is false.
 */
export interface QualityIssue {
  kind: "overlap" | "shape-crossing" | "label-collision" | "edge-crossing" | "pin-drift" | "out-of-canvas";
  /** Ids of the nodes, edges or labels involved. */
  ids: string[];
  message: string;
}

export interface QualityReport {
  implemented: boolean;
  /** Shapes (nodes) whose boxes overlap. */
  overlaps: number;
  /** Edges passing through a shape that is not one of their endpoints. */
  shapeCrossings: number;
  /** Labels overlapping a shape, another label, or a foreign edge. */
  labelCollisions: number;
  /** Pairs of edges crossing each other. */
  edgeCrossings: number;
  /** Pinned nodes further than 0.5px from their pin. */
  pinDrift: number;
  issues: QualityIssue[];
}

export function assessQuality(diagram: Diagram, pins: Record<string, Point> = {}): QualityReport {
  void diagram;
  void pins;
  return { implemented: false, overlaps: 0, shapeCrossings: 0, labelCollisions: 0, edgeCrossings: 0, pinDrift: 0, issues: [] };
}
