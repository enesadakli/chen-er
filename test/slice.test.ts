import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderFile, svgToPng } from "../src/app/render.js";

const fixtures = readdirSync("bench/fixtures").filter((f) => f.endsWith(".er.yaml"));

describe("vertical slice: yaml → layout → svg → png", () => {
  it.each(fixtures)("%s renders", async (file) => {
    const res = await renderFile(`bench/fixtures/${file}`);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.svg).toContain("<svg");
    const ids = res.diagram!.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of res.diagram!.edges) {
      expect(ids).toContain(e.from);
      expect(ids).toContain(e.to);
    }
    expect(svgToPng(res.svg!).length).toBeGreaterThan(1000);
  });

  it("keeps pinned entities at their pins", async () => {
    const res = await renderFile("bench/fixtures/pinned.er.yaml");
    const a = res.diagram!.nodes.find((n) => n.id === "E:AUTHOR")!;
    const j = res.diagram!.nodes.find((n) => n.id === "E:JOURNAL")!;
    const dx = j.box.x + j.box.w / 2 - (a.box.x + a.box.w / 2);
    expect(dx).toBeCloseTo(900, 5);
    expect(a.pinned).toBe(true);
  });
});
