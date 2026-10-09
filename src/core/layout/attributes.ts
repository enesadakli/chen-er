import { anchor, boxAround, center, intersects, type DEdge, type DNode, type Point } from "../geometry.js";
import type { NAttribute } from "../normalize.js";
import { attributeSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";
import type { EndPort } from "./anchors.js";
import { distance, segments } from "./shapes.js";
import type { Cluster } from "./clusters.js";
import { boxShape, segmentIntersection, segmentThrough } from "./shapes.js";

const angleDistance = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export function placeAttributes(clusters: Cluster[], nodes: DNode[], edges: DEdge[], metrics: TextMetrics, endPorts: Map<string, EndPort> = new Map()): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const skeleton = edges.filter((e) => e.kind === "end").flatMap((e) => segments(e.points).map(([a, b]) => ({ a, b })));
  for (const c of clusters) {
    const oc = center(c.node.box);
    const used = edges.filter((e) => e.from === c.node.id || e.to === c.node.id).map((e) => {
      const p = center(byId.get(e.from === c.node.id ? e.to : e.from)!.box);
      return Math.atan2(p.y - oc.y, p.x - oc.x);
    });
    const rootRadius = Math.max(c.node.box.w / 2 + 100, c.attrs.reduce((s, a) => s + attributeSize(a.label, metrics).w + 35, 0) / (Math.PI * 1.25));
    const chosen: number[] = [];
    c.attrs.forEach((a, i) => place(a, c.node, -Math.PI / 2 + i * 2 * Math.PI / Math.max(1, c.attrs.length), rootRadius, used, chosen));
  }
  function place(a: NAttribute, parent: DNode, preferred: number, radius: number, used: number[], chosen: number[]) {
    const pc = center(parent.box), size = attributeSize(a.label, metrics);
    let node = byId.get(a.id);
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

export function attributeNode(a: NAttribute, p: Point, metrics: TextMetrics, pinned: boolean): DNode {
  const size = attributeSize(a.label, metrics);
  return { id: a.id, kind: "attribute", label: a.label, box: boxAround(p, size.w, size.h), double: a.multivalued, pinned, attr: { key: a.key, partial: a.partial, multivalued: a.multivalued, derived: a.derived } };
}
