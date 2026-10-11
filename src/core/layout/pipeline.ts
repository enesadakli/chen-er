import { absolutePins, isRelativePin, pinPoint } from "../pins.js";
import { boxAround, center, intersects, type DEdge, type DLabel, type DNode, type LayoutEngine, type LayoutResult, type Pins, type Point } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import { assessQuality, type QualityReport } from "../quality.js";
import type { TextMetrics } from "../text/metrics.js";
import { alignDiamondPorts, fanEndAnchors, placeRecursive } from "./anchors.js";
import { attributeNode, placeAttributes, placeRadialAttributes } from "./attributes.js";
import { measureClusters, placeClusters, type Cluster } from "./clusters.js";
import { compactRows, layoutScore } from "./compact.js";
import { finalize } from "./finalize.js";
import { placeLabels } from "./labels.js";
import { clearPinnedSpokes, placeSemanticRecursive, placeSemantically, semanticPlacements } from "./semantic.js";
import { semanticAttributes, semanticRoute } from "./semantic-route.js";
import { hierarchyDag, hierarchyPairs, modelRelations } from "./semantic-graph.js";
import { endRouteMetrics, isZRoute, orthogonalPath } from "./semantic-edges.js";
import { repairAttributeSpokes, straightSpoke } from "./semantic-spokes.js";
import { routeEdge } from "./route.js";
import { distance } from "./shapes.js";
import { chooseSpacing, searchBudget } from "./semantic-spacing.js";

export function makeEngine(name: "simple" | "layered" | "stress"): LayoutEngine {
  return async (model, metrics, options) => {
    const pins = options.pins ?? {};
    const absolute = absolutePins(pins);
    const pinnedAttributes = measureClusters(model, metrics, absolute).flatMap((c) => flattenAttrs(c.attrs)).filter((a) => absolute[a.id]).map((a) => attributeNode(a, absolute[a.id]!, metrics, true));
    const clusters = measureClusters(model, metrics, absolute);
    let result: LayoutResult;
    const semanticBuild = (positions: Cluster[]) => buildDiagram(positions, pinnedAttributes, model, metrics, name, true, pins);
    // Entity cells depend only on topology; attribute clearance never selects a new skeleton.
    if (name !== "simple") {
      const placement = semanticPlacements(model)[0]!;
      const base = model.relationships.some((r) => r.ends.length > 1 && r.ends.every((e) => e.entity === r.ends[0]!.entity)) && model.entities.length > 1 ? 600 : 430;
      const reserved = pinnedAttributes.map((n) => n.box);
      const spacing = chooseSpacing(clusters, model, placement, base, reserved, pins, semanticBuild);
      placeSemantically(clusters, model, placement, spacing.spacing.columns, reserved, spacing.spacing.rows);
      result = refineClearance(clusters, semanticBuild, pins, model, spacing.initial);
      result = reduceZRoutes(clusters, semanticBuild, pins, model, result);
      const hierarchy = hierarchyDag(model.entities.map((e) => e.id), hierarchyPairs(modelRelations(model)));
      if (!Object.keys(pins).length && model.entities.length <= 4 && new Set(placement.columns.values()).size > 1 && hierarchy.pairs.length && !hierarchy.cyclic.size) {
        result = compactRows(result, clusters, placement.ranks, semanticBuild, model);
      }
    } else {
      await placeClusters(clusters, model, options, name, pinnedAttributes.map((n) => n.box));
      result = buildDiagram(clusters, pinnedAttributes, model, metrics, name, false, pins);
    }
    const quality = assessQuality(result.diagram, pins, model);
    const pinConflict = (issue: (typeof quality.issues)[number]) => issue.ids.some((id) => !!pins[id]) || (issue.kind === "out-of-canvas" && Object.keys(pins).length > 0);
    for (const issue of quality.issues) if (issue.kind !== "edge-crossing" && pinConflict(issue)) result.diagnostics.push({
      rule: "pin-conflict", severity: "warning", message: `Keeping exact pins causes ${issue.message}.`, hint: "Move the conflicting pin to free space inside the canvas.",
    });
    for (const issue of quality.issues) if (issue.kind !== "edge-crossing" && !pinConflict(issue)) result.diagnostics.push({
      rule: "layout-conflict", severity: "warning", message: issue.message, hint: "Allow more space around this node or adjust the layout pins.",
    });
    return result;
  };
}

function clearanceRouteScore(result: LayoutResult, id: string, dx: number, dy: number, model: NModel): number {
  const nodes = result.diagram.nodes.map((n) => ({ ...n, box: { ...n.box } }));
  const moved = new Set([id]);
  for (const e of result.diagram.edges.filter((e) => e.kind !== "end")) if (moved.has(e.from)) moved.add(e.to);
  for (const n of nodes) if (moved.has(n.id)) { n.box.x += dx; n.box.y += dy; }
  const edges = result.diagram.edges.map((e) => ({ ...e, points: [...e.points] }));
  const ports = fanEndAnchors(nodes, edges);
  const routed = edges.filter((e) => e.kind !== "end");
  const radial = result.diagram.meta.engine === "simple" || nodes.some((n) => n.pinned) || [...model.entities, ...model.relationships].some((owner) => owner.attrs.filter((a) => a.parts.length).length > 1);
  for (const e of routed) e.points = straightSpoke(e, nodes, radial);
  for (const e of edges.filter((e) => e.kind === "end")) {
    const points = semanticRoute(e, nodes, routed, ports.get(e.id));
    if (points) e.points = points;
    else if (e.from === id) return Infinity;
    routed.push(e);
  }
  const q = assessQuality({ ...result.diagram, nodes, edges, labels: [] }, {}, model);
  return q.shapeCrossings * 100 + q.edgeOverlap * 100 + q.overlaps * 100 + q.edgeCrossings * 16
    + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4 + Math.max(0, q.endBendsMax - 2) * 1000;
}

/** Only diamonds move during clearance refinement; entity ranks and cells stay fixed. */
function refineClearance(clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Pins, model: NModel, initial?: LayoutResult): LayoutResult {
  let best = initial ?? build(clusters);
  const score = (result: LayoutResult) => {
    const q = assessQuality(result.diagram, pins, model);
    return layoutScore(q) + q.edgeCrossings * 14 + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4 + Math.max(0, q.endBendsMax - 2) * 1000;
  };
  let value = score(best);
  const q = assessQuality(best.diagram, pins, model);
  const edges = new Map(best.diagram.edges.map((e) => [e.id, e]));
  const involved = new Set(q.issues.flatMap((i) => i.ids.map((id) => edges.get(id)?.from).filter((id): id is string => !!id)));
  for (const route of endRouteMetrics(best.diagram)) if (route.endBends > 2 || route.routeDetour > 1.35) involved.add(edges.get(route.id)!.from);
  const ranked = clusters.filter((c) => involved.has(c.node.id) && c.node.kind === "relationship" && !c.node.pinned).sort((a, b) => a.node.id.localeCompare(b.node.id));
  for (const c of ranked.slice(0, 6)) {
    const original = { ...c.node.box };
    let chosen = original;
    const proposals = [[-48, 0], [48, 0], [0, -48], [0, 48], [-96, 0], [96, 0], [0, -96], [0, 96]].map(([dx, dy]) => ({ dx: dx!, dy: dy!, score: clearanceRouteScore(best, c.node.id, dx!, dy!, model) }));
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


/** Rank moves on the skeleton; full builds validate attributes and labels after selection. */
function zRouteScore(result: LayoutResult, id: string, dx: number, dy: number, model: NModel): number {
  const nodes = result.diagram.nodes.filter((n) => n.kind !== "attribute").map((n) => ({ ...n, box: { ...n.box } }));
  for (const n of nodes) if (n.id === id) { n.box.x += dx; n.box.y += dy; }
  const edges = result.diagram.edges.filter((e) => e.kind === "end").map((e) => ({ ...e, points: [...e.points] }));
  const ports = fanEndAnchors(nodes, edges);
  const routed: DEdge[] = [];
  for (const e of edges) {
    const points = semanticRoute(e, nodes, routed, ports.get(e.id), [], 4);
    if (points) e.points = points;
    else return Infinity;
    routed.push(e);
  }
  const q = assessQuality({ ...result.diagram, nodes, edges, labels: [] }, {}, model);
  if (q.diagonalEnds) return Infinity;
  return q.zRoutes * 12 + q.shapeCrossings * 100 + q.edgeOverlap * 100 + q.overlaps * 100 + q.edgeCrossings * 16
    + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4 + Math.max(0, q.endBendsMax - 2) * 1000;
}

/** Bound Z refinement to three diamonds (fewer on large models) and two full builds each; entity cells stay fixed. */
function reduceZRoutes(clusters: Cluster[], build: (cs: Cluster[]) => LayoutResult, pins: Pins, model: NModel, initial?: LayoutResult): LayoutResult {
  let best = initial ?? build(clusters);
  const baseline = assessQuality(best.diagram, pins, model);
  const symmetric = model.relationships.filter((r) => r.ends.length === 2 && r.ends.every((e) => e.entity === r.ends[0]!.entity)).filter((r) => {
    const ends = best.diagram.edges.filter((e) => e.kind === "end" && e.from === r.id), p = center(best.diagram.nodes.find((n) => n.id === r.id)!.box);
    const a = ends[0]!.points.at(-1)!, b = ends[1]!.points.at(-1)!;
    return Math.abs(a.x - b.x) < 1e-6 ? Math.abs(a.y + b.y - p.y * 2) < 1e-6 : Math.abs(a.x + b.x - p.x * 2) < 1e-6;
  });
  const score = (result: LayoutResult, q: QualityReport) => {
    const ends = result.diagram.edges.filter((e) => e.kind === "end");
    for (const r of symmetric) {
      const pair = ends.filter((e) => e.from === r.id), p = center(result.diagram.nodes.find((n) => n.id === r.id)!.box);
      const a = pair[0]!.points.at(-1)!, b = pair[1]!.points.at(-1)!;
      if (Math.abs(a.x - b.x) < 1e-6 ? Math.abs(a.y + b.y - p.y * 2) > 1e-6 : Math.abs(a.x + b.x - p.x * 2) > 1e-6) return Infinity;
    }
    if (ends.some((e, i) => ends.slice(i + 1).some((other) => e.to === other.to && distance(e.points.at(-1)!, other.points.at(-1)!) < 28 - 1e-6))) return Infinity;
    if (q.endBendsMax > 2 || q.routeDetourMax > baseline.routeDetourMax + 1e-6 || q.longEdgeMax > (model.relationships.some((r) => r.ends.every((e) => e.entity === r.ends[0]!.entity)) ? 4 : 7) + 1e-6 || q.attributeSpokeMax > baseline.attributeSpokeMax + 1e-6 || q.spokeEdgeViolations || q.spokeLabelViolations || q.hierarchyViolations > baseline.hierarchyViolations || q.edgeCrossings > baseline.edgeCrossings || q.emptyAreaRatio > baseline.emptyAreaRatio + 1e-6) return Infinity;
    return layoutScore(q) + q.edgeCrossings * 14 + q.endBendsMax * 2 + q.endBendsMean * 2 + q.routeDetourMax * 4 + Math.max(0, q.endBendsMax - 2) * 1000;
  };
  let bestQuality = baseline;
  let value = score(best, baseline);
  const q = baseline;
  const edges = new Map(best.diagram.edges.map((e) => [e.id, e]));
  const involved = new Set(q.issues.flatMap((i) => i.ids.map((id) => edges.get(id)?.from).filter((id): id is string => !!id)));
  for (const route of endRouteMetrics(best.diagram)) if (route.endBends > 2 || route.routeDetour > 1.35 || isZRoute(edges.get(route.id)!.points) || !orthogonalPath(edges.get(route.id)!.points)) involved.add(edges.get(route.id)!.from);
  const priority = new Map<string, number>();
  for (const route of endRouteMetrics(best.diagram)) {
    const edge = edges.get(route.id)!;
    const weight = !orthogonalPath(edge.points) ? 1000 : route.endBends > 2 ? 100 : route.routeDetour > 1.35 ? 50 : isZRoute(edge.points) ? 1 : 0;
    priority.set(edge.from, (priority.get(edge.from) ?? 0) + weight);
  }
  const ranked = clusters.filter((c) => involved.has(c.node.id) && c.node.kind === "relationship" && !c.node.pinned)
    .sort((a, b) => (priority.get(b.node.id) ?? 0) - (priority.get(a.node.id) ?? 0) || a.node.id.localeCompare(b.node.id));
  for (const c of ranked.slice(0, searchBudget(3, model))) {
    const original = { ...c.node.box };
    let chosen = original;
    const endMoves = best.diagram.edges.filter((e) => e.from === c.node.id && e.kind === "end" && (isZRoute(e.points) || !orthogonalPath(e.points))).flatMap((e) => {
      const p = center(best.diagram.nodes.find((n) => n.id === c.node.id)!.box), port = e.points.at(-1)!;
      return [[port.x - p.x, 0], [0, port.y - p.y]];
    });
    const detours = endMoves.filter(([dx, dy]) => {
      const box = { ...c.node.box, x: c.node.box.x + dx!, y: c.node.box.y + dy! };
      return clusters.some((other) => other !== c && intersects(box, other.node.box, 18));
    }).flatMap(([dx, dy]) => dx ? [[dx, -64], [dx, 64], [dx, -96], [dx, 96]] : [[-64, dy], [64, dy], [-96, dy], [96, dy]]);
    const proposals = [...endMoves, ...detours, [-48, 0], [48, 0], [0, -48], [0, 48], [-96, 0], [96, 0], [0, -96], [0, 96], [-192, 0], [192, 0], [0, -192], [0, 192]].map(([dx, dy]) => ({ dx: dx!, dy: dy!, score: zRouteScore(best, c.node.id, dx!, dy!, model) }));
    proposals.sort((a, b) => a.score - b.score);
    const previousZ = bestQuality.zRoutes;
    for (const { dx, dy } of proposals.filter((p) => Number.isFinite(p.score)).slice(0, 2)) {
      c.node.box = { ...original, x: original.x + dx, y: original.y + dy };
      const result = build(clusters), quality = assessQuality(result.diagram, pins, model), next = score(result, quality);
      if (next < value - 1e-6) {
        best = result; bestQuality = quality; value = next; chosen = { ...c.node.box };
        if (quality.zRoutes < previousZ) break;
      }
    }
    c.node.box = chosen;
  }
  return best;
}

function buildDiagram(clusters: Cluster[], pinnedAttributes: DNode[], model: NModel, metrics: TextMetrics, name: string, semantic = false, pins: Pins = {}): LayoutResult {
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
  const relativeRoots = clusters.flatMap((c) => c.attrs.filter((a) => pins[a.id] && isRelativePin(pins[a.id]!)).map((a) => ({ attr: a, parent: c.node })));
  for (const { attr, parent } of relativeRoots) {
    const node = attributeNode(attr, pinPoint(pins[attr.id]!, center(parent.box)), metrics, true);
    nodes.push(node); byId.set(node.id, node);
  }
  const syncRoots = () => {
    for (const { attr, parent } of relativeRoots) {
      const node = byId.get(attr.id)!;
      node.box = boxAround(pinPoint(pins[attr.id]!, center(parent.box)), node.box.w, node.box.h);
    }
  };
  if (semantic) { clearPinnedSpokes(model, nodes); syncRoots(); }
  const edges: DEdge[] = [];
  for (const r of model.relationships) for (const end of r.ends) if (byId.has(`E:${end.entity}`)) edges.push({
    id: `edge:${end.id}`, kind: "end", from: r.id, to: `E:${end.entity}`, points: [], double: r.identifies === end.entity, end: end.id,
  });
  let endPorts = fanEndAnchors(nodes, edges, pins);
  if (semantic) {
    alignDiamondPorts(nodes, edges, endPorts);
    syncRoots();
    endPorts = fanEndAnchors(nodes, edges, pins);
  }
  const preliminary: DEdge[] = [];
  for (const e of edges) {
    e.points = semanticRoute(e, nodes, preliminary, endPorts.get(e.id)) ?? routeEdge(e, nodes, preliminary, 0, [], { endPort: endPorts.get(e.id) });
    preliminary.push(e);
  }
  let radialFan = !semantic || nodes.some((n) => n.pinned) || clusters.some((c) => c.attrs.filter((a) => a.parts.length).length > 1);
  if (!radialFan) radialFan = !placeAttributes(clusters, nodes, edges, metrics, endPorts, placeLabels(model, nodes, edges, metrics), pins);
  if (radialFan) {
    if (semantic) semanticAttributes(clusters, nodes, edges, metrics, endPorts);
    placeRadialAttributes(clusters, nodes, edges, metrics, endPorts, pins);
  }
  for (const n of nodes.filter((n) => n.kind === "attribute" && !n.pinned)) {
    const p = center(n.box);
    n.box = boxAround({ x: Math.round(p.x), y: Math.round(p.y) }, n.box.w, n.box.h);
  }
  // Free parent ovals have now been rounded; offsets stay exact against those final centres.
  for (const edge of edges.filter((e) => e.kind !== "end")) {
    const pin = pins[edge.to];
    if (pin && isRelativePin(pin)) {
      const node = byId.get(edge.to) ?? nodes.find((n) => n.id === edge.to)!;
      const parent = nodes.find((n) => n.id === edge.from)!;
      node.box = boxAround(pinPoint(pin, center(parent.box)), node.box.w, node.box.h);
    }
  }
  const ordered = [...edges.filter((e) => e.kind !== "end"), ...edges.filter((e) => e.kind === "end")];
  const routed: DEdge[] = [];
  const offsets = new Map<string, number>();
  for (const r of model.relationships) for (const end of r.ends) {
    const same = r.ends.filter((e) => e.entity === end.entity);
    if (same.length > 1) offsets.set(`edge:${end.id}`, (same.indexOf(end) - (same.length - 1) / 2) * 0.8);
  }
  for (const e of ordered) {
    if (e.kind !== "end") e.points = straightSpoke(e, nodes, radialFan);
    else e.points = semanticRoute(e, nodes, routed, endPorts.get(e.id)) ?? routeEdge(e, nodes, routed, offsets.get(e.id) ?? 0, [], { endPort: endPorts.get(e.id) });
    routed.push(e);
  }
  repairAttributeSpokes(nodes, edges, endPorts, [], !radialFan, pins);
  let labels: DLabel[] = [];
  for (let pass = 0; pass < 4; pass++) {
    labels = placeLabels(model, nodes, edges, metrics);
    if (repairAttributeSpokes(nodes, edges, endPorts, labels, !radialFan, pins)) labels = placeLabels(model, nodes, edges, metrics);
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
