import { anchor, boxAround, center, intersects, type Box, type DNode, type Point } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import type { Cluster } from "./clusters.js";
import { hierarchyDag, hierarchyPairs, modelRelations } from "./semantic-graph.js";
import { distance, segmentIntersection, segmentThrough } from "./shapes.js";

export interface SemanticPlacement { columns: Map<string, number>; ranks: Map<string, number>; score: number }

/** Longest-path ranks, followed by weighted barycentric row sweeps and grid refinement. */
export function semanticPlacements(model: NModel): SemanticPlacement[] {
  const ids = model.entities.map((e) => e.id).sort();
  const relations = modelRelations(model);
  const pairs = hierarchyPairs(relations);
  const ternary = model.relationships.length === 1 && model.entities.length === 3 ? model.relationships[0] : undefined;
  if (ternary && !pairs.length && new Set(ternary.ends.map((e) => e.entity)).size === 3) {
    const [left, below, right] = ternary.ends.map((e) => `E:${e.entity}`);
    return [{ columns: new Map([[left!, 0], [below!, 0.5], [right!, 1]]), ranks: new Map([[left!, 0], [below!, 1], [right!, 0]]), score: 0 }];
  }
  const hierarchy = hierarchyDag(ids, pairs);
  if (hierarchy.cyclic.size) {
    const component = (id: string) => hierarchy.cyclic.get(id) ?? id;
    const ranks = new Map(ids.map((id) => [component(id), 0]));
    for (let pass = 0; pass < ids.length; pass++) for (const { parent, child } of pairs) {
      const a = component(parent), b = component(child);
      if (a !== b) ranks.set(b, Math.max(ranks.get(b)!, ranks.get(a)! + 1));
    }
    for (const id of ids) hierarchy.ranks.set(id, ranks.get(component(id))!);
  }
  const neighbours = new Map(ids.map((id) => [id, [] as string[]]));
  for (const r of relations) for (const a of r.ends) for (const b of r.ends) if (a.entity !== b.entity) neighbours.get(a.entity)?.push(b.entity);
  const constrained = new Set(hierarchy.pairs.flatMap((p) => [p.parent, p.child]));
  const variants: SemanticPlacement[] = [];
  const sunk = hierarchy.cyclic.size ? undefined : sinkRanks(ids, hierarchy.ranks, hierarchy.pairs);
  const scorer = skeletonScorer(model);
  for (let variant = 0; variant < (sunk ? 12 : 6); variant++) {
    const ranks = new Map(variant < 6 ? hierarchy.ranks : sunk!);
    // An unconstrained entity belongs beside its neighbours, not in an arbitrary root row.
    for (const id of ids.filter((id) => !constrained.has(id))) {
      const nearby = neighbours.get(id)!.map((n) => ranks.get(n)!).sort((a, b) => a - b);
      if (nearby.length) ranks.set(id, Math.max(0, nearby[Math.floor((nearby.length - 1) / 2)]! + (variant % 3) - 1));
    }
    const rows = [...new Set(ranks.values())].sort((a, b) => a - b).map((rank) => ids.filter((id) => ranks.get(id) === rank));
    const width = Math.max(2, ...rows.map((row) => row.length));
    const columns = new Map<string, number>();
    for (const row of rows) row.forEach((id, i) => columns.set(id, variant < 3 ? i : width - 1 - i));
    for (let sweep = 0; sweep < 6; sweep++) for (const row of sweep % 2 ? [...rows].reverse() : rows) {
      const barycenter = (id: string) => {
        const ns = neighbours.get(id)!;
        return ns.length ? ns.reduce((s, n) => s + columns.get(n)!, 0) / ns.length : columns.get(id)!;
      };
      row.sort((a, b) => barycenter(a) - barycenter(b) || a.localeCompare(b));
      const slots = row.map((id) => columns.get(id)!).sort((a, b) => a - b);
      row.forEach((id, i) => columns.set(id, slots[i]!));
    }
    const evaluate = () => scorer(columns, ranks);
    let score = evaluate();
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (const row of rows) for (const id of row) {
        const old = columns.get(id)!;
        let best = score, destination = old;
        for (let col = 0; col < width; col++) {
          const occupant = row.find((other) => other !== id && columns.get(other) === col);
          columns.set(id, col);
          if (occupant) columns.set(occupant, old);
          const value = evaluate();
          if (value < best - 1e-7) { best = value; destination = col; }
          columns.set(id, old);
          if (occupant) columns.set(occupant, col);
        }
        if (destination !== old) {
          const occupant = row.find((other) => other !== id && columns.get(other) === destination);
          columns.set(id, destination);
          if (occupant) columns.set(occupant, old);
          score = best;
          improved = true;
        }
      }
      if (!improved) break;
    }
    variants.push({ columns, ranks, score });
  }
  // Symmetric binary models follow declaration order, keeping the first owner on the left.
  if (ids.length === 2 && !hierarchy.pairs.length) for (const placement of variants) {
    const first = model.entities[0]!.id, last = model.entities[1]!.id;
    if (placement.columns.get(first)! > placement.columns.get(last)!) {
      const max = Math.max(...placement.columns.values());
      for (const [id, column] of placement.columns) placement.columns.set(id, max - column);
    }
  }
  const unique = new Map<string, SemanticPlacement>();
  for (const v of variants.sort((a, b) => a.score - b.score)) {
    const max = Math.max(0, ...v.columns.values()), min = Math.min(0, ...v.columns.values());
    const key = [ids.map((id) => `${v.columns.get(id)! - min},${v.ranks.get(id)}`).join(";"), ids.map((id) => `${max - v.columns.get(id)!},${v.ranks.get(id)}`).join(";")].sort()[0]!;
    if (!unique.has(key)) unique.set(key, v);
  }
  return [...unique.values()];
}

/**
 * Longest-path ranks put every root in the top row. A parent may instead sit one row above its
 * nearest child, which keeps the 1:N order while pulling it next to its other neighbours.
 */
export function sinkRanks(ids: string[], ranks: Map<string, number>, pairs: { parent: string; child: string }[]): Map<string, number> | undefined {
  const result = new Map(ranks);
  const order = [...ids].sort((a, b) => ranks.get(b)! - ranks.get(a)! || a.localeCompare(b));
  for (const id of order) {
    const children = pairs.filter((p) => p.parent === id).map((p) => result.get(p.child)!);
    if (children.length) result.set(id, Math.max(result.get(id)!, Math.min(...children) - 1));
  }
  const used = [...new Set(result.values())].sort((a, b) => a - b);
  for (const id of ids) result.set(id, used.indexOf(result.get(id)!));
  return ids.some((id) => result.get(id) !== ranks.get(id)) ? result : undefined;
}

/** Static parts of the skeleton score are built once; the returned scorer adds terms in a fixed order. */
function skeletonScorer(model: NModel): (columns: Map<string, number>, ranks: Map<string, number>) => number {
  const relationships = model.relationships.map((r) => {
    const ends = [...new Set(r.ends.map((e) => e.entity))];
    return { id: r.id, ends: ends.map((name) => `E:${name}`), key: ends.join(";") };
  }).filter((r) => r.ends.length >= 2);
  const entities = model.entities.map((e) => ({ key: `E:${e.name}`, degree: model.relationships.filter((r) => r.ends.some((end) => `E:${end.entity}` === e.id)).length }));
  // Path pairs that may cross: different diamonds and different entities, in the original pair order.
  const owners = relationships.flatMap((r) => r.ends.map((end) => ({ from: r.id, to: end })));
  const pairs: [number, number][] = [];
  for (let i = 0; i < owners.length; i++) for (let j = i + 1; j < owners.length; j++) {
    if (owners[i]!.from !== owners[j]!.from && owners[i]!.to !== owners[j]!.to) pairs.push([i, j]);
  }
  // Successive calls move one or two entities, so pairs of unmoved paths reuse the previous result.
  let previous: { a: Point; b: Point }[] | undefined;
  const hits = new Uint8Array(pairs.length);
  return (columns, ranks) => {
    const point = (key: string) => ({ x: columns.get(key) ?? 0, y: ranks.get(key) ?? 0 });
    const positions = entities.map((e) => point(e.key));
    const paths: { a: Point; b: Point }[] = [];
    const diamonds: { id: string; p: Point; key: string }[] = [];
    let score = 0;
    for (const r of relationships) {
      const points = r.ends.map(point);
      const p = { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
      diamonds.push({ id: r.id, p, key: r.key });
      r.ends.forEach((_, i) => {
        const q = points[i]!;
        score += distance(p, q) ** 2 * 5 + (Math.abs(p.x - q.x) > 0.01 && Math.abs(p.y - q.y) > 0.01 ? 1.5 : 0);
        paths.push({ a: p, b: q });
      });
    }
    const moved = paths.map((path, i) => {
      const old = previous?.[i];
      return !old || old.a.x !== path.a.x || old.a.y !== path.a.y || old.b.x !== path.b.x || old.b.y !== path.b.y;
    });
    let crossings = 0;
    pairs.forEach(([i, j], k) => {
      if (moved[i] || moved[j]) hits[k] = segmentIntersection(paths[i]!.a, paths[i]!.b, paths[j]!.a, paths[j]!.b) ? 1 : 0;
      crossings += hits[k]!;
    });
    previous = paths;
    // Add one term per crossing, as a pairwise sum would.
    for (let k = 0; k < crossings; k++) score += 6;
    for (const d of diamonds) {
      for (const e of positions) if (distance(d.p, e) < 0.35) score += 40;
      for (const other of diamonds) if (d.id < other.id && distance(d.p, other.p) < 0.3 && d.key !== other.key) score += 10;
    }
    const cx = positions.reduce((s, e) => s + e.x, 0) / (positions.length || 1);
    const cy = positions.reduce((s, e) => s + e.y, 0) / (positions.length || 1);
    entities.forEach((e, i) => { score += e.degree * distance(positions[i]!, { x: cx, y: cy }) * 0.15; });
    return score;
  };
}

export function placeSemantically(clusters: Cluster[], model: NModel, placement: SemanticPlacement, spacing = 430, reserved: Box[] = [], rowSpacing = spacing): void {
  const byId = new Map(clusters.map((c) => [c.node.id, c]));
  const isolatedTernary = model.entities.length === 3 && model.relationships.length === 1 && new Set(model.relationships[0]!.ends.map((e) => e.entity)).size === 3 && !hierarchyPairs(modelRelations(model)).length;
  if (isolatedTernary) spacing = 480;
  const rankSpacing = isolatedTernary ? 200 : new Set(placement.columns.values()).size === 1 ? Math.min(rowSpacing, 280) : rowSpacing;
  for (const c of clusters.filter((c) => c.node.kind === "entity" && !c.node.pinned)) {
    c.node.box = boxAround({ x: 350 + placement.columns.get(c.node.id)! * spacing, y: 350 + placement.ranks.get(c.node.id)! * rankSpacing }, c.node.box.w, c.node.box.h);
  }
  const pinnedEntities = clusters.filter((c) => c.node.kind === "entity" && c.node.pinned);
  if (pinnedEntities.length) {
    const dx = pinnedEntities.reduce((sum, c) => sum + center(c.node.box).x - 350 - placement.columns.get(c.node.id)! * spacing, 0) / pinnedEntities.length;
    const dy = pinnedEntities.reduce((sum, c) => sum + center(c.node.box).y - 350 - placement.ranks.get(c.node.id)! * rankSpacing, 0) / pinnedEntities.length;
    for (const c of clusters.filter((c) => c.node.kind === "entity" && !c.node.pinned)) {
      c.node.box.x += dx;
      c.node.box.y += dy;
      const point = center(c.node.box);
      if (pinnedEntities.length > 1) c.node.box = boxAround({ x: Math.max(350, point.x), y: Math.max(400, point.y) }, c.node.box.w, c.node.box.h);
    }
  }
  const placed = clusters.filter((c) => c.node.kind === "entity" || c.node.pinned);
  for (const r of [...model.relationships].sort((a, b) => a.id.localeCompare(b.id))) {
    const c = byId.get(r.id)!;
    if (c.node.pinned) continue;
    const ends = [...new Set(r.ends.map((e) => `E:${e.entity}`))].map((id) => byId.get(id)).filter((c): c is Cluster => !!c).map((c) => center(c.node.box));
    if (!ends.length) continue;
    const midpoint = { x: ends.reduce((s, p) => s + p.x, 0) / ends.length, y: isolatedTernary ? Math.min(...ends.map((p) => p.y)) : ends.reduce((s, p) => s + p.y, 0) / ends.length };
    const dx = ends.length > 1 ? ends[1]!.x - ends[0]!.x : 1, dy = ends.length > 1 ? ends[1]!.y - ends[0]!.y : 0;
    const norm = Math.hypot(dx, dy) || 1;
    // Parallel relationships use a small perpendicular lane around their shared midpoint.
    const repeated = model.relationships.filter((other) => other.ends.map((e) => e.entity).sort().join(";") === r.ends.map((e) => e.entity).sort().join(";")).sort((a, b) => a.id.localeCompare(b.id));
    const gap = (Math.abs(dy) * c.node.box.w + Math.abs(dx) * c.node.box.h) / norm + 20;
    const lane = (repeated.indexOf(r) - (repeated.length - 1) / 2) * gap;
    const origin = { x: midpoint.x - dy / norm * lane, y: midpoint.y + dx / norm * lane };
    const offsets = [0, 32, -32, 64, -64, 96, -96, 128, -128, 160, -160, 224, -224, 288, -288];
    const positions = offsets.flatMap((offset) => [0, 48, -48, 96, -96].map((along) => ({ x: origin.x - dy / norm * offset + dx / norm * along, y: origin.y + dx / norm * offset + dy / norm * along }))).sort((a, b) => distance(a, origin) - distance(b, origin));
    const position = positions.find((p) => !reserved.some((box) => intersects(boxAround(p, c.node.box.w, c.node.box.h), box, 18)) && !placed.some((other) => intersects(boxAround(p, c.node.box.w, c.node.box.h), other.node.box, 18))) ?? origin;
    c.node.box = boxAround(position, c.node.box.w, c.node.box.h);
    placed.push(c);
  }
}

/** Recursive ends need a side corridor rather than an entity centroid. */
export function placeSemanticRecursive(model: NModel, nodes: DNode[]): void {
  for (const r of model.relationships) {
    if (!r.ends.every((e) => e.entity === r.ends[0]!.entity)) continue;
    const entity = nodes.find((n) => n.id === `E:${r.ends[0]!.entity}`), diamond = nodes.find((n) => n.id === r.id);
    if (!entity || !diamond || diamond.pinned) continue;
    const p = center(entity.box);
    const sparse = model.entities.length <= 4 && model.entities.find((e) => e.id === entity.id)!.attrs.length <= 3;
    // Large diagrams: tight arms first (about one entity height), wider corridors only when a neighbour is in the way.
    const gaps = sparse ? [200, 240, 280] : model.entities.length >= 8 ? [130, 160, 200, 280, 340, 400] : [280, 340, 400];
    const candidates = [0, -180, 180, -260, 260].flatMap((x) => [-1, 1].flatMap((sign) => gaps.map((gap) => ({ x: p.x + x, y: p.y + sign * gap }))));
    const neighbours = model.relationships.filter((other) => other !== r && other.ends.some((end) => `E:${end.entity}` === entity.id))
      .map((other) => center(nodes.find((n) => n.id === other.id)!.box));
    const score = (point: Point) => neighbours.filter((other) => (other.y - p.y) * (point.y - p.y) > 0).length * 10000 + distance(point, p);
    candidates.sort((a, b) => score(a) - score(b));
    const chosen = candidates.find((point) => !nodes.some((n) => n !== entity && n !== diamond && intersects(boxAround(point, diamond.box.w, diamond.box.h), n.box, 30)));
    if (chosen) diamond.box = boxAround(chosen, diamond.box.w, diamond.box.h);
  }
}

/** Rescaling around absolute entity pins must recompute free diamond centroids. */
export function recenterPinnedDiamonds(clusters: Cluster[], model: NModel): void {
  const byId = new Map(clusters.map((c) => [c.node.id, c.node]));
  for (const r of model.relationships) {
    const diamond = byId.get(r.id)!;
    if (diamond.pinned) continue;
    const ids = [...new Set(r.ends.map((e) => `E:${e.entity}`))];
    if (ids.length < 2) continue;
    const parallel = model.relationships.filter((other) => other.ends.map((e) => e.entity).sort().join(";") === r.ends.map((e) => e.entity).sort().join(";")).length;
    if (parallel > 1) continue;
    const points = ids.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n).map((n) => center(n.box));
    if (!points.length) continue;
    diamond.box = boxAround({ x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length }, diamond.box.w, diamond.box.h);
  }
}

/** Pinned ovals cannot move, so reserve their straight spokes before routing ends. */
export function clearPinnedSpokes(model: NModel, nodes: DNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const spokes = [...model.entities, ...model.relationships].flatMap((owner) => flattenAttrs(owner.attrs).flatMap((attr) => {
    const oval = byId.get(attr.id), parent = byId.get(attr.parent ?? owner.id);
    return oval?.pinned && parent ? [[anchor(parent, center(oval.box)), anchor(oval, center(parent.box))] as [Point, Point]] : [];
  }));
  for (const diamond of nodes.filter((n) => n.kind === "relationship" && !n.pinned)) {
    if (!spokes.some(([a, b]) => segmentThrough(a, b, diamond))) continue;
    const p = center(diamond.box);
    const candidates = [48, 96, 144, 192].flatMap((gap) => [{ x: p.x - gap, y: p.y }, { x: p.x + gap, y: p.y }, { x: p.x, y: p.y - gap }, { x: p.x, y: p.y + gap }]);
    for (const point of candidates) {
      const candidate = { ...diamond, box: boxAround(point, diamond.box.w, diamond.box.h) };
      if (nodes.some((n) => n !== diamond && intersects(candidate.box, n.box, 18))) continue;
      if (spokes.some(([a, b]) => segmentThrough(a, b, candidate))) continue;
      diamond.box = candidate.box;
      break;
    }
  }
}
