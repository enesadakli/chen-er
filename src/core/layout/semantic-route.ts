import { anchor as outline, boxAround, center, intersects, type Box, type DEdge, type DNode, type Point } from "../geometry.js";
import type { TextMetrics } from "../text/metrics.js";
import { attributeSize } from "../style.js";
import type { EndPort } from "./anchors.js";
import { attributeNode } from "./attributes.js";
import type { Cluster } from "./clusters.js";
import { simplify } from "./route.js";
import { boxShape, distance, drawnPaths, segmentIntersection, segments, segmentThrough } from "./shapes.js";

/** Fast orthogonal corridor candidates; the existing router handles blocked cases. */
export function semanticRoute(edge: DEdge, nodes: DNode[], prior: DEdge[], port: EndPort | undefined, reserved: Box[] = []): Point[] | undefined {
  if (!port || edge.kind !== "end") return undefined;
  const from = nodes.find((n) => n.id === edge.from)!;
  const c = center(from.box), b = port.anchor;
  const foreign = nodes.filter((n) => n.id !== edge.from && n.id !== edge.to);
  const tips = [
    { x: c.x + from.box.w / 2, y: c.y, nx: 1, ny: 0 }, { x: c.x - from.box.w / 2, y: c.y, nx: -1, ny: 0 },
    { x: c.x, y: c.y + from.box.h / 2, nx: 0, ny: 1 }, { x: c.x, y: c.y - from.box.h / 2, nx: 0, ny: -1 },
  ].sort((a, d) => distance(a, b) - distance(d, b));
  const goal = { x: b.x + port.normal.x * 64, y: b.y + port.normal.y * 64 };
  const paths: Point[][] = [];
  for (const tip of tips) {
    const a = { x: tip.x, y: tip.y }, start = { x: a.x + tip.nx * 24, y: a.y + tip.ny * 24 };
    paths.push([a, start, { x: goal.x, y: start.y }, goal, b], [a, start, { x: start.x, y: goal.y }, goal, b]);
    const xs = [c.x, b.x, (start.x + goal.x) / 2], ys = [c.y, b.y, (start.y + goal.y) / 2];
    for (const x of xs) paths.push([a, start, { x, y: start.y }, { x, y: goal.y }, goal, b]);
    for (const y of ys) paths.push([a, start, { x: start.x, y }, { x: goal.x, y }, goal, b]);
  }
  let best: Point[] | undefined, score = Infinity;
  for (const path of paths) {
    const ps = simplify(path), lines = drawnPaths({ ...edge, points: ps }).flatMap(segments);
    if (lines.some(([a, b]) => nodes.some((n) => segmentThrough(a, b, n)))) continue;
    if (lines.some(([a, b]) => foreign.some((n) => segmentThrough(a, b, boxShape({ x: n.box.x - 6, y: n.box.y - 6, w: n.box.w + 12, h: n.box.h + 12 }))) || reserved.some((r) => segmentThrough(a, b, boxShape(r))))) continue;
    let crossings = 0;
    for (const other of prior) for (const [a, b] of lines) for (const [p, q] of drawnPaths(other).flatMap(segments)) {
      const hit = segmentIntersection(a, b, p, q);
      if (hit === "overlap") crossings += 8;
      else if (hit && ![ps[0]!, ps.at(-1)!].some((p) => distance(p, hit) < 1e-7)) crossings++;
    }
    const value = segments(ps).reduce((s, [a, b]) => s + distance(a, b), 0) + crossings * 160 + ps.length * 8;
    if (value < score) { score = value; best = ps; }
  }
  return best;
}

/** Reserve clear outward root attributes, leaving crowded and composite cases to the fan placer. */
export function semanticAttributes(clusters: Cluster[], nodes: DNode[], edges: DEdge[], metrics: TextMetrics, ports: Map<string, EndPort>): void {
  const entities = nodes.filter((n) => n.kind === "entity").map((n) => center(n.box));
  const centroid = { x: entities.reduce((s, p) => s + p.x, 0) / (entities.length || 1), y: entities.reduce((s, p) => s + p.y, 0) / (entities.length || 1) };
  const skeleton = edges.flatMap((e) => drawnPaths(e).flatMap(segments));
  const spokes: { owner: string; a: Point; b: Point }[] = [];
  for (const c of clusters) {
    const p = center(c.node.box), outward = Math.atan2(p.y - centroid.y, p.x - centroid.x);
    const angles = Array.from({ length: 72 }, (_, i) => i * Math.PI / 36).sort((a, b) => {
      const difference = (t: number) => Math.abs(Math.atan2(Math.sin(t - outward), Math.cos(t - outward)));
      return difference(a) - difference(b) || a - b;
    });
    const radius = Math.max(c.node.box.w / 2 + 100, c.attrs.reduce((s, a) => s + attributeSize(a.label, metrics).w + 35, 0) / (Math.PI * 1.25));
    for (const attr of c.attrs) {
      if (nodes.some((n) => n.id === attr.id) || attr.parts.length) continue;
      const size = attributeSize(attr.label, metrics);
      search: for (let ring = 0; ring < 3; ring++) for (const t of angles) {
        const target = { x: p.x + Math.cos(t) * (radius + ring * 50), y: p.y + Math.sin(t) * (radius + ring * 50) };
        const box = boxAround(target, size.w, size.h);
        if (nodes.some((n) => intersects(box, n.box, 14))) continue;
        const node = attributeNode(attr, target, metrics, false);
        // Use the same outline anchors as the fan placer when reserving a spoke.
        const a = outline(c.node, target), b = outline(node, p);
        if ([...ports.entries()].some(([id, port]) => edges.find((e) => e.id === id)?.to === c.node.id && distance(a, port.anchor) < 14)) continue;
        if (nodes.some((n) => n.id !== c.node.id && segmentThrough(a, b, boxShape(n.box)))) continue;
        if (skeleton.some(([p, q]) => segmentThrough(p, q, boxShape({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 })) || segmentIntersection(a, b, p, q))) continue;
        if (spokes.some((s) => segmentThrough(s.a, s.b, boxShape(box)) || (s.owner !== c.node.id && segmentIntersection(a, b, s.a, s.b)))) continue;
        nodes.push(node);
        spokes.push({ owner: c.node.id, a, b });
        break search;
      }
    }
  }
}
