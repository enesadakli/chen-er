import type { DEdge, DLabel, LayoutEngine } from "../geometry.js";
import { flattenAttrs } from "../normalize.js";
import { assessQuality } from "../quality.js";
import { attributeNode, placeAttributes } from "./attributes.js";
import { measureClusters, placeClusters } from "./clusters.js";
import { finalize } from "./finalize.js";
import { placeLabels } from "./labels.js";
import { routeEdge } from "./route.js";

export function makeEngine(name: "simple" | "layered" | "stress"): LayoutEngine {
  return async (model, metrics, options) => {
    const pins = options.pins ?? {};
    const clusters = measureClusters(model, metrics, pins);
    const pinnedAttributes = clusters.flatMap((c) => flattenAttrs(c.attrs)).filter((a) => pins[a.id]).map((a) => attributeNode(a, pins[a.id]!, metrics, true));
    await placeClusters(clusters, model, options, name, pinnedAttributes.map((n) => n.box));
    const nodes = clusters.map((c) => c.node);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Reserve all pinned attributes before placing any movable attribute.
    for (const n of pinnedAttributes) {
      nodes.push(n);
      byId.set(n.id, n);
    }
    const edges: DEdge[] = [];
    for (const r of model.relationships) for (const end of r.ends) if (byId.has(`E:${end.entity}`)) edges.push({
      id: `edge:${end.id}`, kind: "end", from: r.id, to: `E:${end.entity}`, points: [], double: r.identifies === end.entity, end: end.id,
    });
    placeAttributes(clusters, nodes, edges, metrics);
    // Route short attribute trees first, then the relationship ends around them.
    const ordered = [...edges.filter((e) => e.kind !== "end"), ...edges.filter((e) => e.kind === "end")];
    const routed: DEdge[] = [];
    const offsets = new Map<string, number>();
    for (const r of model.relationships) for (const end of r.ends) {
      const same = r.ends.filter((e) => e.entity === end.entity);
      if (same.length > 1) offsets.set(`edge:${end.id}`, (same.indexOf(end) - (same.length - 1) / 2) * 0.8);
    }
    for (const e of ordered) {
      e.points = routeEdge(e, nodes, routed, offsets.get(e.id) ?? 0);
      routed.push(e);
    }
    let labels: DLabel[] = [];
    for (let pass = 0; pass < 4; pass++) {
      labels = placeLabels(model, nodes, edges, metrics);
      const result = assessQuality({ width: Infinity, height: Infinity, nodes, edges, labels, notes: [], meta: { engine: name } });
      if ((!result.shapeCrossings && !result.labelCollisions && !result.overlaps) || pass === 3) break;
      for (const e of edges) {
        if (result.issues.some((i) => (i.kind === "shape-crossing" || i.kind === "label-collision") && i.ids.includes(e.id))) {
          e.points = routeEdge(e, nodes, edges.filter((other) => other !== e), offsets.get(e.id) ?? 0, labels.filter((l) => l.edge !== e.id).map((l) => l.box));
        }
      }
    }
    const result = finalize({ nodes, edges, labels, title: model.title, notes: model.notes, engine: name });
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
