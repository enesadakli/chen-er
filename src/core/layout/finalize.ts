import type { DEdge, DLabel, DNode, LayoutResult } from "../geometry.js";
import { style } from "../style.js";

/**
 * Shared last step of every layout engine: shift everything so the drawing
 * starts at the margin (leaving room for the title band) and compute the canvas size.
 * Absolute pins disable the translation, including pins outside the canvas.
 * Notes are drawn by the renderer below `height`; it adds their band itself.
 */
export function finalize(input: {
  nodes: DNode[];
  edges: DEdge[];
  labels: DLabel[];
  title?: string;
  notes: string[];
  engine: string;
}): LayoutResult {
  const boxes = [...input.nodes.map((n) => n.box), ...input.labels.map((l) => l.box)];
  const points = input.edges.flatMap((e) => e.points);
  const minX = Math.min(...boxes.map((b) => b.x), ...points.map((p) => p.x));
  const minY = Math.min(...boxes.map((b) => b.y), ...points.map((p) => p.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w), ...points.map((p) => p.x));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h), ...points.map((p) => p.y));
  const top = style.margin + (input.title ? style.title.band : 0);
  const pinned = input.nodes.some((n) => n.pinned);
  const dx = pinned ? 0 : Number.isFinite(minX) ? style.margin - minX : style.margin;
  const dy = pinned ? 0 : Number.isFinite(minY) ? top - minY : top;

  for (const n of input.nodes) (n.box.x += dx), (n.box.y += dy);
  for (const l of input.labels) (l.box.x += dx), (l.box.y += dy);
  for (const e of input.edges) e.points = e.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));

  const width = Math.max(2 * style.margin, Number.isFinite(maxX) ? Math.ceil(maxX + dx + style.margin) : 0);
  const height = Math.max(top + style.margin, Number.isFinite(maxY) ? Math.ceil(maxY + dy + style.margin) : 0);
  return {
    diagram: {
      width,
      height,
      title: input.title,
      nodes: input.nodes,
      edges: input.edges,
      labels: input.labels,
      notes: input.notes,
      meta: { engine: input.engine },
    },
    diagnostics: [],
  };
}
