import { describe, expect, it } from "vitest";
import type { DEdge, Diagram, Point } from "../src/core/geometry.js";
import { renderSvg } from "../src/core/render/svg.js";
import { style } from "../src/core/style.js";

const diagram = (): Diagram => ({
  width: 400, height: 400, notes: [], nodes: [], edges: [], labels: [], meta: { engine: "test" },
});
const group = (svg: string, id: string) => svg.match(new RegExp(`<g data-id="${id}"[^>]*>(.*?)</g>`))![1]!;

function subsetEdge(toward: Point): DEdge {
  return { id: "edge:S:Person#Student", kind: "end", from: "S:Person", to: "E:Student", double: false,
    points: [{ x: 40, y: 40 }, { x: 160, y: 160 }], subset: { at: { x: 100, y: 100 }, toward } };
}

describe("EER SVG geometry", () => {
  it.each(["d", "o"] as const)("draws a centered %s circle in the supplied box", (symbol) => {
    const d = diagram();
    d.nodes.push({ id: "S:Person", kind: "specialization", label: "Ignored label", double: false,
      box: { x: 41, y: 67, w: 30, h: 30 }, specialization: { symbol } });
    const svg = renderSvg(d);
    expect(svg).toContain('<g data-id="S:Person" class="er-specialization">');
    expect(group(svg, "S:Person")).toBe(`<circle cx="56" cy="82" r="15" fill="${style.colors.attributeFill}" stroke="${style.colors.ink}" stroke-width="${style.stroke}"/><text x="56" y="82" font-size="${style.specialization.fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${style.colors.ink}">${symbol}</text>`);
  });

  it.each([undefined, {}])("keeps a symbol-free specialization group empty (%s)", (specialization) => {
    const d = diagram();
    d.nodes.push({ id: "S:Single", kind: "specialization", label: "Single", double: false,
      box: { x: 20, y: 30, w: 30, h: 30 }, specialization });
    expect(renderSvg(d)).toContain('<g data-id="S:Single" class="er-specialization"></g>');
  });

  it.each([
    { name: "downward", toward: { x: 0, y: 1 } },
    { name: "upward", toward: { x: 0, y: -1 } },
    { name: "diagonal", toward: { x: 0.6, y: -0.8 } },
  ])("opens the subset mark toward the superclass on a $name edge", ({ toward: u }) => {
    const d = diagram(), e = subsetEdge(u);
    d.edges.push(e);
    const edge = group(renderSvg(d), e.id);
    expect(edge.match(/<path /g)).toHaveLength(1);
    expect(edge).toContain('fill="none"');
    const path = edge.match(/<path d="([^"]+)"/)![1]!;
    expect(path.replace(/[-\d.]+/g, "").trim().replace(/\s+/g, " ")).toBe("M L A L");
    const v = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const [ax, ay, px, py, rx, ry, rotation, large, sweep, qx, qy, bx, by] = v as [number, number, number, number, number, number, number, number, number, number, number, number, number];
    const r = style.specialization.subsetRadius, a = style.specialization.subsetArm;
    expect([rx, ry, rotation, large]).toEqual([r, r, 0, 0]);
    expect({ x: (px + qx) / 2, y: (py + qy) / 2 }).toEqual(e.subset!.at);
    expect(px - 100).toBeCloseTo(-u.y * r); expect(py - 100).toBeCloseTo(u.x * r);
    for (const [dx, dy] of [[ax - px, ay - py], [bx - qx, by - qy]]) {
      expect(dx).toBeCloseTo(a * u.x); expect(dy).toBeCloseTo(a * u.y);
    }
    // Recover the arc midpoint from SVG's sweep direction in the y-down coordinate system.
    const theta = Math.atan2(py - 100, px - 100) + (sweep ? 1 : -1) * Math.PI / 2;
    const midpoint = { x: 100 + r * Math.cos(theta), y: 100 + r * Math.sin(theta) };
    expect(midpoint.x).toBeCloseTo(100 - r * u.x); expect(midpoint.y).toBeCloseTo(100 - r * u.y);
  });

  it("renders specialization text in regular ink without italics", () => {
    const d = diagram();
    d.labels.push({ id: "predicate", kind: "specialization", text: "Job = 'Engineer'", edge: "edge:S:Person#Engineer", box: { x: 20, y: 50, w: 100, h: 18 } });
    const label = group(renderSvg(d), "predicate");
    expect(label).toContain('x="70" y="59"');
    expect(label).toContain(`font-size="${style.label.fontSize}"`);
    expect(label).toContain(`fill="${style.colors.ink}"`);
    expect(label).not.toContain("font-style"); expect(label).not.toContain("font-weight");
    expect(label).toContain("Job = &#39;Engineer&#39;");
  });

  it("preserves both parallel lines on a total specialization supertype edge", () => {
    const d = diagram();
    d.edges.push({ id: "edge:S:Person#super", kind: "end", from: "S:Person", to: "E:Person", end: "S:Person#super", double: true,
      points: [{ x: 100, y: 100 }, { x: 100, y: 20 }] });
    expect(group(renderSvg(d), "edge:S:Person#super")).toBe('<polyline points="102,100 102,20"/><polyline points="98,100 98,20"/>');
  });
});
