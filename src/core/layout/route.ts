import { anchor, center, type Box, type DEdge, type DNode, type Point } from "../geometry.js";
import type { EndPort } from "./anchors.js";
import { boxShape, distance, drawnPaths, segmentIntersection, segments, segmentThrough } from "./shapes.js";

const expand = (b: Box, gap: number): Box => ({ x: b.x - gap, y: b.y - gap, w: b.w + gap * 2, h: b.h + gap * 2 });
const inBox = (p: Point, b: Box) => p.x > b.x + 1e-6 && p.x < b.x + b.w - 1e-6 && p.y > b.y + 1e-6 && p.y < b.y + b.h - 1e-6;
function blocked(a: Point, b: Point, boxes: Box[]): boolean {
  return boxes.some((r) => {
    if (a.x === b.x) return a.x > r.x + 1e-6 && a.x < r.x + r.w - 1e-6 && Math.max(a.y, b.y) > r.y + 1e-6 && Math.min(a.y, b.y) < r.y + r.h - 1e-6;
    if (a.y === b.y) return a.y > r.y + 1e-6 && a.y < r.y + r.h - 1e-6 && Math.max(a.x, b.x) > r.x + 1e-6 && Math.min(a.x, b.x) < r.x + r.w - 1e-6;
    return segmentThrough(a, b, boxShape(r));
  });
}
class Heap {
  private values: { id: number; score: number }[] = [];
  push(value: { id: number; score: number }) {
    const a = this.values;
    let i = a.length;
    a.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]!.score <= value.score) break;
      a[i] = a[parent]!;
      i = parent;
    }
    a[i] = value;
  }
  pop(): { id: number; score: number } | undefined {
    const a = this.values, first = a[0], last = a.pop();
    if (!a.length || !last) return first;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      if (child + 1 < a.length && a[child + 1]!.score < a[child]!.score) child++;
      if (a[child]!.score >= last.score) break;
      a[i] = a[child]!;
      i = child;
    }
    a[i] = last;
    return first;
  }
}
function orthogonal(start: Point, goal: Point, boxes: Box[], prior: DEdge[]): Point[] | undefined {
  const xs = [...new Set([start.x, goal.x, ...boxes.flatMap((b) => [b.x, b.x + b.w])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, goal.y, ...boxes.flatMap((b) => [b.y, b.y + b.h])])].sort((a, b) => a - b);
  const cols = xs.length, count = cols * ys.length;
  const point = (id: number): Point => ({ x: xs[id % cols]!, y: ys[Math.floor(id / cols)]! });
  const source = ys.indexOf(start.y) * cols + xs.indexOf(start.x);
  const target = ys.indexOf(goal.y) * cols + xs.indexOf(goal.x);
  const costs = new Float64Array(count).fill(Infinity), parents = new Int32Array(count).fill(-1);
  const seen = new Uint8Array(count), validity = new Uint8Array(count);
  const heap = new Heap();
  const heuristic = (p: Point) => Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y);
  costs[source] = 0;
  heap.push({ id: source, score: heuristic(start) });
  const priorSegments = prior.flatMap((e) => segments(e.points));
  let item;
  while ((item = heap.pop())) {
    const id = item.id;
    if (seen[id]) continue;
    if (id === target) {
      const path: Point[] = [];
      for (let k = id; k >= 0; k = parents[k]!) path.push(point(k));
      return simplify(path.reverse());
    }
    seen[id] = 1;
    const a = point(id), col = id % cols, row = Math.floor(id / cols);
    for (const next of [col > 0 ? id - 1 : -1, col + 1 < cols ? id + 1 : -1, row > 0 ? id - cols : -1, row + 1 < ys.length ? id + cols : -1]) {
      if (next < 0 || seen[next]) continue;
      const b = point(next);
      if (!validity[next]) validity[next] = boxes.some((r) => inBox(b, r)) ? 2 : 1;
      if (validity[next] === 2 || blocked(a, b, boxes)) continue;
      const crossingCost = priorSegments.reduce((sum, [c, d]) => {
        const hit = segmentIntersection(a, b, c, d);
        return sum + (hit === "overlap" ? 240 : hit ? 45 : 0);
      }, 0);
      const parent = parents[id]!;
      const turn = parent < 0 ? 0 : ((point(parent).x === a.x) !== (a.x === b.x) ? 12 : 0);
      const cost = costs[id]! + distance(a, b) + turn + crossingCost;
      if (cost >= costs[next]!) continue;
      costs[next] = cost;
      parents[next] = id;
      heap.push({ id: next, score: cost + heuristic(b) });
    }
  }
  return undefined;
}
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && distance(out.at(-1)!, p) < 1e-6) continue;
    while (out.length >= 2) {
      const a = out.at(-2)!, b = out.at(-1)!;
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cross) > 1e-6 || dot < 0) break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}
interface Port { anchor: Point; escape: Point }
function ports(node: DNode, toward: Point, obstacles: DNode[], angleOffset: number): Port[] {
  const c = center(node.box), angle = Math.atan2(toward.y - c.y, toward.x - c.x) + angleOffset;
  const out: Port[] = [];
  for (const delta of [0, -0.35, 0.35, -0.7, 0.7, -1.1, 1.1, -1.6, 1.6, Math.PI]) {
    const t = angle + delta, u = { x: Math.cos(t), y: Math.sin(t) };
    const p = anchor(node, { x: c.x + u.x * 1000, y: c.y + u.y * 1000 });
    const q = { x: p.x + u.x * 105, y: p.y + u.y * 105 };
    if (obstacles.every((n) => n.id === node.id || !segmentThrough(p, q, boxShape(expand(n.box, 9))))) out.push({ anchor: p, escape: q });
  }
  return out;
}

interface RouteOptions { endPort?: EndPort; forceBend?: boolean; reservedAnchors?: Point[] }

export function routeEdge(edge: DEdge, nodes: DNode[], prior: DEdge[], offset = 0, reserved: Box[] = [], options: RouteOptions = {}): Point[] {
  const { endPort, forceBend = false, reservedAnchors = [] } = options;
  const from = nodes.find((n) => n.id === edge.from)!, to = nodes.find((n) => n.id === edge.to)!;
  const b = endPort?.anchor ?? anchor(to, center(from.box)), a = anchor(from, b);
  const foreign = nodes.filter((n) => n.id !== from.id && n.id !== to.id);
  const direct = drawnPaths({ ...edge, points: [a, b] });
  // Recursive ends need separate ports even when their centerlines are clear.
  const freeAnchor = (p: Point) => reservedAnchors.every((other) => distance(p, other) >= 14);
  if (!forceBend && freeAnchor(a) && (!offset || endPort) && (!endPort || (a.x - b.x) * endPort.normal.x + (a.y - b.y) * endPort.normal.y > 0) && foreign.every((n) => direct.every((ps) => segments(ps).every(([p, q]) => !segmentThrough(p, q, n)))) && reserved.every((r) => !segmentThrough(a, b, boxShape(expand(r, 4))))) return [a, b];
  const obstacles = [...nodes.map((n) => expand(n.box, 10)), ...reserved.map((r) => expand(r, 5))];
  const starts = ports(from, center(to.box), nodes, offset).filter((p) => freeAnchor(p.anchor));
  const goals = endPort ? [{ anchor: b, escape: { x: b.x + endPort.normal.x * 90, y: b.y + endPort.normal.y * 90 } }] : ports(to, center(from.box), nodes, -offset);
  for (const start of starts) for (const goal of goals) {
    if (reserved.some((r) => segmentThrough(start.anchor, start.escape, boxShape(expand(r, 4))) || segmentThrough(goal.anchor, goal.escape, boxShape(expand(r, 4))))) continue;
    const path = orthogonal(start.escape, goal.escape, obstacles, prior);
    if (path) return simplify([start.anchor, ...path, goal.anchor]);
  }
  return [a, b];
}
