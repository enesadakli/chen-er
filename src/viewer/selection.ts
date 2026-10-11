import type { Box, Diagram } from "../core/geometry.js";
import type { NModel } from "../core/normalize.js";

export interface SelectionMetadata {
  owners: { id: string; name: string; label: string; kind: "entity" | "relationship" }[];
  relationships: { id: string; entityIds: string[]; endIds: string[] }[];
}
export function selectionMetadata(model?: NModel): SelectionMetadata {
  return {
    owners: model ? [...model.entities.map((o) => ({ id: o.id, name: o.name, label: o.label, kind: "entity" as const })),
      ...model.relationships.map((o) => ({ id: o.id, name: o.name, label: o.label, kind: "relationship" as const }))] : [],
    relationships: model?.relationships.map((r) => ({ id: r.id, entityIds: r.ends.map((e) => `E:${e.entity}`), endIds: r.ends.map((e) => e.id) })) ?? [],
  };
}
/** Include every end of a touched relationship, including both recursive ends and all n-ary ends. */
export function selectionNeighborhood(diagram: Diagram, ownerId: string): { nodeIds: string[]; edgeIds: string[]; labelIds: string[]; box?: Box } {
  const nodes = new Set<string>([ownerId]);
  const relationships = new Set(diagram.edges.filter((e) => e.kind === "end" && (e.from === ownerId || e.to === ownerId)).map((e) => e.from));
  if (ownerId.startsWith("R:")) relationships.add(ownerId);
  const edges = new Set<string>();
  for (const e of diagram.edges) if (e.kind === "end" && relationships.has(e.from)) { edges.add(e.id); nodes.add(e.from); nodes.add(e.to); }
  // Attributes describe the selected owner. Walk composite parts without pulling in the attributes of peers.
  const attrParents = new Set<string>([ownerId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of diagram.edges) if (e.kind !== "end" && attrParents.has(e.from) && !edges.has(e.id)) {
      edges.add(e.id); nodes.add(e.to); attrParents.add(e.to); changed = true;
    }
  }
  const labels = diagram.labels.filter((l) => edges.has(l.edge));
  const boxes = [...diagram.nodes.filter((n) => nodes.has(n.id)).map((n) => n.box), ...labels.map((l) => l.box)];
  for (const e of diagram.edges) if (edges.has(e.id)) for (const p of e.points) boxes.push({ x: p.x, y: p.y, w: 0, h: 0 });
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  const box = boxes.length ? { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y } : undefined;
  return { nodeIds: [...nodes], edgeIds: [...edges], labelIds: labels.map((l) => l.id), box };
}
