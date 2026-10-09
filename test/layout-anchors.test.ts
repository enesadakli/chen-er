import { describe, expect, it } from "vitest";
import { center, type DEdge, type DNode } from "../src/core/geometry.js";
import { fanEndAnchors, placeRecursive } from "../src/core/layout/anchors.js";
import { routeEdge } from "../src/core/layout/route.js";
import { parseModel } from "../src/core/normalize.js";
import { orthogonalPath } from "../src/core/layout/semantic-edges.js";
import { distance, segmentIntersection } from "../src/core/layout/shapes.js";

const entity: DNode = { id: "E:HUB", kind: "entity", label: "Hub", box: { x: 300, y: 300, w: 110, h: 46 }, double: false };
const diamond = (id: string, x: number, y: number): DNode => ({ id, kind: "relationship", label: id, box: { x, y, w: 110, h: 64 }, double: false });
const end = (from: string, id = from): DEdge => ({ id, from, to: entity.id, kind: "end", points: [], double: false });

describe("fanned end anchors", () => {
  it("spaces a crowded side by at least 28px and spills to an adjacent side", () => {
    const nodes = [entity, ...Array.from({ length: 6 }, (_, i) => diamond(`R:${i}`, 600, 100 + i * 60))];
    const edges = nodes.slice(1).map((n) => end(n.id));
    const ports = fanEndAnchors(nodes, edges);
    const right = [...ports.values()].filter((p) => p.normal.x === 1);
    expect(right).toHaveLength(2);
    expect(distance(right[0]!.anchor, right[1]!.anchor)).toBeGreaterThanOrEqual(28);
    expect([...ports.values()].every((p) => p.normal.x !== -1)).toBe(true);
    const all = [...ports.values()];
    for (let i = 0; i < all.length; i++) for (const other of all.slice(i + 1)) {
      expect(distance(all[i]!.anchor, other.anchor)).toBeGreaterThanOrEqual(28);
    }
    for (const normal of [{ x: 0, y: -1 }, { x: 0, y: 1 }]) {
      const side = [...ports.values()].filter((p) => p.normal.x === normal.x && p.normal.y === normal.y);
      for (let i = 1; i < side.length; i++) expect(distance(side[i - 1]!.anchor, side[i]!.anchor)).toBeGreaterThanOrEqual(28);
    }
  });
  it("orders ports by the other endpoint and ignores input order", () => {
    const nodes = [entity, diamond("R:TOP", 600, 250), diamond("R:BOTTOM", 600, 350)];
    const edges = [end("R:BOTTOM"), end("R:TOP")];
    const first = fanEndAnchors(nodes, edges), second = fanEndAnchors(nodes, [...edges].reverse());
    expect(first.get("R:TOP")!.anchor.y).toBeLessThan(first.get("R:BOTTOM")!.anchor.y);
    expect([...first]).toEqual([...second]);
  });
  it("adds perimeter for a hub that fills every side without moving its center", () => {
    const hub = { ...entity, box: { ...entity.box }, pinned: true };
    const nodes = [hub, ...Array.from({ length: 20 }, (_, i) => diamond(`R:${i}`, 600, 100 + i * 60))];
    const ports = fanEndAnchors(nodes, nodes.slice(1).map((n) => end(n.id)));
    expect(ports.size).toBe(20);
    expect(center(hub.box)).toEqual(center(entity.box));
    for (const side of [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]) {
      const anchors = [...ports.values()].filter((p) => p.normal.x === side.x && p.normal.y === side.y);
      for (let i = 0; i < anchors.length; i++) for (const other of anchors.slice(i + 1)) {
        expect(distance(anchors[i]!.anchor, other.anchor)).toBeGreaterThanOrEqual(28);
      }
    }
  });
  it("routes recursive ends orthogonally to distinct anchors on the same side", () => {
    const model = parseModel("version: 1\nentities:\n  HUB: {}\nrelationships:\n  LOOP:\n    ends: [{entity: HUB, role: parent, card: 0..N}, {entity: HUB, role: child, card: 0..1}]\n").model!;
    const nodes = [{ ...entity, box: { ...entity.box } }, diamond("R:LOOP", 700, 100)];
    placeRecursive(model, nodes);
    expect(center(nodes[1]!.box).x).toBe(center(entity.box).x);
    const edges = [end("R:LOOP", "parent"), end("R:LOOP", "child")];
    const ports = fanEndAnchors(nodes, edges);
    expect(ports.get("parent")!.normal).toEqual(ports.get("child")!.normal);
    expect(distance(ports.get("parent")!.anchor, ports.get("child")!.anchor)).toBeGreaterThanOrEqual(28);
    for (const e of edges) e.points = routeEdge(e, nodes, [], 0, [], { endPort: ports.get(e.id) });
    expect(edges.every((e) => orthogonalPath(e.points))).toBe(true);
    expect(segmentIntersection(edges[0]!.points[0]!, edges[0]!.points[1]!, edges[1]!.points[0]!, edges[1]!.points[1]!)).toBeUndefined();
  });
  it("keeps a pinned recursive diamond exact", () => {
    const model = parseModel("version: 1\nentities:\n  HUB: {}\nrelationships:\n  LOOP:\n    ends: [{entity: HUB, card: 0..N}, {entity: HUB, card: 0..1}]\n").model!;
    const pinned = { ...diamond("R:LOOP", 700, 100), pinned: true };
    placeRecursive(model, [entity, pinned]);
    expect(pinned.box).toEqual({ x: 700, y: 100, w: 110, h: 64 });
  });
  it("routes an attribute away from a reserved end anchor", () => {
    const attribute: DNode = { id: "A:HUB.Code", kind: "attribute", label: "Code", box: { x: 600, y: 306, w: 80, h: 34 }, double: false };
    const edge: DEdge = { id: "attribute", kind: "attribute", from: entity.id, to: attribute.id, points: [], double: false };
    const reserved = { x: 410, y: 323 };
    const points = routeEdge(edge, [entity, attribute], [], 0, [], { reservedAnchors: [reserved] });
    expect(distance(points[0]!, reserved)).toBeGreaterThanOrEqual(14);
  });
});
