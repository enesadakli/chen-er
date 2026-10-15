import { center, type Box, type DEdge, type DNode, type LayoutResult, type Point } from "../geometry.js";
import type { NCategory, NModel, NRelationship, NSpecialization } from "../normalize.js";
import { style } from "../style.js";
import { distance, segments } from "./shapes.js";

/**
 * An EER circle as the layout sees it. End 0 of the proxy relationship is the root: the superclass of a
 * specialization, the category of a union type. The fan is the other side: subclasses or superclasses.
 * A total circle draws its root line double.
 */
export interface EerCircle {
  kind: "specialization" | "category";
  root: string;
  fan: string[];
  completeness: "total" | "partial";
}

const specializations = new WeakMap<NRelationship, NSpecialization>();
const circles = new WeakMap<NRelationship, EerCircle>();
export const specializationOf = (relationship: NRelationship): NSpecialization | undefined => specializations.get(relationship);
export const circleOf = (relationship: NRelationship): EerCircle | undefined => circles.get(relationship);
export const isSpecializationId = (id: string): boolean => id.startsWith("S:");
export const isCategoryId = (id: string): boolean => id.startsWith("U:");
/** Specialization or category circle. */
export const isEerCircleId = (id: string): boolean => isSpecializationId(id) || isCategoryId(id);
/** End id of a circle's root line: "#super" for a specialization, "#sub" for a category. */
export const rootEndId = (circleId: string): string => `${circleId}#${isCategoryId(circleId) ? "sub" : "super"}`;
/** Ends that point down the hierarchy: specialization subclasses and the category itself. */
export const isChildEnd = (circleId: string, endId: string | undefined): boolean => (endId === rootEndId(circleId)) === isCategoryId(circleId);

export function withSpecializationProxies(model: NModel): NModel {
  if (!model.specializations.length && !model.categories.length) return model;
  const free = (id: string) => !model.relationships.some((r) => r.id === id);
  const proxy = (id: string, name: string, path: string, root: string, fan: string[], rootEnd: string): NRelationship => ({
    id, name, label: "", attrs: [], path,
    ends: [root, ...fan].map((entity, index) => ({
      id: `${id}#${index === 0 ? rootEnd : entity}`, index, relationship: name, entity,
      min: index === 0 ? 1 : 0, max: 1, card: index === 0 ? "1..1" : "0..1", path,
    })),
  });
  const specProxies = model.specializations.filter((spec) => free(spec.id)).map((spec) => {
    const r = proxy(spec.id, spec.name, spec.path, spec.supertype, spec.subtypes, "super");
    specializations.set(r, spec);
    circles.set(r, { kind: "specialization", root: spec.supertype, fan: spec.subtypes, completeness: spec.completeness });
    return r;
  });
  const categoryProxies = model.categories.filter((category) => free(category.id)).map((category: NCategory) => {
    const r = proxy(category.id, category.name, category.path, category.subtype, category.supertypes, "sub");
    circles.set(r, { kind: "category", root: category.subtype, fan: category.supertypes, completeness: category.completeness });
    return r;
  });
  return { ...model, relationships: [...model.relationships, ...specProxies, ...categoryProxies] };
}

/** Extend the first segment to the ellipse without changing its direction. */
function circleStart(node: DNode, points: Point[]): Point {
  const a = points[0]!, b = points[1] ?? a, c = center(node.box);
  const length = distance(a, b) || 1, ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
  const rx = node.box.w / 2, ry = node.box.h / 2;
  const x = a.x - c.x, y = a.y - c.y;
  const aa = (ux / rx) ** 2 + (uy / ry) ** 2;
  const bb = 2 * (x * ux / rx ** 2 + y * uy / ry ** 2);
  const cc = (x / rx) ** 2 + (y / ry) ** 2 - 1;
  if (aa < 1e-12) return a;
  const t = (-bb + Math.sqrt(Math.max(0, bb * bb - 4 * aa * cc))) / (2 * aa);
  return { x: a.x + t * ux, y: a.y + t * uy };
}

/** Remove label exclusion intervals, retaining the point nearest the path midpoint. */
function subsetMark(edge: DEdge, labels: Box[]): DEdge["subset"] {
  const lines = segments(edge.points), total = lines.reduce((sum, [a, b]) => sum + distance(a, b), 0);
  const clearance = style.specialization.subsetRadius + 6;
  let offset = 0, best: { at: Point; toward: Point; score: number } | undefined;
  for (const [a, b] of lines) {
    const length = distance(a, b);
    if (length < 2 * clearance) { offset += length; continue; }
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    let intervals: [number, number][] = [[clearance, length - clearance]];
    for (const box of labels) {
      let lo = -Infinity, hi = Infinity;
      const axes: [number, number, number, number][] = [
        [a.x, ux, box.x - clearance, box.x + box.w + clearance],
        [a.y, uy, box.y - clearance, box.y + box.h + clearance],
      ];
      for (const [origin, direction, min, max] of axes) {
        if (Math.abs(direction) < 1e-9) {
          if (origin < min || origin > max) { lo = Infinity; break; }
        } else {
          const t1 = (min - origin) / direction, t2 = (max - origin) / direction;
          lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
        }
      }
      if (lo > hi) continue;
      intervals = intervals.flatMap(([start, end]): [number, number][] => hi < start || lo > end ? [[start, end]]
        : [...(lo > start ? [[start, lo - 0.01] as [number, number]] : []), ...(hi < end ? [[hi + 0.01, end] as [number, number]] : [])]);
    }
    for (const [start, end] of intervals) {
      const along = Math.max(start, Math.min(end, total / 2 - offset));
      const score = Math.abs(offset + along - total / 2);
      if (!best || score < best.score) best = { at: { x: a.x + ux * along, y: a.y + uy * along }, toward: { x: -ux, y: -uy }, score };
    }
    offset += length;
  }
  // Conflicting pins can leave no room for a mark; keep it on the longest segment.
  if (!best) {
    const longest = [...lines].sort(([a, b], [c, d]) => distance(c, d) - distance(a, b))[0];
    if (!longest) return undefined;
    const [a, b] = longest, length = distance(a, b);
    if (!length) return undefined;
    return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, toward: { x: (a.x - b.x) / length, y: (a.y - b.y) / length } };
  }
  return { at: best.at, toward: best.toward };
}

export function finishSpecializations(result: LayoutResult, model: NModel): LayoutResult {
  if (!model.specializations.length && !model.categories.length) return result;
  const diagram = result.diagram;
  for (const spec of model.specializations) {
    const node = diagram.nodes.find((n) => n.id === spec.id);
    if (!node) continue;
    node.kind = "specialization";
    node.double = false;
    node.specialization = spec.subtypes.length > 1 ? { symbol: spec.disjointness === "disjoint" ? "d" : "o" } : {};
    for (const edge of diagram.edges.filter((e) => e.from === spec.id && e.kind === "end")) {
      if (edge.points.length < 2) continue;
      edge.points = [spec.subtypes.length === 1 ? center(node.box) : circleStart(node, edge.points), ...edge.points.slice(1)];
      if (edge.end !== `${spec.id}#super`) edge.subset = subsetMark(edge, diagram.labels.map((l) => l.box));
    }
  }
  for (const category of model.categories) {
    const node = diagram.nodes.find((n) => n.id === category.id);
    if (!node) continue;
    node.kind = "specialization";
    node.double = false;
    node.specialization = { symbol: "u" };
    for (const edge of diagram.edges.filter((e) => e.from === category.id && e.kind === "end")) {
      if (edge.points.length < 2) continue;
      edge.points = [circleStart(node, edge.points), ...edge.points.slice(1)];
      // The category is the subset of the union of its superclasses: the mark sits on its own line.
      if (edge.end === `${category.id}#sub`) edge.subset = subsetMark(edge, diagram.labels.map((l) => l.box));
    }
  }
  return result;
}
