import { edgeQuality, type EdgeQuality } from "./layout/semantic-edges.js";
import type { NModel } from "./normalize.js";
import { clearanceQuality, type ClearanceQuality } from "./layout/semantic-clearance.js";
import { semanticQuality, type SemanticQuality } from "./layout/semantic-quality.js";
import { labelAmbiguityReasons, labelGeometry, labelLooseReasons, labelOnOwnEdge } from "./layout/label-geometry.js";
import { center, type Diagram, type Point } from "./geometry.js";
import { boxShape, distance, drawnPaths, pointInside, segmentIntersection, segments, segmentThrough, shapesNear, shapesOverlap } from "./layout/shapes.js";

export interface QualityIssue {
  kind: "overlap" | "shape-crossing" | "label-collision" | "label-ambiguity" | "label-loose" | "label-on-own-edge" | "edge-crossing" | "pin-drift" | "out-of-canvas";
  ids: string[];
  message: string;
}

export interface QualityReport extends SemanticQuality, EdgeQuality, ClearanceQuality {
  implemented: boolean;
  overlaps: number;
  shapeCrossings: number;
  labelCollisions: number;
  labelAmbiguity: number;
  /** Labels that fail entity-end proximity, ownership or spacing requirements; hard target zero. */
  labelLoose: number;
  /** Labels whose box inflated by 2px intersects their own drawn end edge; hard target zero. */
  labelOnOwnEdge: number;
  edgeCrossings: number;
  pinDrift: number;
  aspect: number;
  /** Sum of end-edge centerline polyline lengths in px; double ends count once. */
  edgeLength: number;
  meanEdgeLength: number;
  /** End-edge length divided by median entity width; zero without entities. */
  meanEdgeRatio: number;
  /** Node bounding-box area divided by canvas area. */
  density: number;
  longestEdgeRatio: number;
  /** Longest end edge drawn length / median entity width. */
  longEdgeMax: number;
  /** Mean end edge drawn length / median entity width. */
  longEdgeMean: number;
  issues: QualityIssue[];
}

export function assessQuality(diagram: Diagram, pins: Record<string, Point> = {}, model?: NModel): QualityReport {
  const issues: QualityIssue[] = [];
  const add = (kind: QualityIssue["kind"], ids: string[]) => issues.push({ kind, ids, message: `${kind}: ${ids.join(", ")}` });
  const { nodes, edges, labels } = diagram;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    for (const other of nodes.slice(i + 1)) if (shapesNear(n, other, 4)) add("overlap", [n.id, other.id]);
    if (pins[n.id] && distance(center(n.box), pins[n.id]!) > 0.5) add("pin-drift", [n.id]);
  }
  const paths = new Map(edges.map((e) => [e.id, drawnPaths(e)]));
  const labelContext = labelGeometry(nodes, edges, paths);
  const lines = new Map(edges.map((e) => [e.id, paths.get(e.id)!.flatMap(segments)]));
  for (const e of edges) for (const n of nodes) {
    if (n.id !== e.from && n.id !== e.to && lines.get(e.id)!.some(([a, b]) => segmentThrough(a, b, n))) add("shape-crossing", [e.id, n.id]);
  }
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!, shape = boxShape(l.box);
    const own = edges.find((e) => e.id === l.edge && e.kind === "end");
    if (own) {
      if (labelOnOwnEdge(l.box, own, labelContext)) add("label-on-own-edge", [l.id, own.id]);
      const loose = labelLooseReasons(l, own, labelContext, labels);
      if (loose.length) issues.push({ kind: "label-loose", ids: [l.id, own.id], message: `label-loose: ${l.id}: ${loose.join("; ")}` });
      const reasons = labelAmbiguityReasons(l.box, own, edges, labelContext);
      if (reasons.length) issues.push({ kind: "label-ambiguity", ids: [l.id, own.id], message: `label-ambiguity: ${l.id}: ${reasons.join("; ")}` });
    }
    for (const n of nodes) if (shapesOverlap(shape, n)) add("label-collision", [l.id, n.id]);
    for (const other of labels.slice(i + 1)) if (shapesOverlap(shape, boxShape(other.box))) add("label-collision", [l.id, other.id]);
    for (const e of edges) if (e.id !== l.edge && lines.get(e.id)!.some(([a, b]) => segmentThrough(a, b, shape))) add("label-collision", [l.id, e.id]);
  }
  for (let i = 0; i < edges.length; i++) for (const other of edges.slice(i + 1)) {
    const e = edges[i]!;
    const shared = nodes.filter((n) => [e.from, e.to].includes(n.id) && [other.from, other.to].includes(n.id));
    const crossing = lines.get(e.id)!.some(([a, b]) => lines.get(other.id)!.some(([c, d]) => {
      const hit = segmentIntersection(a, b, c, d);
      if (!hit) return false;
      if (hit === "overlap") return true;
      const endpoints = paths.get(e.id)!.flatMap((ps) => [ps[0]!, ps.at(-1)!]);
      const otherEndpoints = paths.get(other.id)!.flatMap((ps) => [ps[0]!, ps.at(-1)!]);
      if (endpoints.some((p) => distance(p, hit) < 1e-7) && otherEndpoints.some((p) => distance(p, hit) < 1e-7)) return false;
      return !shared.some((n) => pointInside(hit, n));
    }));
    if (crossing) add("edge-crossing", [e.id, other.id]);
  }
  const outside = (p: Point) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > diagram.width || p.y > diagram.height;
  for (const item of [...nodes, ...labels]) {
    const b = item.box;
    if (outside({ x: b.x, y: b.y }) || outside({ x: b.x + b.w, y: b.y + b.h })) add("out-of-canvas", [item.id]);
  }
  for (const e of edges) if (paths.get(e.id)!.some((ps) => ps.some(outside))) add("out-of-canvas", [e.id]);
  const count = (kind: QualityIssue["kind"]) => issues.filter((i) => i.kind === kind).length;
  const lengths = edges.filter((e) => e.kind === "end").map((e) => segments(e.points).reduce((sum, [a, b]) => sum + distance(a, b), 0));
  const widths = nodes.filter((n) => n.kind === "entity").map((n) => n.box.w).sort((a, b) => a - b);
  const middle = Math.floor(widths.length / 2);
  const median = widths.length ? (widths[middle]! + widths[Math.floor((widths.length - 1) / 2)]!) / 2 : 0;
  const edgeLength = lengths.reduce((sum, length) => sum + length, 0);
  const meanEdgeLength = lengths.length ? edgeLength / lengths.length : 0;
  const area = diagram.width * diagram.height;
  return { ...edgeQuality(diagram), ...clearanceQuality(diagram), ...semanticQuality(diagram, median, model), implemented: true, overlaps: count("overlap"), shapeCrossings: count("shape-crossing"), labelCollisions: count("label-collision"), labelAmbiguity: count("label-ambiguity"), labelLoose: count("label-loose"), labelOnOwnEdge: count("label-on-own-edge"), edgeCrossings: count("edge-crossing"), pinDrift: count("pin-drift"),
    aspect: diagram.height > 0 ? diagram.width / diagram.height : 0, edgeLength, meanEdgeLength,
    meanEdgeRatio: median > 0 ? meanEdgeLength / median : 0,
    longestEdgeRatio: median > 0 ? Math.max(0, ...lengths) / median : 0,
    longEdgeMax: median > 0 ? Math.max(0, ...lengths) / median : 0, longEdgeMean: median > 0 ? meanEdgeLength / median : 0,
    density: area > 0 ? nodes.reduce((sum, n) => sum + n.box.w * n.box.h, 0) / area : 0, issues };
}
