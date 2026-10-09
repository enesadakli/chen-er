import { boxAround, intersects, type Box, type LayoutEngine, type LayoutOptions, type LayoutResult, type Point } from "../geometry.js";
import { flattenAttrs, type NAttribute, type NModel } from "../normalize.js";
import { attributeSize, entitySize, relationshipSize } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";

/**
 * Incremental layout: keep the previous drawing and change as little as possible.
 *
 * Soft positions from the last accepted layout are handed to the engine as temporary pins, so
 * every node that was not touched stays exactly where it was. Only these are released:
 * - nodes the user moved (a real pin that differs from the soft position) keep their new pin,
 *   and their attributes are re-placed around them;
 * - nodes that now collide with a moved node are pushed out of the way, the shortest distance;
 * - nodes without a soft position (new in the model) are placed by the engine.
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
  const soft = options.positions ?? {};
  const sizes = shapeSizes(model, metrics);
  const owners = attributeOwners(model);

  const moved = new Set<string>();
  for (const id of sizes.keys()) {
    if (id.startsWith("A:")) continue;
    const pin = pins[id];
    const prev = soft[id];
    if (pin && (!prev || Math.hypot(pin.x - prev.x, pin.y - prev.y) > 1)) moved.add(id);
  }

  const fixed: Record<string, Point> = {};
  for (const id of sizes.keys()) {
    if (id.startsWith("A:")) continue;
    const p = pins[id] ?? soft[id];
    if (p) fixed[id] = p;
  }

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
      fixed[id] = pins[id]!;
      continue;
    }
    const prev = soft[id];
    if (!prev || releasedAncestor(id, owners, moved)) continue;
    const s = sizes.get(id)!;
    const box = boxAround(prev, s.w, s.h);
    if (movedArea.some((area) => intersects(area, box)) && !moved.has(owner)) continue;
    fixed[id] = prev;
  }

  const result = await engine(model, metrics, { ...options, pins: fixed, positions: undefined });
  for (const n of result.diagram.nodes) n.pinned = !!pins[n.id];
  result.diagnostics = result.diagnostics.filter((d) => d.rule !== "pin-conflict" || mentionsRealPin(d.message, pins));
  return result;
}

function shapeSizes(model: NModel, m: TextMetrics): Map<string, { w: number; h: number }> {
  const sizes = new Map<string, { w: number; h: number }>();
  for (const e of model.entities) sizes.set(e.id, entitySize(e.label, m));
  for (const r of model.relationships) sizes.set(r.id, relationshipSize(r.label, m));
  const attrs = [...model.entities.flatMap((e) => flattenAttrs(e.attrs)), ...model.relationships.flatMap((r) => flattenAttrs(r.attrs))];
  for (const a of attrs) sizes.set(a.id, attributeSize(a.label, m));
  return sizes;
}

/** Attribute id → id of the node it hangs from (entity, relationship or parent attribute). */
function attributeOwners(model: NModel): Map<string, string> {
  const owners = new Map<string, string>();
  const visit = (attrs: readonly NAttribute[]) => {
    for (const a of attrs) {
      owners.set(a.id, a.parent ?? `${a.ownerKind === "entity" ? "E" : "R"}:${a.owner}`);
      visit(a.parts);
    }
  };
  for (const e of model.entities) visit(e.attrs);
  for (const r of model.relationships) visit(r.attrs);
  return owners;
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

const mentionsRealPin = (message: string, pins: Record<string, Point>) => Object.keys(pins).some((id) => message.includes(id));
