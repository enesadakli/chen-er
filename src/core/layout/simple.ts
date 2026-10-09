import { anchor, boxAround, center, intersects, type DEdge, type DLabel, type DNode, type LayoutEngine, type Point } from "../geometry.js";
import type { NAttribute } from "../normalize.js";
import { attributeSize, cardText, entitySize, labelSize, relationshipSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import { finalize } from "./finalize.js";

/**
 * Baseline layout: entities on a grid, relationships at the centroid of their
 * entities, attributes on a ring. Deterministic and dependency-free; the real
 * engines (layered/stress) must beat it on the bench.
 */
export const simpleLayout: LayoutEngine = async (model, metrics, options) => {
  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  const labels: DLabel[] = [];
  const byId = new Map<string, DNode>();
  const add = (n: DNode) => (nodes.push(n), byId.set(n.id, n), n);
  const pins = options.pins ?? {};

  const ring = (attrs: NAttribute[]) => (attrs.length ? 90 + Math.min(attrs.length, 8) * 6 : 0);
  const cell = Math.max(
    300,
    ...model.entities.map((e) => entitySize(e.label, metrics).w + 2 * ring(e.attrs) + 160),
  );
  const cols = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));

  model.entities.forEach((e, i) => {
    const size = entitySize(e.label, metrics);
    const c = pins[e.id] ?? { x: (i % cols) * cell, y: Math.floor(i / cols) * cell };
    add({ id: e.id, kind: "entity", label: e.label, box: boxAround(c, size.w, size.h), double: e.weak, pinned: !!pins[e.id] });
  });

  for (const r of model.relationships) {
    const size = relationshipSize(r.label, metrics);
    const ends = r.ends.map((end) => byId.get(`E:${end.entity}`)).filter((n): n is DNode => !!n);
    let c: Point = pins[r.id] ?? centroid(ends.map((n) => center(n.box)));
    const recursive = new Set(r.ends.map((e) => e.entity)).size < r.ends.length;
    if (!pins[r.id]) {
      if (recursive && ends[0]) c = { x: c.x + ends[0].box.w / 2 + size.w, y: c.y + 120 };
      let guard = 0;
      while (nodes.some((n) => n.kind !== "attribute" && intersects(n.box, boxAround(c, size.w, size.h), 40)) && guard++ < 50) {
        c = { x: c.x, y: c.y + 50 };
      }
    }
    const rel = add({ id: r.id, kind: "relationship", label: r.label, box: boxAround(c, size.w, size.h), double: !!r.identifies, pinned: !!pins[r.id] });

    r.ends.forEach((end, k) => {
      const target = byId.get(`E:${end.entity}`);
      if (!target) return;
      const tc = center(target.box);
      const shift = recursive ? (k === 0 ? -18 : 18) : 0;
      const aim = { x: tc.x + shift, y: tc.y + shift };
      const p1 = anchor(rel, aim);
      const p2 = anchor(target, center(rel.box));
      const p2s = { x: p2.x + shift, y: p2.y + shift };
      const edge: DEdge = {
        id: `edge:${end.id}`,
        kind: "end",
        from: rel.id,
        to: target.id,
        points: [p1, p2s],
        double: r.identifies === end.entity,
        end: end.id,
      };
      edges.push(edge);
      labels.push(endLabel(edge, cardText(end.min, end.max), metrics, "cardinality"));
      if (end.role) labels.push(endLabel(edge, end.role, metrics, "role", 1));
    });
  }

  const owners = [
    ...model.entities.map((e) => ({ id: e.id, attrs: e.attrs })),
    ...model.relationships.map((r) => ({ id: r.id, attrs: r.attrs })),
  ];
  for (const o of owners) {
    const owner = byId.get(o.id);
    if (!owner || !o.attrs.length) continue;
    const oc = center(owner.box);
    const used = edges.filter((e) => e.from === o.id || e.to === o.id).map((e) => angleOf(oc, otherEnd(e, o.id, byId)));
    const angles = freeAngles(o.attrs.length, used);
    const radius = Math.max(owner.box.w, owner.box.h) / 2 + ring(o.attrs);
    o.attrs.forEach((a, i) => placeAttr(a, owner, angles[i] ?? 0, radius));
  }

  function placeAttr(a: NAttribute, parent: DNode, angle: number, radius: number) {
    const size = attributeSize(a.label, metrics);
    const pc = center(parent.box);
    const c = pins[a.id] ?? { x: pc.x + Math.cos(angle) * radius, y: pc.y + Math.sin(angle) * radius };
    const n = add({
      id: a.id,
      kind: "attribute",
      label: a.label,
      box: boxAround(c, size.w, size.h),
      double: a.multivalued,
      attr: { key: a.key, partial: a.partial, multivalued: a.multivalued, derived: a.derived },
      pinned: !!pins[a.id],
    });
    edges.push({
      id: `edge:${a.id}`,
      kind: a.parent ? "part" : "attribute",
      from: parent.id,
      to: n.id,
      points: [anchor(parent, c), anchor(n, pc)],
      double: false,
    });
    const spread = 0.45;
    a.parts.forEach((p, k) => {
      const offset = (k - (a.parts.length - 1) / 2) * spread;
      placeAttr(p, n, angle + offset, Math.max(n.box.w, n.box.h) / 2 + 60);
    });
  }

  return finalize({ nodes, edges, labels, title: model.title, notes: model.notes, engine: "simple" });
};

function centroid(ps: Point[]): Point {
  if (!ps.length) return { x: 0, y: 0 };
  return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
}

const angleOf = (from: Point, to: Point) => Math.atan2(to.y - from.y, to.x - from.x);

function otherEnd(e: DEdge, id: string, byId: Map<string, DNode>): Point {
  const other = byId.get(e.from === id ? e.to : e.from);
  return other ? center(other.box) : { x: 0, y: 0 };
}

/** n angles spread around the circle, skipping a cone around every used direction. */
function freeAngles(n: number, used: number[]): number[] {
  const cone = 0.5;
  const candidates: number[] = [];
  const steps = 48;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * 2 * Math.PI;
    if (used.every((u) => Math.abs(Math.atan2(Math.sin(a - u), Math.cos(a - u))) > cone)) candidates.push(a);
  }
  const pool = candidates.length >= n ? candidates : Array.from({ length: steps }, (_, i) => -Math.PI / 2 + (i / steps) * 2 * Math.PI);
  return Array.from({ length: n }, (_, i) => pool[Math.floor((i * pool.length) / n)] ?? 0);
}

/** Label beside the entity end of an edge, offset perpendicular to the line. */
export function endLabel(edge: DEdge, text: string, m: TextMetrics, kind: DLabel["kind"], slot = 0): DLabel {
  const a = edge.points[edge.points.length - 1]!;
  const b = edge.points[edge.points.length - 2] ?? a;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const size = labelSize(text, m);
  const along = 26 + slot * 22;
  const side = 14 + size.w / 2 * Math.abs(uy) + size.h / 2 * Math.abs(ux);
  const c = { x: a.x + ux * along - uy * side, y: a.y + uy * along + ux * side };
  return { id: `label:${edge.id}:${kind}`, kind, text, box: boxAround(c, size.w, size.h), edge: edge.id };
}

