import type { FontWeight, TextMetrics } from "./text/metrics.js";

/**
 * Visual constants shared by layout (to size shapes) and rendering (to draw them).
 * Change sizes here, never in the renderer, so layout and drawing stay in sync.
 */
export const FONT_FAMILY = "Inter, Helvetica, Arial, sans-serif";

export const style = {
  entity: { fontSize: 16, weight: "bold" as FontWeight, padX: 22, height: 46, minWidth: 110, doubleInset: 5 },
  relationship: { fontSize: 14, weight: "bold" as FontWeight, padX: 26, height: 64, minWidth: 110, widthFactor: 1.5, doubleInset: 7 },
  attribute: { fontSize: 14, weight: "regular" as FontWeight, padX: 18, height: 34, minWidth: 64, doubleInset: 4 },
  label: { fontSize: 13, weight: "regular" as FontWeight, padX: 3, height: 18 },
  title: { fontSize: 20, weight: "bold" as FontWeight, band: 48 },
  note: { fontSize: 13, weight: "regular" as FontWeight, lineHeight: 20 },
  margin: 32,
  stroke: 1.5,
  doubleEdgeGap: 4,
  colors: {
    ink: "#1f2328",
    muted: "#57606a",
    entityFill: "#eef1f4",
    relationshipFill: "#eef1f4",
    attributeFill: "#ffffff",
    background: "#ffffff",
  },
} as const;

export interface ShapeSize {
  w: number;
  h: number;
}

export function entitySize(label: string, m: TextMetrics): ShapeSize {
  const s = style.entity;
  return { w: Math.max(s.minWidth, Math.ceil(m.width(label, s.fontSize, s.weight) + 2 * s.padX)), h: s.height };
}

export function relationshipSize(label: string, m: TextMetrics): ShapeSize {
  const s = style.relationship;
  const text = m.width(label, s.fontSize, s.weight);
  return { w: Math.max(s.minWidth, Math.ceil(text * s.widthFactor + 2 * s.padX)), h: s.height };
}

export function attributeSize(label: string, m: TextMetrics): ShapeSize {
  const s = style.attribute;
  return { w: Math.max(s.minWidth, Math.ceil(m.width(label, s.fontSize, s.weight) * 1.15 + 2 * s.padX)), h: s.height };
}

export function labelSize(text: string, m: TextMetrics): ShapeSize {
  const s = style.label;
  return { w: Math.ceil(m.width(text, s.fontSize, s.weight) + 2 * s.padX), h: s.height };
}

/** (min,max) label text as printed on the diagram. */
export const cardText = (min: number, max: number | "N") => `(${min},${max})`;
