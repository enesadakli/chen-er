import { absolutePins, attributeParents } from "../pins.js";
import { boxAround, intersects, type Box, type LayoutEngine, type LayoutOptions, type LayoutResult, type Pins, type Point } from "../geometry.js";
import { flattenAttrs, type NModel } from "../normalize.js";
import { attributeSize, entitySize, relationshipSize } from "../style.js";
import { assessQuality } from "../quality.js";
import { boxGap, MIN_OVAL_LABEL_CLEARANCE } from "./semantic-clearance.js";
import type { TextMetrics } from "../text/metrics.js";

/**
 * Incremental layout: keep the previous drawing and change as little as possible.
 *
 * Soft positions from the last accepted layout are handed to the engine as temporary pins, so
 * every node that was not touched stays exactly where it was. Only these are released:
 * - nodes the user moved (a real pin that differs from the soft position) keep their new pin,
 *   and their attributes are re-placed around them;
 * - nodes that now collide with a moved node are pushed out of the way, the shortest distance;
 * - nodes without a soft position (new in the model) are placed by the engine;
 * - soft attributes that block every readable label slot may be re-placed, keeping real pins exact.
 * Real pins always win. Temporary pins are not reported as pins.
 */
const CLEARANCE = 36;
const ATTRIBUTE_HALO = 130;
const MAX_ROUNDS = 24;

export async function incrementalLayout(
  engine: LayoutEngine,
  model: NModel,
  metrics: TextMetrics,
  options: LayoutOptions,
): Promise<LayoutResult> {
  const pins = options.pins ?? {};
  const absolute = absolutePins(pins);
  const soft = options.positions ?? {};
  const sizes = shapeSizes(model, metrics);
  const owners = attributeParents(model);

  const moved = new Set<string>();
  for (const id of sizes.keys()) {
    if (id.startsWith("A:")) continue;
    const pin = absolute[id];
    const prev = soft[id];
    if (pin && (!prev || Math.hypot(pin.x - prev.x, pin.y - prev.y) > 1)) moved.add(id);
  }

  const fixed: Record<string, Point> = {};
  const attributePins: Pins = {};
  for (const id of sizes.keys()) {
    if (id.startsWith("A:")) continue;
    const p = absolute[id] ?? soft[id];
    if (p) fixed[id] = p;
  }

  // New shapes (no soft position, no pin) go to the nearest free spot next to their neighbours, so the
  // engine never has to search with everything else fixed (that search is slow and moves nothing useful).
  placeNewShapes(model, sizes, fixed, moved);

  // Push unpinned shapes out of the way of moved ones; whatever gets pushed counts as moved too.
  for (let round = 0, changed = true; changed && round < MAX_ROUNDS; round++) {
    changed = false;
    for (const mover of [...moved]) {
      const mc = fixed[mover];
      const ms = sizes.get(mover);
      if (!mc || !ms) continue;
      const mBox = boxAround(mc, ms.w, ms.h);
      for (const [id, c] of Object.entries(fixed)) {
        if (id === mover || pins[id] || id.startsWith("A:")) continue;
        const s = sizes.get(id)!;
        if (!intersects(mBox, boxAround(c, s.w, s.h), CLEARANCE)) continue;
        fixed[id] = pushAway(mBox, c, s, CLEARANCE);
        moved.add(id);
        changed = true;
      }
    }
  }

  // Attributes stay put unless their owner moved or a moved shape now sits on them.
  const movedArea = [...moved].map((id) => {
    const s = sizes.get(id)!;
    const c = fixed[id]!;
    return boxAround(c, s.w + 2 * ATTRIBUTE_HALO, s.h + 2 * ATTRIBUTE_HALO);
  });
  for (const [id, owner] of owners) {
    if (pins[id]) {
      attributePins[id] = pins[id]!;
      continue;
    }
    const prev = soft[id];
    if (!prev || releasedAncestor(id, owners, moved)) continue;
    const s = sizes.get(id)!;
    const box = boxAround(prev, s.w, s.h);
    if (movedArea.some((area) => intersects(area, box)) && !moved.has(owner)) continue;
    fixed[id] = prev;
  }

  let result = await engine(model, metrics, { ...options, pins: { ...fixed, ...attributePins }, positions: undefined });
  // Saved attribute positions are soft: release only a blocking oval when fixed geometry has no label slot.
  // Real pins and every entity/relationship position remain fixed during these retries.
  let quality = assessQuality(result.diagram, pins, model);
  if (quality.spokeLabelViolations) {
    const ends = new Map(result.diagram.edges.filter((e) => e.kind === "end").map((e) => [e.id, e.to]));
    const blockedOwners = new Set(result.diagram.labels.filter((l) => result.diagram.nodes.some((n) =>
      n.kind === "attribute" && boxGap(n.box, l.box) < MIN_OVAL_LABEL_CLEARANCE)).map((l) => ends.get(l.edge)));
    const hard = ["diagonalEnds", "overlaps", "shapeCrossings", "labelCollisions", "labelAmbiguity", "labelLoose", "labelOnOwnEdge", "labelOnAnyEdge", "pinDrift", "attributeEdgeBends", "edgeOverlap", "tinySegments", "endPortCrowding", "diamondVertexViolations", "doubleEdgeArtifacts", "edgeCrossings", "spokeEdgeViolations", "hierarchyViolations"] as const;
    for (const [id, owner] of owners) {
      if (pins[id] || !fixed[id] || !blockedOwners.has(owner)) continue;
      const released = { ...fixed };
      delete released[id];
      const candidate = await engine(model, metrics, { ...options, pins: { ...released, ...attributePins }, positions: undefined });
      const next = assessQuality(candidate.diagram, pins, model);
      if (next.spokeLabelViolations >= quality.spokeLabelViolations || hard.some((key) => next[key] > quality[key])) continue;
      delete fixed[id];
      result = candidate;
      quality = next;
      if (!quality.spokeLabelViolations) break;
    }
  }
  for (const n of result.diagram.nodes) n.pinned = !!pins[n.id];
  result.diagnostics = result.diagnostics.filter((d) => d.rule !== "pin-conflict" || mentionsRealPin(d.message, pins));
  return result;
}

function placeNewShapes(
  model: NModel,
  sizes: Map<string, { w: number; h: number }>,
  fixed: Record<string, Point>,
  moved: Set<string>,
): void {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const r of model.relationships) {
    for (const end of r.ends) {
      link(r.id, `E:${end.entity}`);
      link(`E:${end.entity}`, r.id);
    }
  }
  const halo = (id: string) => {
    const s = sizes.get(id)!;
    const hasAttrs = [...sizes.keys()].some((k) => k.startsWith(`A:${id.slice(2)}.`));
    const pad = hasAttrs ? ATTRIBUTE_HALO : CLEARANCE;
    return { w: s.w + 2 * pad, h: s.h + 2 * pad };
  };
  const free = (id: string, c: Point) => {
    const h = halo(id);
    const box = boxAround(c, h.w, h.h);
    return Object.entries(fixed).every(([other, p]) => {
      if (other.startsWith("A:")) return true;
      const o = halo(other);
      return !intersects(box, boxAround(p, o.w - 2 * CLEARANCE, o.h - 2 * CLEARANCE));
    });
  };
  const pending = [...model.entities.map((e) => e.id), ...model.relationships.map((r) => r.id)].filter((id) => !fixed[id]);
  for (const id of pending) {
    const known = [...(neighbours.get(id) ?? [])].map((n) => fixed[n]).filter((p): p is Point => !!p);
    const all = Object.values(fixed);
    const start: Point = known.length
      ? { x: known.reduce((a, p) => a + p.x, 0) / known.length, y: known.reduce((a, p) => a + p.y, 0) / known.length }
      : all.length
        ? { x: Math.max(...all.map((p) => p.x)) + 2 * ATTRIBUTE_HALO, y: all.reduce((a, p) => a + p.y, 0) / all.length }
        : { x: 0, y: 0 };
    let spot: Point | undefined;
    for (let r = 0; r <= 2400 && !spot; r += 48) {
      const steps = r === 0 ? 1 : Math.max(8, Math.round(r / 24));
      for (let i = 0; i < steps && !spot; i++) {
        const a = (i / steps) * 2 * Math.PI;
        const c = { x: Math.round((start.x + Math.cos(a) * r) / 8) * 8, y: Math.round((start.y + Math.sin(a) * r) / 8) * 8 };
        if (free(id, c)) spot = c;
      }
    }
    if (!spot) continue;
    fixed[id] = spot;
    moved.add(id);
  }
}

function shapeSizes(model: NModel, m: TextMetrics): Map<string, { w: number; h: number }> {
  const sizes = new Map<string, { w: number; h: number }>();
  for (const e of model.entities) sizes.set(e.id, entitySize(e.label, m));
  for (const r of model.relationships) sizes.set(r.id, relationshipSize(r.label, m));
  const attrs = [...model.entities.flatMap((e) => flattenAttrs(e.attrs)), ...model.relationships.flatMap((r) => flattenAttrs(r.attrs))];
  for (const a of attrs) sizes.set(a.id, attributeSize(a.label, m));
  return sizes;
}

/** True when the attribute's owner chain reaches a moved shape. */
function releasedAncestor(id: string, owners: Map<string, string>, moved: Set<string>): boolean {
  for (let cur = owners.get(id); cur; cur = owners.get(cur)) if (moved.has(cur)) return true;
  return false;
}

/** Smallest axis move that separates `c` (size s) from box b with the clearance. */
function pushAway(b: Box, c: Point, s: { w: number; h: number }, gap: number): Point {
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const needX = (b.w + s.w) / 2 + gap - Math.abs(c.x - bc.x);
  const needY = (b.h + s.h) / 2 + gap - Math.abs(c.y - bc.y);
  const sx = c.x >= bc.x ? 1 : -1;
  const sy = c.y >= bc.y ? 1 : -1;
  const snap = (v: number) => Math.round(v / 8) * 8;
  return needX <= needY ? { x: snap(c.x + sx * (needX + 1)), y: c.y } : { x: c.x, y: snap(c.y + sy * (needY + 1)) };
}

const mentionsRealPin = (message: string, pins: Pins) => Object.keys(pins).some((id) => message.includes(id));
