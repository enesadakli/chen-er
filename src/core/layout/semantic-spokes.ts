import { anchor, boxAround, center, intersects, type DEdge, type DLabel, type DNode, type Point } from "../geometry.js";
import type { EndPort } from "./anchors.js";
import { edgesOverlap, visibleEdgePaths } from "./semantic-edges.js";
import { boxShape, distance, segmentThrough, segments } from "./shapes.js";

export function straightSpoke(edge: DEdge, nodes: DNode[]): Point[] {
  const from = nodes.find((n) => n.id === edge.from)!, to = nodes.find((n) => n.id === edge.to)!;
  return [anchor(from, center(to.box)), anchor(to, center(from.box))];
}

/** Move free ovals to clear radial spokes rather than bending an attribute edge. */
export function repairAttributeSpokes(nodes: DNode[], edges: DEdge[], ports: Map<string, EndPort>, labels: DLabel[] = []): boolean {
  let moved = false;
  for (const edge of edges.filter((e) => e.kind !== "end")) {
    const parent = nodes.find((n) => n.id === edge.from)!, oval = nodes.find((n) => n.id === edge.to)!;
    edge.points = straightSpoke(edge, nodes);
    if (oval.pinned || clear(oval, edge.points)) continue;
    const p = center(parent.box), original = center(oval.box), preferred = Math.atan2(original.y - p.y, original.x - p.x);
    const radius = Math.max(distance(p, original), parent.box.w / 2 + 90);
    const angles = Array.from({ length: 72 }, (_, i) => preferred + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 36);
    search: for (let ring = 0; ring < 8; ring++) for (const angle of angles) {
      const target = { x: Math.round(p.x + Math.cos(angle) * (radius + ring * 40)), y: Math.round(p.y + Math.sin(angle) * (radius + ring * 40)) };
      const candidate = { ...oval, box: boxAround(target, oval.box.w, oval.box.h) };
      const points = [anchor(parent, target), anchor(candidate, p)];
      if (!clear(candidate, points)) continue;
      oval.box = candidate.box;
      edge.points = points;
      moved = true;
      break search;
    }
    function clear(candidate: DNode, points: Point[]): boolean {
      const [a, b] = points as [Point, Point];
      if (nodes.some((n) => n.id !== oval.id && intersects(candidate.box, n.box, 14))) return false;
      if (nodes.some((n) => n.id !== parent.id && n.id !== oval.id && segmentThrough(a, b, n))) return false;
      if (labels.some((l) => intersects(candidate.box, l.box, 3) || segmentThrough(a, b, boxShape({ x: l.box.x - 3, y: l.box.y - 3, w: l.box.w + 6, h: l.box.h + 6 })))) return false;
      if ([...ports.entries()].some(([id, port]) => edges.find((e) => e.id === id)?.to === parent.id && distance(a, port.anchor) < 14)) return false;
      const spoke = { ...edge, points };
      for (const other of edges.filter((e) => e !== edge && e.from !== oval.id)) {
        const updated = other.kind === "end" ? other : { ...other, points: straightSpoke(other, nodes) };
        if (edgesOverlap(spoke, updated)) return false;
        if (visibleEdgePaths(updated).flatMap(segments).some(([a, b]) => segmentThrough(a, b, boxShape({ x: candidate.box.x - 6, y: candidate.box.y - 6, w: candidate.box.w + 12, h: candidate.box.h + 12 })))) return false;
      }
      return true;
    }
  }
  for (const edge of edges.filter((e) => e.kind !== "end")) edge.points = straightSpoke(edge, nodes);
  return moved;
}
