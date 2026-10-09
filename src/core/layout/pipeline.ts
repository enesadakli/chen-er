import { boxAround, center, type DEdge, type DLabel, type DNode, type LayoutEngine, type LayoutResult, type Point } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import { assessQuality } from "../quality.js";
import type { TextMetrics } from "../text/metrics.js";
import { fanEndAnchors, placeRecursive } from "./anchors.js";
import { attributeNode, placeAttributes } from "./attributes.js";
import { measureClusters, placeClusters, type Cluster } from "./clusters.js";
import { layoutScore } from "./compact.js";
import { finalize } from "./finalize.js";
import { placeLabels } from "./labels.js";
import { clearPinnedSpokes, placeSemanticRecursive, placeSemantically, semanticPlacements } from "./semantic.js";
import { semanticAttributes, semanticRoute } from "./semantic-route.js";
import { repairAttributeSpokes, straightSpoke } from "./semantic-spokes.js";
import { routeEdge } from "./route.js";

export function makeEngine(name: "simple" | "layered" | "stress"): LayoutEngine {
  return async (model, metrics, options) => {
    const pins = options.pins ?? {};
    const pinnedAttributes = measureClusters(model, metrics, pins).flatMap((c) => flattenAttrs(c.attrs)).filter((a) => pins[a.id]).map((a) => attributeNode(a, pins[a.id]!, metrics, true));
    const clusters = measureClusters(model, metrics, pins);
    let result: LayoutResult;
    const semanticBuild = (positions: Cluster[]) => buildDiagram(positions, pinnedAttributes, model, metrics, name, true);
    // Entity cells depend only on topology; attribute clearance never selects a new skeleton.
    if (name !== "simple") {
      const placement = semanticPlacements(model)[0]!;
      placeSemantically(clusters, model, placement, 430, pinnedAttributes.map((n) => n.box));
      result = refineDiamonds(clusters, semanticBuild, pins, model);
    } else {
      await placeClusters(clusters, model, options, name, pinnedAttributes.map((n) => n.box));
      result = buildDiagram(clusters, pinnedAttributes, model, metrics, name);
    }
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

function diamondRouteScore(result: LayoutResult, id: string, dx: number, dy: number, model: NModel): number {
  const nodes = result.diagram.nodes.map((n) => ({ ...n, box: { ...n.box } }));
  const moved = new Set([id]);
  for (const e of result.diagram.edges.filter((e) => e.kind !== "end")) if (moved.has(e.from)) moved.add(e.to);
  for (const n of nodes) if (moved.has(n.id)) { n.box.x += dx; n.box.y += dy; }
  const edges = result.diagram.edges.map((e) => ({ ...e, points: [...e.points] }));
  const ports = fanEndAnchors(nodes, edges);
  const routed = edges.filter((e) => e.kind !== "end");
  for (const e of routed) e.points = straightSpoke(e, nodes);
  for (const e of edges.filter((e) => e.kind === "end")) {
    const points = semanticRoute(e, nodes, routed, ports.get(e.id));
    if (points) e.points = points;
    else if (e.from === id) return Infinity;
    routed.push(e);
  }
  const q = assessQuality({ ...result.diagram, nodes, edges, labels: [] }, {}, model);
  return q.shapeCrossings * 100 + q.edgeOverlap * 100 + q.overlaps * 100 + q.edgeCrossings * 16
    + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4;
}

/** Only diamonds move during clearance refinement; entity ranks and cells stay fixed. */
function refineDiamonds(clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Record<string, Point>, model: NModel): LayoutResult {
  let best = build(clusters);
  // Keep the separate lanes of cyclic hierarchies intact.
  if (assessQuality(best.diagram, pins, model).hierarchyViolations) return best;
  const score = (result: LayoutResult) => {
    const q = assessQuality(result.diagram, pins, model);
    return layoutScore(q) + q.edgeCrossings * 14 + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4;
  };
  let value = score(best);
  const q = assessQuality(best.diagram, pins, model);
  const edges = new Map(best.diagram.edges.map((e) => [e.id, e]));
  const involved = new Set(q.issues.flatMap((i) => i.ids.map((id) => edges.get(id)?.from).filter((id): id is string => !!id)));
  for (const e of best.diagram.edges.filter((e) => e.kind === "end" && e.points.length > 4)) involved.add(e.from);
  const ranked = clusters.filter((c) => involved.has(c.node.id) && c.node.kind === "relationship" && !c.node.pinned).sort((a, b) => a.node.id.localeCompare(b.node.id));
  for (const c of ranked.slice(0, 6)) {
    const original = { ...c.node.box };
    let chosen = original;
    const proposals = [[-48, 0], [48, 0], [0, -48], [0, 48], [-96, 0], [96, 0], [0, -96], [0, 96]].map(([dx, dy]) => ({ dx: dx!, dy: dy!, score: diamondRouteScore(best, c.node.id, dx!, dy!, model) }));
    proposals.sort((a, b) => a.score - b.score);
    for (const { dx, dy } of proposals.slice(0, 1)) {
      c.node.box = { ...original, x: original.x + dx, y: original.y + dy };
      const result = build(clusters), next = score(result);
      if (next < value - 1e-6) { best = result; value = next; chosen = { ...c.node.box }; }
    }
    c.node.box = chosen;
  }
  return best;
}

function buildDiagram(clusters: Cluster[], pinnedAttributes: DNode[], model: NModel, metrics: TextMetrics, name: string, semantic = false): LayoutResult {
  clusters = clusters.map((c) => ({ ...c, node: { ...c.node, box: { ...c.node.box } } }));
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
  if (semantic) clearPinnedSpokes(model, nodes);
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
    if ((!result.shapeCrossings && !result.labelCollisions && !result.labelAmbiguity && !result.labelLoose && !result.overlaps) || pass === 3) break;
    for (const e of edges) {
      if (e.kind === "end" && result.issues.some((i) => (i.kind === "shape-crossing" || i.kind === "label-collision" || i.kind === "label-ambiguity" || i.kind === "label-loose") && (i.ids.includes(e.id) || labels.some((l) => l.edge === e.id && i.ids.includes(l.id))))) {
        const reserved = labels.filter((l) => l.edge !== e.id && edges.find((other) => other.id === l.edge)?.to !== e.to).map((l) => l.box);
        e.points = semanticRoute(e, nodes, edges.filter((other) => other !== e), endPorts.get(e.id), reserved) ?? routeEdge(e, nodes, edges.filter((other) => other !== e), offsets.get(e.id) ?? 0, reserved, { endPort: endPorts.get(e.id), forceBend: !offsets.has(e.id) });
      }
    }
  }
  return finalize({ nodes, edges, labels, title: model.title, notes: model.notes, engine: name });
}
