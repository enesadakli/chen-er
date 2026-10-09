import { boxAround, center, type DEdge, type DLabel, type DNode, type LayoutEngine, type LayoutResult } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import { assessQuality, type QualityReport } from "../quality.js";
import type { TextMetrics } from "../text/metrics.js";
import { fanEndAnchors, placeRecursive } from "./anchors.js";
import { attributeNode, placeAttributes } from "./attributes.js";
import { measureClusters, placeClusters, type Cluster, type Placement } from "./clusters.js";
import { compactCandidates, compactLocally, layoutScore } from "./compact.js";
import { finalize } from "./finalize.js";
import { placeLabels } from "./labels.js";
import { placeSemanticRecursive, placeSemantically, recenterPinnedDiamonds, semanticPlacements } from "./semantic.js";
import { hierarchyDag, hierarchyPairs, modelRelations } from "./semantic-graph.js";
import { semanticAttributes, semanticRoute } from "./semantic-route.js";
import { repairAttributeSpokes, straightSpoke } from "./semantic-spokes.js";
import { routeEdge } from "./route.js";

type Candidate = Placement & { engine: "simple" | "layered" | "stress"; seed?: number };

export function makeEngine(name: "simple" | "layered" | "stress"): LayoutEngine {
  return async (model, metrics, options) => {
    const pins = options.pins ?? {};
    const pinnedAttributes = measureClusters(model, metrics, pins).flatMap((c) => flattenAttrs(c.attrs)).filter((a) => pins[a.id]).map((a) => attributeNode(a, pins[a.id]!, metrics, true));
    const candidates: Candidate[] = name === "simple" ? [{ engine: name }] : [
      { engine: "layered", direction: "RIGHT" },
      { engine: "layered", direction: "DOWN" },
      ...[0, 1, 2].map((seed) => ({ engine: "stress" as const, seed: (options.seed ?? 1) + seed, edgeLength: 440, compact: true })),
    ];
    let best: LayoutResult | undefined, score = Infinity, semanticBest = false;
    const build = (positions: Cluster[]) => buildDiagram(positions, pinnedAttributes, model, metrics, name);
    const cycles = new Set(hierarchyDag(model.entities.map((e) => e.id), hierarchyPairs(modelRelations(model))).cyclic.values()).size;
    // Stop the bounded semantic search once the page and clearance targets hold.
    // Cyclic components each require at least one hierarchy violation.
    const sufficient = (q: QualityReport) => Number.isFinite(layoutScore(q)) && q.hierarchyViolations <= cycles && q.diamondOffset <= 0.15
      && q.axisAligned >= 0.6 && q.edgeCrossings <= 4 && q.aspect >= 0.6 && q.aspect <= 1.8 && q.meanEdgeRatio <= 3.5 && q.longestEdgeRatio <= 7;
    const semanticBuild = (positions: Cluster[]) => buildDiagram(positions, pinnedAttributes, model, metrics, name, true);
    if (name !== "simple") for (const placement of semanticPlacements(model).slice(0, 3)) {
      const clusters = measureClusters(model, metrics, pins);
      placeSemantically(clusters, model, placement);
      for (const result of compactCandidates(clusters, semanticBuild, pins, model)) {
        const value = layoutScore(assessQuality(result.diagram, pins, model));
        if (!best || value < score) { best = result; score = value; semanticBest = true; }
      }
      if (best && sufficient(assessQuality(best.diagram, pins, model))) break;
    }
    const acceptedSemantic = best && sufficient(assessQuality(best.diagram, pins, model));
    for (const candidate of acceptedSemantic ? [] : candidates) {
      const clusters = measureClusters(model, metrics, pins);
      await placeClusters(clusters, model, { ...options, seed: candidate.seed ?? options.seed }, candidate.engine, pinnedAttributes.map((n) => n.box), candidate);
      for (const result of name === "simple" ? [build(clusters)] : compactCandidates(clusters, build, pins, model)) {
        const value = layoutScore(assessQuality(result.diagram, pins, model));
        if (!best || value < score) { best = result; score = value; semanticBest = false; }
      }
    }
    const result = name === "simple" || semanticBest ? best! : compactLocally(best!, measureClusters(model, metrics, pins), (cs) => buildDiagram(cs, pinnedAttributes, model, metrics, name), pins, model);
    const quality = assessQuality(result.diagram, pins, model);
    const pinConflict = (issue: (typeof quality.issues)[number]) => issue.ids.some((id) => !!pins[id]) || (issue.kind === "out-of-canvas" && Object.keys(pins).length > 0);
    for (const issue of quality.issues) if (issue.kind !== "edge-crossing" && pinConflict(issue)) result.diagnostics.push({
      rule: "pin-conflict", severity: "info", message: `Keeping exact pins causes ${issue.message}.`, hint: "Move the conflicting pin to free space inside the canvas.",
    });
    for (const issue of quality.issues) if (issue.kind !== "edge-crossing" && !pinConflict(issue)) result.diagnostics.push({
      rule: "layout-conflict", severity: "info", message: issue.message, hint: "Allow more space around this node or adjust the layout pins.",
    });
    return result;
  };
}

function buildDiagram(clusters: Cluster[], pinnedAttributes: DNode[], model: NModel, metrics: TextMetrics, name: string, semantic = false): LayoutResult {
  clusters = clusters.map((c) => ({ ...c, node: { ...c.node, box: { ...c.node.box } } }));
  if (semantic && clusters.some((c) => c.node.pinned)) recenterPinnedDiamonds(clusters, model);
  for (const c of clusters) if (!c.node.pinned) {
    const p = center(c.node.box);
    c.node.box = boxAround({ x: Math.round(p.x), y: Math.round(p.y) }, c.node.box.w, c.node.box.h);
  }
  const nodes = clusters.map((c) => c.node);
  placeRecursive(model, nodes);
  if (semantic) placeSemanticRecursive(model, nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const original of pinnedAttributes) {
    const n = { ...original, box: { ...original.box } };
    nodes.push(n);
    byId.set(n.id, n);
  }
  const edges: DEdge[] = [];
  for (const r of model.relationships) for (const end of r.ends) if (byId.has(`E:${end.entity}`)) edges.push({
    id: `edge:${end.id}`, kind: "end", from: r.id, to: `E:${end.entity}`, points: [], double: r.identifies === end.entity, end: end.id,
  });
  const endPorts = fanEndAnchors(nodes, edges);
  for (const e of edges) e.points = (semantic ? semanticRoute(e, nodes, [], endPorts.get(e.id)) : undefined) ?? routeEdge(e, nodes, [], 0, [], { endPort: endPorts.get(e.id) });
  if (semantic) semanticAttributes(clusters, nodes, edges, metrics, endPorts);
  placeAttributes(clusters, nodes, edges, metrics, endPorts);
  for (const n of nodes.filter((n) => n.kind === "attribute" && !n.pinned)) {
    const p = center(n.box);
    n.box = boxAround({ x: Math.round(p.x), y: Math.round(p.y) }, n.box.w, n.box.h);
  }
  const ordered = [...edges.filter((e) => e.kind !== "end"), ...edges.filter((e) => e.kind === "end")];
  const routed: DEdge[] = [];
  const offsets = new Map<string, number>();
  for (const r of model.relationships) for (const end of r.ends) {
    const same = r.ends.filter((e) => e.entity === end.entity);
    if (same.length > 1) offsets.set(`edge:${end.id}`, (same.indexOf(end) - (same.length - 1) / 2) * 0.8);
  }
  for (const e of ordered) {
    if (e.kind !== "end") e.points = straightSpoke(e, nodes);
    else e.points = semanticRoute(e, nodes, routed, endPorts.get(e.id)) ?? routeEdge(e, nodes, routed, offsets.get(e.id) ?? 0, [], { endPort: endPorts.get(e.id) });
    routed.push(e);
  }
  repairAttributeSpokes(nodes, edges, endPorts);
  let labels: DLabel[] = [];
  for (let pass = 0; pass < 4; pass++) {
    labels = placeLabels(model, nodes, edges, metrics);
    if (repairAttributeSpokes(nodes, edges, endPorts, labels)) labels = placeLabels(model, nodes, edges, metrics);
    const result = assessQuality({ width: Infinity, height: Infinity, nodes, edges, labels, notes: [], meta: { engine: name } });
    if ((!result.shapeCrossings && !result.labelCollisions && !result.labelAmbiguity && !result.overlaps) || pass === 3) break;
    for (const e of edges) {
      if (e.kind === "end" && result.issues.some((i) => (i.kind === "shape-crossing" || i.kind === "label-collision" || i.kind === "label-ambiguity") && (i.ids.includes(e.id) || labels.some((l) => l.edge === e.id && i.ids.includes(l.id))))) {
        const reserved = labels.filter((l) => l.edge !== e.id && edges.find((other) => other.id === l.edge)?.to !== e.to).map((l) => l.box);
        e.points = semanticRoute(e, nodes, edges.filter((other) => other !== e), endPorts.get(e.id), reserved) ?? routeEdge(e, nodes, edges.filter((other) => other !== e), offsets.get(e.id) ?? 0, reserved, { endPort: endPorts.get(e.id), forceBend: !offsets.has(e.id) });
      }
    }
  }
  return finalize({ nodes, edges, labels, title: model.title, notes: model.notes, engine: name });
}
