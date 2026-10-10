import { isRelativePin, pinPoint } from "../pins.js";
import { labelIntersectsLines } from "./label-geometry.js";
import { anchor, boxAround, center, intersects, type DEdge, type DLabel, type DNode, type Pins, type Point } from "../geometry.js";
import type { NAttribute } from "../normalize.js";
import { attributeSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import type { EndPort } from "./anchors.js";
import { boxShape, distance, segmentIntersection, segmentThrough, segments } from "./shapes.js";
import { MIN_ROUTE_SEGMENT } from "./semantic-edges.js";
import type { Cluster } from "./clusters.js";

const angleDistance = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
interface Fan { nodes: DNode[]; edges: DEdge[]; angle: number }

export function placeAttributes(clusters: Cluster[], nodes: DNode[], edges: DEdge[], metrics: TextMetrics, endPorts: Map<string, EndPort> = new Map(), labels: DLabel[] = [], pins: Pins = {}): boolean {
  const nodeCount = nodes.length, edgeCount = edges.length;
  const entities = nodes.filter((n) => n.kind === "entity").map((n) => center(n.box));
  const centroid = { x: entities.reduce((s, p) => s + p.x, 0) / (entities.length || 1), y: entities.reduce((s, p) => s + p.y, 0) / (entities.length || 1) };
  const skeleton = edges.filter((e) => e.kind === "end").flatMap((e) => segments(e.points));
  const portAnchors = [...endPorts.entries()].map(([id, port]) => ({ owner: edges.find((e) => e.id === id)?.to, anchor: port.anchor }));
  for (const c of clusters) {
    const p = center(c.node.box), outward = p.x === centroid.x && p.y === centroid.y ? -Math.PI / 2 : Math.atan2(p.y - centroid.y, p.x - centroid.x);
    const chosen: number[] = [];
    for (const a of [...c.attrs].sort((a, b) => b.parts.length - a.parts.length)) {
      const fan = plan(a, c.node, outward, chosen, [], [], 40);
      if (!fan) {
        nodes.splice(nodeCount);
        edges.splice(edgeCount);
        return false;
      }
      for (const node of fan.nodes) if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
      edges.push(...fan.edges);
      chosen.push(fan.angle);
    }
  }

  return true;

  function plan(attr: NAttribute, parent: DNode, preferred: number, chosen: number[], pendingNodes: DNode[], pendingEdges: DEdge[], rings: number): Fan | undefined {
    const pc = center(parent.box), size = attributeSize(attr.label, metrics), pin = pins[attr.id];
    const fixed = nodes.find((n) => n.id === attr.id) ?? (pin && isRelativePin(pin) ? attributeNode(attr, pinPoint(pin, pc), metrics, true) : undefined);
    const angles = Array.from({ length: 72 }, (_, i) => preferred + i * Math.PI / 36).sort((a, b) => {
      const score = (t: number) => angleDistance(t, preferred) + chosen.reduce((s, u) => s + Math.max(0, 0.45 - angleDistance(t, u)) * 12, 0);
      return score(a) - score(b) || a - b;
    });
    for (let ring = 0; ring < (fixed ? 1 : rings); ring++) {
      const targets = fanTargets(parent, size, angles, ring, preferred);
      for (const target of fixed ? [center(fixed.box)] : targets) {
        const angle = Math.atan2(target.y - pc.y, target.x - pc.x);
        const node = fixed ?? attributeNode(attr, target, metrics, false);
        const edge: DEdge = { id: `edge:${attr.id}`, kind: attr.parent ? "part" : "attribute", from: parent.id, to: attr.id, points: attributeAnchors(parent, node), double: false };
        if (!fixed && !clear(node, parent, edge, pendingNodes, pendingEdges)) continue;
        const fan: Fan = { nodes: [node], edges: [edge], angle };
        const childAngles: number[] = [];
        let complete = true;
        for (const [i, part] of attr.parts.entries()) {
          const child = plan(part, node, angle + (i - (attr.parts.length - 1) / 2) * 0.9, childAngles, [...pendingNodes, ...fan.nodes], [...pendingEdges, ...fan.edges], 3);
          if (!child) { complete = false; break; }
          fan.nodes.push(...child.nodes);
          fan.edges.push(...child.edges);
          childAngles.push(child.angle);
        }
        if (complete) return fan;
      }
    }
    return undefined;
  }

  function clear(node: DNode, parent: DNode, edge: DEdge, pendingNodes: DNode[], pendingEdges: DEdge[]): boolean {
    const [a, b] = edge.points as [Point, Point], box = node.box;
    if (distance(a, b) < MIN_ROUTE_SEGMENT) return false;
    const others = [...nodes, ...pendingNodes].filter((n) => n.id !== node.id);
    if (others.some((n) => intersects(box, n.box, 14)) || labels.some((l) => intersects(box, l.box, 8))) return false;
    if (others.some((n) => n.id !== parent.id && segmentThrough(a, b, boxShape(n.box)))) return false;
    if (labels.some((l) => labelIntersectsLines(l.box, [[a, b]], 5))) return false;
    if (portAnchors.some((port) => port.owner === parent.id && distance(a, port.anchor) < 14)) return false;
    if (skeleton.some(([p, q]) => segmentThrough(p, q, boxShape({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 })) || segmentIntersection(a, b, p, q))) return false;
    const pool = new Map<string, DNode>();
    for (const n of [...nodes, ...pendingNodes]) if (!pool.has(n.id)) pool.set(n.id, n);
    return ![...edges, ...pendingEdges].filter((e) => e.kind !== "end").some((other) => {
      const from = pool.get(other.from)!, to = pool.get(other.to)!;
      const [p, q] = attributeAnchors(from, to);
      return segmentThrough(p, q, boxShape(box)) || (other.from !== parent.id && other.to !== parent.id && !!segmentIntersection(a, b, p, q));
    });
  }
}

function fanTargets(parent: DNode, size: { w: number; h: number }, angles: number[], ring: number, preferred: number): Point[] {
  const pc = center(parent.box);
  const targets = angles.map((angle) => {
    const ray = { x: pc.x + Math.cos(angle), y: pc.y + Math.sin(angle) };
    const ownerRadius = distance(pc, anchor(parent, ray));
    const ovalRadius = 1 / Math.sqrt((Math.cos(angle) / (size.w / 2)) ** 2 + (Math.sin(angle) / (size.h / 2)) ** 2);
    const radius = ownerRadius + ovalRadius + 36 + ring * 24;
    const target = { x: Math.round(pc.x + Math.cos(angle) * radius), y: Math.round(pc.y + Math.sin(angle) * radius) };
    return target;
  });
  if (parent.kind === "entity") {
    const b = parent.box, gap = 36 + ring * 24;
    const columns = Math.max(2, Math.ceil(b.w / 24)), rows = Math.max(2, Math.ceil(b.h / 24));
    for (let i = 0; i <= columns; i++) {
      const x = b.x + 10 + i * (b.w - 20) / columns;
      targets.push({ x, y: b.y - size.h / 2 - gap }, { x, y: b.y + b.h + size.h / 2 + gap });
    }
    for (let i = 0; i <= rows; i++) {
      const y = b.y + 10 + i * (b.h - 20) / rows;
      targets.push({ x: b.x - size.w / 2 - gap, y }, { x: b.x + b.w + size.w / 2 + gap, y });
    }
    targets.sort((a, b) => angleDistance(Math.atan2(a.y - pc.y, a.x - pc.x), preferred) - angleDistance(Math.atan2(b.y - pc.y, b.x - pc.x), preferred));
  }
  return targets;
}

/** Entity spokes use the nearest border point; composite parts radiate from their oval. */
export function attributeAnchors(parent: Pick<DNode, "kind" | "box">, oval: Pick<DNode, "kind" | "box">, radial = false): [Point, Point] {
  const target = center(oval.box), b = parent.box;
  const start = parent.kind === "entity" && !radial ? { x: Math.max(b.x, Math.min(b.x + b.w, target.x)), y: Math.max(b.y, Math.min(b.y + b.h, target.y)) } : anchor(parent, target);
  return [start, anchor(oval, start)];
}

export function attributeNode(a: NAttribute, p: Point, metrics: TextMetrics, pinned: boolean): DNode {
  const size = attributeSize(a.label, metrics);
  return { id: a.id, kind: "attribute", label: a.label, box: boxAround(p, size.w, size.h), double: a.multivalued, pinned, attr: { key: a.key, partial: a.partial, multivalued: a.multivalued, derived: a.derived } };
}

export function placeRadialAttributes(clusters: Cluster[], nodes: DNode[], edges: DEdge[], metrics: TextMetrics, endPorts: Map<string, EndPort> = new Map(), pins: Pins = {}): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const skeleton = edges.filter((e) => e.kind === "end").flatMap((e) => segments(e.points).map(([a, b]) => ({ a, b })));
  for (const c of clusters) {
    const oc = center(c.node.box);
    const used = edges.filter((e) => e.from === c.node.id || e.to === c.node.id).map((e) => {
      const p = center(byId.get(e.from === c.node.id ? e.to : e.from)!.box);
      return Math.atan2(p.y - oc.y, p.x - oc.x);
    });
    const rootRadius = Math.max(c.node.box.w / 2 + 98, c.attrs.reduce((s, a) => s + attributeSize(a.label, metrics).w + 35, 0) / (Math.PI * 1.25));
    const chosen: number[] = [];
    c.attrs.forEach((a, i) => place(a, c.node, -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, c.attrs.length), rootRadius, used, chosen));
  }
  function place(a: NAttribute, parent: DNode, preferred: number, radius: number, used: number[], chosen: number[]) {
    const pc = center(parent.box), size = attributeSize(a.label, metrics);
    let node = byId.get(a.id);
    const pin = pins[a.id];
    if (!node && pin && isRelativePin(pin)) {
      node = attributeNode(a, pinPoint(pin, pc), metrics, true);
      nodes.push(node); byId.set(node.id, node);
    }
    let angle = preferred;
    if (!node) {
      const candidates = Array.from({ length: 72 }, (_, i) => -Math.PI + i * Math.PI / 36).sort((a, b) => {
        const score = (t: number) => angleDistance(t, preferred) + used.reduce((s, u) => s + Math.max(0, 0.65 - angleDistance(t, u)) * 15, 0) + chosen.reduce((s, u) => s + Math.max(0, 0.4 - angleDistance(t, u)) * 12, 0);
        return score(a) - score(b) || a - b;
      });
      search: for (let ring = 0; ring < 40; ring++) for (const t of candidates) {
        const p = { x: pc.x + Math.cos(t) * (radius + ring * 65), y: pc.y + Math.sin(t) * (radius + ring * 65) };
        const box = boxAround(p, size.w, size.h);
        if (nodes.some((n) => intersects(box, n.box, 14))) continue;
        const start = anchor(parent, p), end = anchor({ kind: "attribute", box }, pc);
        if ([...endPorts.entries()].some(([id, port]) => edges.find((e) => e.id === id)?.to === parent.id && distance(start, port.anchor) < 14)) continue;
        if (nodes.some((n) => n.id !== parent.id && segmentThrough(start, end, boxShape(n.box)))) continue;
        if (skeleton.some((s) => segmentThrough(s.a, s.b, boxShape({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 })) || segmentIntersection(start, end, s.a, s.b))) continue;
        if (edges.filter((e) => e.kind !== "end").some((e) => {
          const from = byId.get(e.from)!, to = byId.get(e.to)!;
          const a = anchor(from, center(to.box)), b = anchor(to, center(from.box));
          return segmentThrough(a, b, boxShape(box)) || (e.from !== parent.id && e.to !== parent.id && !!segmentIntersection(start, end, a, b));
        })) continue;
        node = attributeNode(a, p, metrics, false);
        angle = t;
        break search;
      }
      if (!node) {
        const right = Math.max(0, ...nodes.map((n) => n.box.x + n.box.w));
        node = attributeNode(a, { x: right + size.w / 2 + 40, y: pc.y }, metrics, false);
      }
      nodes.push(node);
      byId.set(node.id, node);
    } else {
      const nc = center(node.box);
      angle = Math.atan2(nc.y - pc.y, nc.x - pc.x);
    }
    chosen.push(angle);
    edges.push({ id: `edge:${a.id}`, kind: a.parent ? "part" : "attribute", from: parent.id, to: a.id, points: [], double: false });
    const childChosen: number[] = [];
    a.parts.forEach((part, i) => place(part, node!, angle + (i - (a.parts.length - 1) / 2) * 0.65, node!.box.w / 2 + 110, [angle + Math.PI], childChosen));
  }
}
