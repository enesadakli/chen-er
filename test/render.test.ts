import { describe, expect, it } from "vitest";
import type { Diagram, DNode } from "../src/core/geometry.js";
import { renderSvg } from "../src/core/render/svg.js";
import { interMetrics } from "../src/core/text/metrics.js";
import { style } from "../src/core/style.js";
import { renderText } from "../src/app/render.js";

const node = (kind: DNode["kind"], extra: Partial<DNode> = {}): DNode => ({
  id: `${kind}:sample`, kind, label: "Wi", box: { x: 40, y: 50, w: 120, h: 60 }, double: false, ...extra,
});
const diagram = (nodes: DNode[]): Diagram => ({
  width: 400, height: 300, nodes, edges: [], labels: [], notes: [], meta: { engine: "simple" },
});
const attr = (flags: Partial<NonNullable<DNode["attr"]>>) => node("attribute", {
  attr: { key: false, partial: false, multivalued: false, derived: false, ...flags },
});

function group(svg: string, id: string): string {
  return svg.match(new RegExp(`<g data-id="${id}"[^>]*>(.*?)</g>`, "s"))![1]!;
}

describe("Chen SVG notation", () => {
  it.each([
    ["entity", "rect"], ["relationship", "polygon"],
  ] as const)("draws two outlines for double %s", (kind, tag) => {
    const svg = renderSvg(diagram([node(kind, { double: true })]));
    expect(group(svg, `${kind}:sample`).match(new RegExp(`<${tag} `, "g"))).toHaveLength(2);
  });

  it("draws multivalued and derived attributes", () => {
    const svg = renderSvg(diagram([attr({ multivalued: true, derived: true })]));
    expect(svg.match(/<ellipse /g)).toHaveLength(2);
    expect(svg.match(/stroke-dasharray="5 4"/g)).toHaveLength(2);
  });

  it.each([true, false])("uses exact Inter width for partial=%s underlines", (partial) => {
    const svg = renderSvg(diagram([attr({ partial, key: !partial })]));
    const line = svg.match(/<line x1="([^"]+)"[^>]*x2="([^"]+)"[^>]*\/>/)!;
    expect(Number(line[2]) - Number(line[1])).toBeCloseTo(interMetrics.width("Wi", style.attribute.fontSize, style.attribute.weight), 0);
    expect(line[0].includes('stroke-dasharray="4 3"')).toBe(partial);
  });

  it("draws composite parts connected to their parent attribute", async () => {
    const result = await renderText(`version: 1
entities:
  PERSON:
    attrs:
      - name: Name
        parts: [First, Last]
`);
    const parts = result.diagram!.edges.filter((edge) => edge.kind === "part");
    expect(parts).toHaveLength(2);
    expect(parts.map((edge) => edge.from)).toEqual(["A:PERSON.Name", "A:PERSON.Name"]);
    expect(parts.map((edge) => edge.to).sort()).toEqual(["A:PERSON.Name.First", "A:PERSON.Name.Last"]);
    for (const edge of parts) {
      expect(group(result.svg!, edge.id)).toContain("<polyline ");
    }
  });

  it("draws parallel double edges including bends", () => {
    const d = diagram([]);
    d.edges = [{ id: "edge", kind: "end", from: "R:A", to: "E:B", double: true,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }];
    const svg = renderSvg(d);
    expect(group(svg, "edge").match(/<polyline /g)).toHaveLength(2);
    expect(svg).toContain('points="0,2 98,2 98,100"');
    expect(svg).toContain('points="0,-2 102,-2 102,100"');
  });

  it("escapes text and ids, supplies classes, and preserves drawing order deterministically", () => {
    const special = `&<>"'`;
    const d = diagram([node("entity", { id: special, label: special })]);
    d.edges = [{ id: "edge", kind: "part", from: "a", to: "b", points: [], double: false }];
    d.labels = [
      { id: "role", kind: "role", text: special, box: { x: 0, y: 0, w: 30, h: 18 }, edge: "edge" },
      { id: "card", kind: "cardinality", text: "(0,N)", box: { x: 10, y: 10, w: 30, h: 18 }, edge: "edge" },
    ];
    d.title = special;
    d.notes = [special];
    const svg = renderSvg(d);
    expect(svg).toBe(renderSvg(d));
    expect(svg.match(/&amp;&lt;&gt;&quot;&#39;/g)).toHaveLength(5);
    expect(svg).toContain('class="er-entity"');
    expect(svg.indexOf('class="er-edge"')).toBeLessThan(svg.indexOf('class="er-entity"'));
    expect(svg.indexOf('class="er-entity"')).toBeLessThan(svg.indexOf('data-id="role"'));
    expect(svg.indexOf('data-id="card"')).toBeLessThan(svg.indexOf('data-id="title"'));
    expect(svg.indexOf('data-id="title"')).toBeLessThan(svg.indexOf('data-id="note:0"'));
    expect(group(svg, "role")).toContain('font-style="italic"');
    expect(group(svg, "role")).toContain(`fill="${style.colors.muted}"`);
    expect(group(svg, "card")).not.toContain('font-style="italic"');
  });
});
