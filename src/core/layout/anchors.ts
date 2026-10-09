import { boxAround, center, intersects, type DEdge, type DNode, type Point } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { distance } from "./shapes.js";

export interface EndPort { anchor: Point; normal: Point; recursive?: { index: number; count: number } }
type Side = "top" | "right" | "bottom" | "left";
const sides: Side[] = ["top", "right", "bottom", "left"];
const normal = (side: Side): Point => ({ x: side === "right" ? 1 : side === "left" ? -1 : 0, y: side === "bottom" ? 1 : side === "top" ? -1 : 0 });
const horizontal = (side: Side) => side === "top" || side === "bottom";
const spacing = (side: Side) => horizontal(side) ? 48 : 28;

/** Keep recursive diamonds beside their owner, with enough space for both roles. */
export function placeRecursive(model: NModel, nodes: DNode[]): void {
  for (const r of model.relationships) {
    if (!r.ends.every((e) => e.entity === r.ends[0]!.entity)) continue;
    const diamond = nodes.find((n) => n.id === r.id)!, entity = nodes.find((n) => n.id === `E:${r.ends[0]!.entity}`);
    if (!entity || diamond.pinned) continue;
    const c = center(entity.box), original = center(diamond.box);
    const candidates = [-1, 1].flatMap((sign) => [155, 195, 235].map((gap) => ({ x: c.x, y: c.y + sign * (entity.box.h / 2 + diamond.box.h / 2 + gap) })));
    const neighbours = model.relationships.filter((other) => other !== r && other.ends.some((end) => `E:${end.entity}` === entity.id)).map((other) => center(nodes.find((n) => n.id === other.id)!.box));
    const score = (p: Point) => neighbours.filter((other) => (other.y - c.y) * (p.y - c.y) > 0).length * 10000 + distance(p, original);
    candidates.sort((a, b) => score(a) - score(b));
    for (const p of candidates) {
      const box = boxAround(p, diamond.box.w, diamond.box.h);
      if (nodes.some((n) => n !== entity && n !== diamond && intersects(box, n.box, 28))) continue;
      diamond.box = box;
      break;
    }
  }
}

export function recursiveDeparture(from: DNode, to: DNode, port: EndPort): EndPort | undefined {
  if (!port.recursive) return undefined;
  const c = center(from.box), target = center(to.box);
  const fraction = (port.recursive.index + 1) / (port.recursive.count + 1) * 2 - 1;
  if (port.normal.y) {
    const sign = Math.sign(target.y - c.y);
    const x = fraction * from.box.w / 2;
    return { anchor: { x: c.x + x, y: c.y + sign * from.box.h / 2 * (1 - Math.abs(fraction)) }, normal: { x: 0, y: sign } };
  }
  const sign = Math.sign(target.x - c.x);
  return { anchor: { x: c.x + sign * from.box.w / 2 * (1 - Math.abs(fraction)), y: c.y + fraction * from.box.h / 2 }, normal: { x: sign, y: 0 } };
}

/** Align a binary diamond with its crowded horizontal entity end before routing. */
export function alignDiamondPorts(nodes: DNode[], edges: DEdge[], ports: Map<string, EndPort>): void {
  for (const diamond of nodes.filter((n) => n.kind === "relationship" && !n.pinned)) {
    const ends = edges.filter((e) => e.kind === "end" && e.from === diamond.id);
    if (ends.length !== 2 || ends[0]!.to === ends[1]!.to) continue;
    const owners = ends.map((e) => nodes.find((n) => n.id === e.to)!);
    if (Math.abs(center(owners[0]!.box).y - center(owners[1]!.box).y) > 1e-6) continue;
    if (edges.filter((e) => e.kind === "end" && ends.some((end) => end.to === e.to)).some((e) => e.from !== diamond.id && ends.every((end) => edges.some((other) => other.from === e.from && other.to === end.to)))) continue;
    const crowded = ends.find((end) => {
      const port = ports.get(end.id)!;
      return port.normal.x && edges.filter((e) => e.to === end.to && ports.get(e.id)?.normal.x === port.normal.x).length > 1;
    });
    if (!crowded) continue;
    const y = ports.get(crowded.id)!.anchor.y, point = center(diamond.box);
    if (Math.abs(y - point.y) > 24) continue;
    const box = boxAround({ x: point.x, y }, diamond.box.w, diamond.box.h);
    if (!nodes.some((n) => n !== diamond && intersects(box, n.box, 18))) diamond.box = box;
  }
}

/** Allocate each entity's ports together; adjacent sides absorb a full side. */
export function fanEndAnchors(nodes: DNode[], edges: DEdge[]): Map<string, EndPort> {
  const result = new Map<string, EndPort>();
  for (const entity of nodes.filter((n) => n.kind === "entity")) {
    const incoming = edges.filter((e) => e.kind === "end" && e.to === entity.id);
    const c = center(entity.box), b = entity.box, originalWidth = b.w;
    const verticalCapacity = Math.max(1, Math.floor((b.h - 18) / 28) + 1);
    const horizontalCapacity = Math.max(1, Math.ceil((incoming.length - 2 * verticalCapacity) / 2));
    // A larger perimeter is necessary once all four sides are full. Keep the
    // center exact, including for pinned nodes.
    const width = Math.max(b.w, incoming.length >= 6 ? 300 : 0, 18 + (horizontalCapacity - 1) * 48);
    b.x = c.x - width / 2;
    b.w = width;
    const groups = new Map(sides.map((s) => [s, [] as DEdge[]]));
    const capacity = (s: Side) => Math.max(1, Math.floor(((horizontal(s) ? b.w : b.h) - 18) / spacing(s)) + 1);
    const endpoint = (e: DEdge) => center(nodes.find((n) => n.id === e.from)!.box);
    const preferred = (e: DEdge): Side => {
      const p = endpoint(e), dx = p.x - c.x, dy = p.y - c.y;
      return Math.abs(dx) / originalWidth > Math.abs(dy) / b.h ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
    };
    // Reserve repeated ends first so their symmetric routes stay on one side.
    incoming.sort((a, d) => incoming.filter((e) => e.from === d.from).length - incoming.filter((e) => e.from === a.from).length || a.id.localeCompare(d.id));
    for (const e of incoming) {
      const wanted = preferred(e), index = sides.indexOf(wanted), p = endpoint(e);
      const adjacent = [sides[(index + 1) % 4]!, sides[(index + 3) % 4]!].sort((a, d) => {
        const score = (s: Side) => (p.x - c.x) * normal(s).x + (p.y - c.y) * normal(s).y;
        return score(d) - score(a);
      });
      const side = [wanted, ...adjacent, sides[(index + 2) % 4]!].find((s) => groups.get(s)!.length < capacity(s)) ?? wanted;
      groups.get(side)!.push(e);
    }
    for (const [side, group] of groups) {
      const n = normal(side);
      const recursiveGroup = group.length > 1 && group.every((e) => group.filter((other) => other.from === e.from).length > 1);
      const span = horizontal(side) ? (b.w >= 260 && (group.length === 2 || recursiveGroup) ? Math.min(b.w, 158) : b.w) : b.h;
      group.sort((a, d) => {
        const angle = (e: DEdge) => {
          const p = endpoint(e);
          return Math.atan2(horizontal(side) ? p.x - c.x : p.y - c.y, Math.abs((p.x - c.x) * n.x + (p.y - c.y) * n.y));
        };
        return angle(a) - angle(d) || a.id.localeCompare(d.id);
      });
      // Adapt corner clearance to the nearest port on the vertical side.
      // This preserves usable side length when the neighbouring side is empty.
      const corner = (adjacent: Side) => {
        const count = groups.get(adjacent)!.length;
        const separation = count === 1 ? b.h / 2 : count ? 9 : 28;
        return Math.max(9, Math.ceil(Math.sqrt(Math.max(0, 28 ** 2 - separation ** 2))));
      };
      const first = horizontal(side) && span === b.w ? corner("left") : 9;
      const last = horizontal(side) && span === b.w ? corner("right") : 9;
      const step = group.length > 1 ? (span - first - last) / (group.length - 1) : 0;
      group.forEach((e, i) => {
        const p = endpoint(e);
        const aligned = horizontal(side) ? p.x - c.x : 0;
        const offset = group.length > 1 ? -span / 2 + first + i * step : Math.max(-span / 2 + first, Math.min(span / 2 - last, aligned));
        const repeated = group.filter((other) => other.from === e.from).sort((a, b) => a.id.localeCompare(b.id));
        const recursive = repeated.length > 1 ? { index: repeated.indexOf(e), count: repeated.length } : undefined;
        result.set(e.id, { recursive, anchor: { x: c.x + n.x * b.w / 2 + (horizontal(side) ? offset : 0), y: c.y + n.y * b.h / 2 + (horizontal(side) ? 0 : offset) }, normal: n });
      });
    }
  }
  return result;
}
