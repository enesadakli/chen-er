import { center, type Box, type DEdge, type DNode, type Diagram, type Point } from "../geometry.js";
import { FONT_FAMILY, style } from "../style.js";
import { interMetrics } from "../text/metrics.js";

/**
 * Diagram → SVG string. Draws the geometry exactly as given: no layout decisions here.
 * The only added space is the notes band under the diagram.
 */
export function renderSvg(d: Diagram): string {
  const c = style.colors;
  const notesH = d.notes.length ? d.notes.length * style.note.lineHeight + style.margin : 0;
  const width = d.width;
  const height = d.height + notesH;
  const { x: ox, y: oy } = d.origin ?? { x: 0, y: 0 };
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${ox} ${oy} ${width} ${height}" font-family="${FONT_FAMILY}">`,
    ox === 0 && oy === 0
      ? `<rect width="100%" height="100%" fill="${c.background}"/>`
      : `<rect x="${ox}" y="${oy}" width="${width}" height="${height}" fill="${c.background}"/>`,
    `<g fill="none" stroke="${c.ink}" stroke-width="${style.stroke}" stroke-linejoin="round">`,
  );
  for (const e of d.edges) out.push(edgeSvg(e));
  out.push(`</g>`);
  for (const n of d.nodes) out.push(nodeSvg(n));
  for (const l of d.labels) {
    const p = center(l.box);
    out.push(
      `<g data-id="${esc(l.id)}" class="er-label"><text x="${f(p.x)}" y="${f(p.y)}" font-size="${style.label.fontSize}" text-anchor="middle" dominant-baseline="central" fill="${l.kind === "role" ? c.muted : c.ink}"${l.kind === "role" ? ' font-style="italic"' : ""}>${esc(l.text)}</text></g>`,
    );
  }
  if (d.title) {
    out.push(
      `<g data-id="title" class="er-label"><text x="${ox + style.margin}" y="${oy + style.margin + style.title.fontSize}" font-size="${style.title.fontSize}" font-weight="700" fill="${c.ink}">${esc(d.title)}</text></g>`,
    );
  }
  d.notes.forEach((note, i) => {
    const y = oy + d.height + style.margin / 2 + (i + 0.7) * style.note.lineHeight;
    out.push(`<g data-id="note:${i}" class="er-label"><text x="${ox + style.margin}" y="${f(y)}" font-size="${style.note.fontSize}" fill="${c.muted}">${esc(note)}</text></g>`);
  });
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

function edgeSvg(e: DEdge): string {
  const group = `<g data-id="${esc(e.id)}" class="er-edge">`;
  if (!e.double) return `${group}<polyline points="${pts(e.points)}"/></g>`;
  const g = style.doubleEdgeGap / 2;
  return `${group}<polyline points="${pts(offset(e.points, g))}"/><polyline points="${pts(offset(e.points, -g))}"/></g>`;
}

function nodeSvg(n: DNode): string {
  const c = style.colors;
  const b = n.box;
  const stroke = `stroke="${c.ink}" stroke-width="${style.stroke}"`;
  const parts: string[] = [`<g data-id="${esc(n.id)}" class="er-${n.kind}">`];
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
      const w = interMetrics.width(n.label, style.attribute.fontSize, style.attribute.weight);
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
  const normals = ps.slice(1).map((p, i) => {
    const a = ps[i]!;
    const length = Math.hypot(p.x - a.x, p.y - a.y);
    return length ? { x: -(p.y - a.y) / length, y: (p.x - a.x) / length } : undefined;
  });
  return ps.map((p, i) => {
    const before = normals.slice(0, i).reverse().find((n) => n !== undefined);
    const after = normals.slice(i).find((n) => n !== undefined);
    const a = before ?? after ?? { x: 0, y: 0 };
    const b = after ?? a;
    const denominator = 1 + a.x * b.x + a.y * b.y;
    // Reversing segments have no finite miter; keep the incoming offset.
    const shift = denominator > 1e-6
      ? { x: (a.x + b.x) * d / denominator, y: (a.y + b.y) * d / denominator }
      : { x: a.x * d, y: a.y * d };
    return { x: p.x + shift.x, y: p.y + shift.y };
  });
}

const pts = (ps: Point[]) => ps.map((p) => `${f(p.x)},${f(p.y)}`).join(" ");
const f = (n: number) => (Math.round(n * 10) / 10).toString();
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
