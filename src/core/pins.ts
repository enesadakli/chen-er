import { center, type Diagram, type Pin, type Pins, type Point, type RelativePin } from "./geometry.js";
import type { NAttribute, NModel } from "./normalize.js";

export const isRelativePin = (pin: Pin): pin is RelativePin => "dx" in pin;
export const pinPoint = (pin: Pin, parent: Point): Point => isRelativePin(pin)
  ? { x: parent.x + pin.dx, y: parent.y + pin.dy } : pin;
export const absolutePins = (pins: Pins): Record<string, Point> =>
  Object.fromEntries(Object.entries(pins).filter((entry): entry is [string, Point] => !isRelativePin(entry[1])));

/** Model ownership is authoritative, including composites and relationship attributes. */
export function attributeParents(model: NModel): Map<string, string> {
  const parents = new Map<string, string>();
  const visit = (attrs: readonly NAttribute[], parent: string) => {
    for (const attr of attrs) {
      parents.set(attr.id, parent);
      visit(attr.parts, attr.id);
    }
  };
  for (const owner of [...model.entities, ...model.relationships]) visit(owner.attrs, owner.id);
  return parents;
}

/** Convert legacy centres using the displayed parent, preserving subpixel precision. */
export function relativeAttributePins(pins: Pins, diagram?: Diagram): Pins {
  const parents = new Map(diagram?.edges.filter((e) => e.kind !== "end").map((e) => [e.to, e.from]));
  const centres = new Map(diagram?.nodes.map((n) => [n.id, center(n.box)]));
  return Object.fromEntries(Object.entries(pins).map(([id, pin]) => {
    if (!id.startsWith("A:") || isRelativePin(pin)) return [id, pin];
    const parent = centres.get(parents.get(id) ?? "");
    // Orphan pins cannot affect the current drawing and are kept until their node returns.
    if (!parent && diagram && !centres.has(id)) return [id, pin];
    if (!parent) throw new Error(`Current diagram required to convert attribute pin ${id}.`);
    return [id, { dx: pin.x - parent.x, dy: pin.y - parent.y }];
  }));
}
