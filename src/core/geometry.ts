import type { Diagnostic } from "./diagnostics.js";
import type { NModel } from "./normalize.js";
import type { TextMetrics } from "./text/metrics.js";

/**
 * The geometry contract between layout, quality checks and rendering.
 *
 * Units are SVG user units (px). Origin is the top-left corner, y grows downward.
 * Layout produces a Diagram with every coordinate final; the renderer draws it
 * as-is and quality.ts measures exactly what will be drawn.
 */
export interface Point {
  x: number;
  y: number;
}

/** Offset from the immediate parent's centre, in diagram px (attributes only). */
export interface RelativePin { dx: number; dy: number }
export type Pin = Point | RelativePin;
export type Pins = Record<string, Pin>;

/** Axis-aligned box; (x, y) is the top-left corner. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NodeKind = "entity" | "relationship" | "attribute";

export interface DNode {
  /** Node id from normalize.ts ("E:...", "R:...", "A:..."). */
  id: string;
  kind: NodeKind;
  label: string;
  /** Bounding box of the shape (rectangle, diamond or ellipse). */
  box: Box;
  /** Weak entity (double rectangle) or identifying relationship (double diamond). */
  double: boolean;
  attr?: {
    key: boolean;
    partial: boolean;
    multivalued: boolean;
    derived: boolean;
  };
  /** True when the position came from a pin. */
  pinned?: boolean;
}

export type EdgeKind = "end" | "attribute" | "part";

export interface DEdge {
  id: string;
  kind: EdgeKind;
  /** Node ids. For "end" edges `from` is the relationship and `to` the entity. */
  from: string;
  to: string;
  /** Polyline from the boundary of `from` to the boundary of `to`. */
  points: Point[];
  /** Total participation of a weak entity in its identifying relationship: drawn as two parallel lines. */
  double: boolean;
  /** For "end" edges: the end id from normalize.ts ("REL#0"). */
  end?: string;
}

export type LabelKind = "cardinality" | "role";

export interface DLabel {
  id: string;
  kind: LabelKind;
  text: string;
  /** Box the text occupies; the renderer centers the text in it. */
  box: Box;
  /** Edge the label belongs to. */
  edge: string;
}

export interface Diagram {
  /** Top-left of the canvas in diagram coordinates; defaults to { x: 0, y: 0 }. */
  origin?: Point;
  width: number;
  height: number;
  title?: string;
  nodes: DNode[];
  edges: DEdge[];
  labels: DLabel[];
  notes: string[];
  meta: { engine: string };
}

export interface LayoutOptions {
  engine?: "layered" | "stress" | "simple";
  /** Absolute entity/relationship centres; attribute pins may be parent-relative offsets. */
  pins?: Pins;
  /**
   * Soft positions from the previous layout (node id → center). When present, the engine runs
   * incrementally: nodes keep these positions, only new, moved or colliding nodes are placed.
   */
  positions?: Record<string, Point>;
  seed?: number;
}

export interface LayoutResult {
  diagram: Diagram;
  diagnostics: Diagnostic[];
}

export type LayoutEngine = (model: NModel, metrics: TextMetrics, options: LayoutOptions) => Promise<LayoutResult>;

export const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export const boxAround = (c: Point, w: number, h: number): Box => ({ x: c.x - w / 2, y: c.y - h / 2, w, h });

export const intersects = (a: Box, b: Box, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Point where the ray from the shape's center toward `toward` leaves the shape outline.
 * Rectangles for entities, diamonds for relationships, ellipses for attributes.
 */
export function anchor(node: Pick<DNode, "kind" | "box">, toward: Point): Point {
  const c = center(node.box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const a = node.box.w / 2;
  const b = node.box.h / 2;
  let t: number;
  if (node.kind === "entity") {
    t = Math.min(dx !== 0 ? a / Math.abs(dx) : Infinity, dy !== 0 ? b / Math.abs(dy) : Infinity);
  } else if (node.kind === "relationship") {
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  } else {
    t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}
