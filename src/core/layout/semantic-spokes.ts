import { isRelativePin } from "../pins.js";
import { labelIntersectsLines } from "./label-geometry.js";
import { anchor, boxAround, center, intersects, type DEdge, type DLabel, type DNode, type Pins, type Point } from "../geometry.js";
import { attributeAnchors } from "./attributes.js";
import type { EndPort } from "./anchors.js";
import { MIN_ROUTE_SEGMENT, visibleEdgePaths } from "./semantic-edges.js";
import { boxShape, distance, segmentIntersection, segmentThrough, segments } from "./shapes.js";

export function straightSpoke(edge: DEdge, nodes: DNode[], radial = true): Point[] {
  const from = nodes.find((n) => n.id === edge.from)!, to = nodes.find((n) => n.id === edge.to)!;
  return attributeAnchors(from, to, radial);
}

/** Move free ovals to clear radial spokes rather than bending an attribute edge. */
export function repairAttributeSpokes(nodes: DNode[], edges: DEdge[], ports: Map<string, EndPort>, labels: DLabel[] = [], shorten = false, pins: Pins = {}): boolean {
  let moved = false;
  // Ovals move by replacing their box, so one lookup serves the whole repair.
  const byId = new Map<string, DNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const spokeOf = (e: DEdge) => attributeAnchors(byId.get(e.from)!, byId.get(e.to)!, !shorten);
  for (const edge of edges.filter((e) => e.kind !== "end")) {
    const parent = byId.get(edge.from)!, oval = byId.get(edge.to)!;
    // Nothing but this oval moves while its targets are tried, so the other routes are fixed.
    let fixed: { lines: [Point, Point][]; end: boolean }[] | undefined, portAnchors: Point[] | undefined;
    edge.points = spokeOf(edge);
    const originalClear = clear(oval, edge.points);
    // A composite's final centre anchors its relative parts; keep it fixed during clearance repair.
    const anchorsPart = edges.some((e) => e.kind === "part" && e.from === oval.id && pins[e.to] && isRelativePin(pins[e.to]!));
    if (oval.pinned || anchorsPart || (originalClear && (!shorten || distance(edge.points[0]!, edge.points[1]!) <= oval.box.h * 2.5))) continue;
    const p = center(parent.box), original = center(oval.box), preferred = Math.atan2(original.y - p.y, original.x - p.x);
    const radius = Math.max(distance(p, original), parent.box.w / 2 + 90);
    const angles = Array.from({ length: 72 }, (_, i) => preferred + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 36);
    const targets: Point[] = [];
    if (shorten) for (let ring = 0; ring < 3; ring++) {
      const gap = 36 + ring * 24;
      for (const angle of angles) {
        const ownerRadius = distance(p, anchor(parent, { x: p.x + Math.cos(angle), y: p.y + Math.sin(angle) }));
        const ovalRadius = 1 / Math.sqrt((Math.cos(angle) / (oval.box.w / 2)) ** 2 + (Math.sin(angle) / (oval.box.h / 2)) ** 2);
        const r = ownerRadius + ovalRadius + gap;
        targets.push({ x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r });
      }
      if (parent.kind === "entity") for (let x = parent.box.x + 12; x <= parent.box.x + parent.box.w - 12; x += 12) {
        targets.push({ x, y: parent.box.y - oval.box.h / 2 - gap }, { x, y: parent.box.y + parent.box.h + oval.box.h / 2 + gap });
      }
    }
    if (!originalClear) for (let ring = 0; ring < 8; ring++) for (const angle of angles) targets.push({ x: p.x + Math.cos(angle) * (radius + ring * 40), y: p.y + Math.sin(angle) * (radius + ring * 40) });
    for (const point of targets) {
      const target = { x: Math.round(point.x), y: Math.round(point.y) };
      const candidate = { ...oval, box: boxAround(target, oval.box.w, oval.box.h) };
      const points = attributeAnchors(parent, candidate, !shorten);
      if (originalClear && distance(points[0]!, points[1]!) >= distance(edge.points[0]!, edge.points[1]!) - 1e-6) continue;
      if (!clear(candidate, points)) continue;
      oval.box = candidate.box;
      edge.points = points;
      moved = true;
      break;
    }
    function clear(candidate: DNode, points: Point[]): boolean {
      const [a, b] = points as [Point, Point];
      // A spoke shorter than the route minimum counts as a tiny segment.
      if (distance(a, b) < MIN_ROUTE_SEGMENT) return false;
      if (nodes.some((n) => n.id !== oval.id && intersects(candidate.box, n.box, 14))) return false;
      if (nodes.some((n) => n.id !== parent.id && n.id !== oval.id && segmentThrough(a, b, n))) return false;
      if (labels.some((l) => intersects(candidate.box, l.box, 3) || labelIntersectsLines(l.box, [[a, b]], 3))) return false;
      portAnchors ??= [...ports.entries()].filter(([id]) => edges.find((e) => e.id === id)?.to === parent.id).map(([, port]) => port.anchor);
      if (portAnchors.some((anchor) => distance(a, anchor) < 14)) return false;
      fixed ??= edges.filter((e) => e !== edge && e.from !== oval.id).map((other) => {
        const updated = other.kind === "end" ? other : { ...other, points: spokeOf(other) };
        return { lines: visibleEdgePaths(updated).flatMap(segments), end: updated.kind === "end" };
      });
      const spoke = visibleEdgePaths({ ...edge, points }).flatMap(segments);
      const halo = boxShape({ x: candidate.box.x - 6, y: candidate.box.y - 6, w: candidate.box.w + 12, h: candidate.box.h + 12 });
      for (const other of fixed) {
        if (spoke.some(([p, q]) => other.lines.some(([r, s]) => segmentIntersection(p, q, r, s) === "overlap"))) return false;
        if (shorten && other.end && other.lines.some(([p, q]) => segmentIntersection(a, b, p, q))) return false;
        if (other.lines.some(([a, b]) => segmentThrough(a, b, halo))) return false;
      }
      return true;
    }
  }
  for (const edge of edges.filter((e) => e.kind !== "end")) edge.points = spokeOf(edge);
  return moved;
}
