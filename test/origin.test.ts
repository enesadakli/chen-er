import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { diagramPositions, readPins, renderFile, svgToPng } from "../src/app/render.js";
import { center, type DNode, type Point } from "../src/core/geometry.js";
import { finalize } from "../src/core/layout/finalize.js";
import { assessQuality } from "../src/core/quality.js";
import { renderSvg } from "../src/core/render/svg.js";
import { interMetrics } from "../src/core/text/metrics.js";
import { style } from "../src/core/style.js";

const fixture = "test/fixtures/origin/reading.er.yaml";
const engines = ["layered", "stress", "simple"] as const;

const pinnedNode = (): DNode => ({
  id: "E:ITEM", kind: "entity", label: "ITEM", double: false, pinned: true,
  box: { x: 100, y: 100, w: 110, h: 46 },
});

describe("canvas origin", () => {
  it.each(engines)("contains negative unpinned geometry and preserves absolute pins with %s", async (engine) => {
    const { diagram: d, svg } = await renderFile(fixture, { engine });
    expect(d).toBeDefined();
    const origin = d!.origin!;
    expect(origin.x).toBeLessThan(0);
    expect(origin.y).toBeLessThan(0);
    expect(d!.nodes.some((n) => !n.pinned && (n.box.x < 0 || n.box.y < 0))).toBe(true);
    const inside = (p: Point) => {
      expect(p.x).toBeGreaterThanOrEqual(origin.x + style.margin);
      expect(p.y).toBeGreaterThanOrEqual(origin.y + style.margin + style.title.band);
      expect(p.x).toBeLessThanOrEqual(origin.x + d!.width - style.margin);
      expect(p.y).toBeLessThanOrEqual(origin.y + d!.height - style.margin);
    };
    for (const item of [...d!.nodes, ...d!.labels]) {
      inside(item.box);
      inside({ x: item.box.x + item.box.w, y: item.box.y + item.box.h });
    }
    for (const e of d!.edges) for (const p of e.points) inside(p);
    const pins = readPins(fixture).options.pins!;
    const positions = diagramPositions(d!);
    for (const [id, pin] of Object.entries(pins)) {
      expect(center(d!.nodes.find((n) => n.id === id)!.box)).toEqual(pin);
      expect(positions[id]).toEqual(pin);
    }
    for (const node of d!.nodes) expect(positions[node.id]).toEqual(center(node.box));
    const quality = assessQuality(d!, pins);
    expect(quality.pinDrift).toBe(0);
    expect(quality.issues.filter((i) => i.kind === "out-of-canvas")).toEqual([]);
    const height = d!.height + style.note.lineHeight + style.margin;
    expect(svg).toContain(`viewBox="${origin.x} ${origin.y} ${d!.width} ${height}"`);
    expect(svg).toContain(`<rect x="${origin.x}" y="${origin.y}" width="${d!.width}" height="${height}"`);
    const title = svg!.match(/data-id="title"[^>]*><text x="([^"]+)" y="([^"]+)"/)!;
    expect(Number(title[1])).toBe(origin.x + style.margin);
    expect(Number(title[2])).toBe(origin.y + style.margin + style.title.fontSize);
    expect(Number(title[1]) + interMetrics.width(d!.title!, style.title.fontSize, "bold")).toBeLessThan(origin.x + d!.width);
    expect(Number(title[2])).toBeLessThan(Math.min(...d!.nodes.map((n) => n.box.y)));
    const note = svg!.match(/data-id="note:0"[^>]*><text x="([^"]+)" y="([^"]+)"/)!;
    expect(Number(note[1])).toBe(origin.x + style.margin);
    expect(Number(note[2])).toBeGreaterThan(origin.y + d!.height);
    expect(Number(note[2])).toBeLessThan(origin.y + height);
    const png = svgToPng(svg!, 1);
    expect(png.readUInt32BE(16)).toBe(d!.width);
    expect(png.readUInt32BE(20)).toBe(height);
  });

  it.each([
    ["layered", "c299faa3c1de072b97265514e97fe18137f735e3d46ecfd5c6c129ca85e71b4f"],
    ["stress", "c299faa3c1de072b97265514e97fe18137f735e3d46ecfd5c6c129ca85e71b4f"],
    ["simple", "6d0f29c6e2c960e41a282c75c86aeb03d0bd2c8495b01e0785741cd42b26c83e"],
  ] as const)("preserves the pre-origin unpinned SVG bytes with %s", async (engine, hash) => {
    const { diagram, svg } = await renderFile(fixture, { engine }, { noPins: true });
    expect(diagram!.origin).toBeUndefined();
    expect(createHash("sha256").update(svg!).digest("hex")).toBe(hash);
    expect(renderSvg({ ...diagram!, origin: { x: 0, y: 0 } })).toBe(svg);
  });

  it.each([
    [undefined, "label"], [undefined, "edge"], ["Items", "label"], ["Items", "edge"],
  ] as const)("includes label and edge extrema without translating pins (title=%s, minimum=%s)", (title, minimum) => {
    const node = pinnedNode();
    const label = { id: "label", kind: "role" as const, text: "item", edge: "edge", box: { x: minimum === "label" ? -800.25 : -400.25, y: minimum === "label" ? -900.5 : -600.5, w: 40, h: 18 } };
    const edge = { id: "edge", kind: "attribute" as const, from: node.id, to: "A:ITEM.Name", double: false, points: [{ x: -500.5, y: -700.25 }, { x: 600.75, y: 800.5 }] };
    const d = finalize({ nodes: [node], labels: [label], edges: [edge], title, notes: [], engine: "test" }).diagram;
    const top = style.margin + (title ? style.title.band : 0);
    expect(d.origin).toEqual({ x: Math.min(label.box.x, -500.5) - style.margin, y: Math.min(label.box.y, -700.25) - top });
    expect(d.width).toBe(Math.ceil(600.75 + style.margin - d.origin!.x));
    expect(d.height).toBe(Math.ceil(800.5 + style.margin - d.origin!.y));
    expect(node.box).toEqual(pinnedNode().box);
    expect(label.box.x).toBe(minimum === "label" ? -800.25 : -400.25);
    expect(edge.points[0]).toEqual({ x: -500.5, y: -700.25 });
  });

  it("keeps a zero origin for pins already inside the margins", () => {
    const d = finalize({ nodes: [pinnedNode()], labels: [], edges: [], title: "Items", notes: [], engine: "test" }).diagram;
    expect(d.origin).toEqual({ x: 0, y: 0 });
    expect(d.width).toBe(242);
    expect(d.height).toBe(178);
  });

  it("checks all four origin-relative boundaries and non-finite points", () => {
    const base = { width: 400, height: 300, origin: { x: -200, y: -100 }, edges: [], labels: [], notes: [], meta: { engine: "test" } };
    const n = pinnedNode();
    for (const box of [
      { x: -200, y: -100, w: 110, h: 46 },
      { x: 90, y: 154, w: 110, h: 46 },
    ]) expect(assessQuality({ ...base, nodes: [{ ...n, box }] }).issues).toEqual([]);
    for (const box of [
      { x: -201, y: 0, w: 110, h: 46 }, { x: 0, y: -101, w: 110, h: 46 },
      { x: 91, y: 0, w: 110, h: 46 }, { x: 0, y: 155, w: 110, h: 46 },
      { x: NaN, y: 0, w: 110, h: 46 },
    ]) expect(assessQuality({ ...base, nodes: [{ ...n, box }] }).issues.filter((i) => i.kind === "out-of-canvas")).toHaveLength(1);
  });
});
