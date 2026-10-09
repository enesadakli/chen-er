import type { Diagram } from "../geometry.js";
import type { NModel } from "../normalize.js";

export interface SemanticEnd { entity: string; max: number | "N"; weak: boolean }
export interface SemanticRelation { id: string; ends: SemanticEnd[] }
export interface HierarchyPair { parent: string; child: string }

export function modelRelations(model: NModel): SemanticRelation[] {
  return model.relationships.map((r) => ({ id: r.id, ends: r.ends.map((e) => ({ entity: `E:${e.entity}`, max: e.max, weak: r.identifies === e.entity })) }));
}

/** Cardinality labels preserve the model semantics for diagram-only callers. */
export function semanticRelations(diagram: Diagram, model?: NModel): SemanticRelation[] {
  if (model) return modelRelations(model);
  return diagram.nodes.filter((n) => n.kind === "relationship").map((r) => ({
    id: r.id,
    ends: diagram.edges.filter((e) => e.kind === "end" && e.from === r.id).map((e) => {
      const card = diagram.labels.find((l) => l.kind === "cardinality" && l.edge === e.id)?.text.match(/^\(\d+,\s*(\d+|N)\)$/);
      return { entity: e.to, max: card?.[1] === "N" || !card ? "N" : Number(card[1]), weak: e.double };
    }),
  }));
}

export function hierarchyPairs(relations: SemanticRelation[]): HierarchyPair[] {
  const pairs = new Map<string, HierarchyPair>();
  const add = (parent: string, child: string) => {
    if (parent !== child) pairs.set(`${parent}\0${child}`, { parent, child });
  };
  for (const r of relations) {
    for (const child of r.ends.filter((e) => e.weak)) for (const owner of r.ends.filter((e) => !e.weak)) add(owner.entity, child.entity);
    if (r.ends.length !== 2) continue;
    for (const child of r.ends) for (const parent of r.ends) if (child.max === 1 && parent.max === "N") add(parent.entity, child.entity);
  }
  return [...pairs.values()].sort((a, b) => a.parent.localeCompare(b.parent) || a.child.localeCompare(b.child));
}

/** Reverse lexical insertion drops only edges which would close a directed cycle. */
export function hierarchyDag(ids: string[], pairs: HierarchyPair[]): { ranks: Map<string, number>; pairs: HierarchyPair[]; cyclic: Map<string, string> } {
  const adjacent = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const { parent, child } of pairs) adjacent.get(parent)?.add(child);
  const reachable = (from: string, to: string, graph = adjacent): boolean => {
    const seen = new Set<string>(), stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(graph.get(id) ?? []));
    }
    return false;
  };
  const cyclic = new Map<string, string>();
  for (const id of ids) {
    const component = ids.filter((other) => reachable(id, other) && reachable(other, id)).sort();
    if (component.length > 1) cyclic.set(id, component[0]!);
  }
  const dag = new Map(ids.map((id) => [id, new Set<string>()])), accepted: HierarchyPair[] = [];
  for (const p of [...pairs].sort((a, b) => b.parent.localeCompare(a.parent) || b.child.localeCompare(a.child))) if (dag.has(p.parent) && dag.has(p.child) && !reachable(p.child, p.parent, dag)) {
    dag.get(p.parent)!.add(p.child);
    accepted.push(p);
  }
  const ranks = new Map(ids.map((id) => [id, 0]));
  const incoming = new Map(ids.map((id) => [id, accepted.filter((p) => p.child === id).length]));
  const queue = ids.filter((id) => !incoming.get(id)).sort();
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of dag.get(id)!) {
      ranks.set(child, Math.max(ranks.get(child)!, ranks.get(id)! + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (!incoming.get(child)) { queue.push(child); queue.sort(); }
    }
  }
  return { ranks, pairs: accepted, cyclic };
}
