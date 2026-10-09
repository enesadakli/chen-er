import { center, type Box, type DEdge, type DNode, type Diagram, type Point } from "../geometry.js";
import { FONT_FAMILY, style } from "../style.js";

/**
 * Diagram → SVG string. Draws the geometry exactly as given: no layout decisions here.
 * The only added space is the notes band under the diagram.
 */
export function renderSvg(d: Diagram): string {
  const c = style.colors;
  const notesH = d.notes.length ? d.notes.length * style.note.lineHeight + style.margin : 0;
  const width = d.width;
  const height = d.height + notesH;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">`,
    `<rect width="100%" height="100%" fill="${c.background}"/>`,
    `<g fill="none" stroke="${c.ink}" stroke-width="${style.stroke}" stroke-linejoin="round">`,
  );
  for (const e of d.edges) out.push(edgeSvg(e));
  out.push(`</g>`);
  for (const n of d.nodes) out.push(nodeSvg(n));
  for (const l of d.labels) {
    const p = center(l.box);
    out.push(
      `<text x="${f(p.x)}" y="${f(p.y)}" font-size="${style.label.fontSize}" text-anchor="middle" dominant-baseline="central" fill="${l.kind === "role" ? c.muted : c.ink}"${l.kind === "role" ? ' font-style="italic"' : ""}>${esc(l.text)}</text>`,
    );
  }
  if (d.title) {
    out.push(
      `<text x="${style.margin}" y="${style.margin + style.title.fontSize}" font-size="${style.title.fontSize}" font-weight="700" fill="${c.ink}">${esc(d.title)}</text>`,
    );
  }
  d.notes.forEach((note, i) => {
    const y = d.height + style.margin / 2 + (i + 0.7) * style.note.lineHeight;
    out.push(`<text x="${style.margin}" y="${f(y)}" font-size="${style.note.fontSize}" fill="${c.muted}">${esc(note)}</text>`);
  });
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

function edgeSvg(e: DEdge): string {
  if (!e.double) return `<polyline points="${pts(e.points)}"/>`;
  const g = style.doubleEdgeGap / 2;
  return `<polyline points="${pts(offset(e.points, g))}"/><polyline points="${pts(offset(e.points, -g))}"/>`;
}

function nodeSvg(n: DNode): string {
  const c = style.colors;
  const b = n.box;
  const stroke = `stroke="${c.ink}" stroke-width="${style.stroke}"`;
  const parts: string[] = [`<g data-id="${esc(n.id)}">`];
  if (n.kind === "entity") {
    parts.push(`<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="${c.entityFill}" ${stroke}/>`);
    if (n.double) parts.push(rectInset(b, style.entity.doubleInset, stroke));
    parts.push(text(n.label, center(b), style.entity.fontSize, 700));
  } else if (n.kind === "relationship") {
    parts.push(`<polygon points="${pts(diamond(b, 0))}" fill="${c.relationshipFill}" ${stroke}/>`);
    if (n.double) parts.push(`<polygon points="${pts(diamond(b, style.relationship.doubleInset))}" fill="none" ${stroke}/>`);
    parts.push(text(n.label, center(b), style.relationship.fontSize, 700));
  } else {
    const p = center(b);
    const dash = n.attr?.derived ? ' stroke-dasharray="5 4"' : "";
    parts.push(`<ellipse cx="${f(p.x)}" cy="${f(p.y)}" rx="${f(b.w / 2)}" ry="${f(b.h / 2)}" fill="${c.attributeFill}" ${stroke}${dash}/>`);
    if (n.attr?.multivalued) {
      const i = style.attribute.doubleInset;
      parts.push(`<ellipse cx="${f(p.x)}" cy="${f(p.y)}" rx="${f(b.w / 2 - i)}" ry="${f(b.h / 2 - i)}" fill="none" ${stroke}${dash}/>`);
    }
    parts.push(text(n.label, p, style.attribute.fontSize, 400));
    if (n.attr?.key || n.attr?.partial) {
      const w = estimateWidth(n.label, style.attribute.fontSize);
      const y = p.y + style.attribute.fontSize * 0.62;
      const dashU = n.attr.partial && !n.attr.key ? ' stroke-dasharray="4 3"' : "";
      parts.push(`<line x1="${f(p.x - w / 2)}" y1="${f(y)}" x2="${f(p.x + w / 2)}" y2="${f(y)}" stroke="${c.ink}" stroke-width="1.2"${dashU}/>`);
    }
  }
  parts.push(`</g>`);
  return parts.join("");
}

const text = (s: string, p: Point, size: number, weight: number) =>
  `<text x="${f(p.x)}" y="${f(p.y)}" font-size="${size}" font-weight="${weight}" text-anchor="middle" dominant-baseline="central" fill="${style.colors.ink}">${esc(s)}</text>`;

const rectInset = (b: Box, i: number, stroke: string) =>
  `<rect x="${f(b.x + i)}" y="${f(b.y + i)}" width="${f(b.w - 2 * i)}" height="${f(b.h - 2 * i)}" fill="none" ${stroke}/>`;

function diamond(b: Box, inset: number): Point[] {
  const c = center(b);
  const a = b.w / 2 - inset * (b.w / b.h);
  const h = b.h / 2 - inset;
  return [
    { x: c.x, y: c.y - h },
    { x: c.x + a, y: c.y },
    { x: c.x, y: c.y + h },
    { x: c.x - a, y: c.y },
  ];
}

/** Parallel copy of a polyline at distance d (left of travel direction). */
function offset(ps: Point[], d: number): Point[] {
  return ps.map((p, i) => {
    const a = ps[Math.max(0, i - 1)]!;
    const b = ps[Math.min(ps.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: p.x - ((b.y - a.y) / len) * d, y: p.y + ((b.x - a.x) / len) * d };
  });
}

/** Underline width; layout uses exact metrics, this only needs to be close. */
const estimateWidth = (s: string, size: number) => Math.max(8, s.length * size * 0.56);

const pts = (ps: Point[]) => ps.map((p) => `${f(p.x)},${f(p.y)}`).join(" ");
const f = (n: number) => (Math.round(n * 10) / 10).toString();
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
