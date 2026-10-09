import type { DEdge, DLabel, DNode, LayoutEngine, LayoutResult } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import { assessQuality } from "../quality.js";
import type { TextMetrics } from "../text/metrics.js";
import { fanEndAnchors, placeRecursive } from "./anchors.js";
import { attributeNode, placeAttributes } from "./attributes.js";
import { measureClusters, placeClusters, type Cluster, type Placement } from "./clusters.js";
import { compactCandidates, compactLocally, layoutScore } from "./compact.js";
import { finalize } from "./finalize.js";
import { placeLabels } from "./labels.js";
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
    let best: LayoutResult | undefined, score = Infinity;
    for (const candidate of candidates) {
      const clusters = measureClusters(model, metrics, pins);
      await placeClusters(clusters, model, { ...options, seed: candidate.seed ?? options.seed }, candidate.engine, pinnedAttributes.map((n) => n.box), candidate);
      const build = (positions: Cluster[]) => buildDiagram(positions, pinnedAttributes, model, metrics, name);
      for (const result of name === "simple" ? [build(clusters)] : compactCandidates(clusters, build, pins)) {
        const value = layoutScore(assessQuality(result.diagram, pins));
        if (!best || value < score) { best = result; score = value; }
      }
    }
    const result = name === "simple" ? best! : compactLocally(best!, measureClusters(model, metrics, pins), (cs) => buildDiagram(cs, pinnedAttributes, model, metrics, name), pins);
    const quality = assessQuality(result.diagram, pins);
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

function buildDiagram(clusters: Cluster[], pinnedAttributes: DNode[], model: NModel, metrics: TextMetrics, name: string): LayoutResult {
  clusters = clusters.map((c) => ({ ...c, node: { ...c.node, box: { ...c.node.box } } }));
  const nodes = clusters.map((c) => c.node);
  placeRecursive(model, nodes);
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
  for (const e of edges) e.points = routeEdge(e, nodes, [], 0, [], { endPort: endPorts.get(e.id) });
  placeAttributes(clusters, nodes, edges, metrics, endPorts);
  const reservedAnchors = (e: DEdge) => e.kind === "attribute" ? edges.filter((other) => other.kind === "end" && other.to === e.from).map((other) => endPorts.get(other.id)!.anchor) : [];
  const ordered = [...edges.filter((e) => e.kind !== "end"), ...edges.filter((e) => e.kind === "end")];
  const routed: DEdge[] = [];
  const offsets = new Map<string, number>();
  for (const r of model.relationships) for (const end of r.ends) {
    const same = r.ends.filter((e) => e.entity === end.entity);
    if (same.length > 1) offsets.set(`edge:${end.id}`, (same.indexOf(end) - (same.length - 1) / 2) * 0.8);
  }
  for (const e of ordered) {
    e.points = routeEdge(e, nodes, routed, offsets.get(e.id) ?? 0, [], { endPort: endPorts.get(e.id), reservedAnchors: reservedAnchors(e) });
    routed.push(e);
  }
  let labels: DLabel[] = [];
  for (let pass = 0; pass < 4; pass++) {
    labels = placeLabels(model, nodes, edges, metrics);
    const result = assessQuality({ width: Infinity, height: Infinity, nodes, edges, labels, notes: [], meta: { engine: name } });
    if ((!result.shapeCrossings && !result.labelCollisions && !result.labelAmbiguity && !result.overlaps) || pass === 3) break;
    for (const e of edges) {
      if (result.issues.some((i) => (i.kind === "shape-crossing" || i.kind === "label-collision" || i.kind === "label-ambiguity") && (i.ids.includes(e.id) || labels.some((l) => l.edge === e.id && i.ids.includes(l.id))))) {
        const reserved = labels.filter((l) => l.edge !== e.id && edges.find((other) => other.id === l.edge)?.to !== e.to).map((l) => l.box);
        e.points = routeEdge(e, nodes, edges.filter((other) => other !== e), offsets.get(e.id) ?? 0, reserved, { endPort: endPorts.get(e.id), forceBend: !offsets.has(e.id), reservedAnchors: reservedAnchors(e) });
      }
    }
  }
  return finalize({ nodes, edges, labels, title: model.title, notes: model.notes, engine: name });
}
