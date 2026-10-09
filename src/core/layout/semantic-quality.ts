import { center, type Diagram } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { distance, segments } from "./shapes.js";
import { hierarchyDag, hierarchyPairs, semanticRelations } from "./semantic-graph.js";

export interface SemanticQuality {
  hierarchyViolations: number;
  /** Mean centroid offset / mean distance between distinct participating entities. */
  diamondOffset: number;
  /** Shared-relationship-weighted entity distance / median entity width. */
  relatedDistance: number;
  /** Weighted share of related/unrelated pair comparisons with an inversion. */
  proximityInversions: number;
  /** Share of end polylines with every nonzero segment within 12 degrees of an axis. */
  axisAligned: number;
  /** Degree-weighted radial entity distance / entity drawing diagonal. */
  centralityOffset: number;
  /** Share of entities without another entity on either their row or column (2px tolerance). */
  gridMisalignment: number;
  /** Share of attributes facing the entity drawing center rather than outward. */
  attributeInwardRatio: number;
}

export function semanticQuality(diagram: Diagram, medianWidth: number, model?: NModel): SemanticQuality {
  const entities = diagram.nodes.filter((n) => n.kind === "entity");
  const byId = new Map(diagram.nodes.map((n) => [n.id, center(n.box)]));
  const relations = semanticRelations(diagram, model);
  const pairs = hierarchyPairs(relations);
  const { cyclic } = hierarchyDag(entities.map((n) => n.id), pairs);
  let hierarchyViolations = 0;
  const countedCycles = new Set<string>();
  for (const { parent, child } of pairs) {
    const p = byId.get(parent), c = byId.get(child);
    if (!p || !c || p.y < c.y - 20 || (Math.abs(p.y - c.y) <= 20 && p.x < c.x - 20)) continue;
    const component = cyclic.get(parent) === cyclic.get(child) ? cyclic.get(parent) : undefined;
    if (component && countedCycles.has(component)) continue;
    hierarchyViolations++;
    if (component) countedCycles.add(component);
  }
  const related = new Map<string, number>(), degrees = new Map(entities.map((n) => [n.id, 0]));
  const offsets: number[] = [];
  for (const r of relations) {
    const ids = [...new Set(r.ends.map((e) => e.entity))].filter((id) => byId.has(id)).sort();
    for (const id of ids) degrees.set(id, (degrees.get(id) ?? 0) + 1);
    const points = ids.map((id) => byId.get(id)!);
    let span = 0, count = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}\0${ids[j]}`;
      related.set(key, (related.get(key) ?? 0) + 1);
      span += distance(points[i]!, points[j]!);
      count++;
    }
    const diamond = byId.get(r.id);
    // Recursive relationships have no inter-entity span and are excluded.
    if (diamond && count && span > 0) {
      const centroid = { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
      offsets.push(distance(diamond, centroid) / (span / count));
    }
  }
  const distances: { length: number; weight: number }[] = [];
  const unrelated: number[] = [];
  for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) {
    const a = entities[i]!, b = entities[j]!;
    const key = [a.id, b.id].sort().join("\0"), length = distance(byId.get(a.id)!, byId.get(b.id)!);
    const weight = related.get(key) ?? 0;
    if (weight) distances.push({ length, weight });
    else unrelated.push(length);
  }
  const weight = distances.reduce((sum, p) => sum + p.weight, 0);
  const inversions = distances.reduce((sum, p) => sum + p.weight * unrelated.filter((d) => p.length > d).length, 0);
  const ends = diagram.edges.filter((e) => e.kind === "end");
  const tolerance = Math.tan(12 * Math.PI / 180);
  const aligned = ends.filter((e) => {
    const lines = segments(e.points).filter(([a, b]) => distance(a, b) > 1e-7);
    return lines.length && lines.every(([a, b]) => Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * tolerance + 1e-7);
  }).length;
  const points = entities.map((e) => byId.get(e.id)!);
  const maxX = points.length ? Math.max(...points.map((p) => p.x)) : 0;
  // Use only the entity extent so translation and attribute fans do not affect centrality.
  const loX = points.length ? Math.min(...points.map((p) => p.x)) : 0;
  const loY = points.length ? Math.min(...points.map((p) => p.y)) : 0;
  const hiY = points.length ? Math.max(...points.map((p) => p.y)) : 0;
  const drawingCenter = { x: (loX + maxX) / 2, y: (loY + hiY) / 2 };
  const diagonal = Math.hypot(maxX - loX, hiY - loY);
  const degree = [...degrees.values()].reduce((s, d) => s + d, 0);
  const attrs = diagram.edges.filter((e) => e.kind === "attribute");
  const inward = attrs.filter((e) => {
    const owner = byId.get(e.from), attr = byId.get(e.to);
    return owner && attr && (attr.x - owner.x) * (drawingCenter.x - owner.x) + (attr.y - owner.y) * (drawingCenter.y - owner.y) > 1e-7;
  }).length;
  return {
    hierarchyViolations, diamondOffset: offsets.length ? offsets.reduce((s, d) => s + d, 0) / offsets.length : 0,
    relatedDistance: weight && medianWidth ? distances.reduce((s, p) => s + p.length * p.weight, 0) / weight / medianWidth : 0,
    proximityInversions: weight && unrelated.length ? inversions / (weight * unrelated.length) : 0,
    axisAligned: ends.length ? aligned / ends.length : 1,
    centralityOffset: degree && diagonal ? entities.reduce((s, e) => s + (degrees.get(e.id) ?? 0) * distance(byId.get(e.id)!, drawingCenter), 0) / degree / diagonal : 0,
    gridMisalignment: points.length > 1 ? points.filter((p, i) => !points.some((q, j) => i !== j && (Math.abs(p.x - q.x) <= 2 || Math.abs(p.y - q.y) <= 2))).length / points.length : 0,
    attributeInwardRatio: attrs.length ? inward / attrs.length : 0,
  };
}
