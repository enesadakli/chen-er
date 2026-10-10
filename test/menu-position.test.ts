import { describe, expect, it } from "vitest";
import { placeMenu } from "../src/viewer/menu-position.js";

describe("placeMenu", () => {
  it("places menu above when requested height fits above with gap and padding", () => {
    const result = placeMenu(
      { x: 200, y: 200, w: 100, h: 50 },
      { w: 120, h: 60 },
      { w: 800, h: 600 },
      8,
      8
    );
    expect(result.placement).toBe("above");
    expect(result.y).toBe(132);
    expect(result.x).toBe(190);
  });

  it("places menu below when requested height does not fit above", () => {
    const result = placeMenu(
      { x: 200, y: 50, w: 100, h: 50 },
      { w: 120, h: 60 },
      { w: 800, h: 600 },
      8,
      8
    );
    expect(result.placement).toBe("below");
    expect(result.y).toBe(108);
    expect(result.x).toBe(190);
  });

  it("clamps x to left viewport padding when anchor is near the left boundary", () => {
    const result = placeMenu(
      { x: 2, y: 300, w: 40, h: 30 },
      { w: 100, h: 40 },
      { w: 500, h: 500 },
      8,
      8
    );
    expect(result.x).toBe(8);
  });

  it("clamps x to right viewport padding when anchor is near the right boundary", () => {
    const result = placeMenu(
      { x: 480, y: 300, w: 40, h: 30 },
      { w: 100, h: 40 },
      { w: 500, h: 500 },
      8,
      8
    );
    expect(result.x).toBe(392);
  });

  it("constrains huge menu to padded viewport bounds without negative coordinates", () => {
    const result = placeMenu(
      { x: 300, y: 300, w: 100, h: 50 },
      { w: 5000, h: 4000 },
      { w: 800, h: 600 },
      8,
      8
    );
    expect(result.maxWidth).toBe(784);
    expect(result.maxHeight).toBe(584);
    expect(result.placement).toBe("below");
    expect(result.x).toBe(8);
    expect(result.y).toBe(8);

    const effectiveW = Math.min(5000, result.maxWidth);
    const effectiveH = Math.min(4000, result.maxHeight);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + effectiveW).toBeLessThanOrEqual(800);
    expect(result.y + effectiveH).toBeLessThanOrEqual(600);
  });

  it("handles tiny viewports smaller than twice padding without negative values", () => {
    const result = placeMenu(
      { x: 2, y: 2, w: 4, h: 4 },
      { w: 50, h: 50 },
      { w: 10, h: 10 },
      8,
      8
    );
    expect(result.maxWidth).toBe(0);
    expect(result.maxHeight).toBe(0);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + Math.min(50, result.maxWidth)).toBeLessThanOrEqual(10);
    expect(result.y + Math.min(50, result.maxHeight)).toBeLessThanOrEqual(10);
  });

  it("handles zero and sub-padding viewports gracefully", () => {
    const zeroResult = placeMenu(
      { x: 0, y: 0, w: 0, h: 0 },
      { w: 20, h: 20 },
      { w: 0, h: 0 },
      8,
      8
    );
    expect(zeroResult.maxWidth).toBe(0);
    expect(zeroResult.maxHeight).toBe(0);
    expect(zeroResult.x).toBe(0);
    expect(zeroResult.y).toBe(0);

    const subPaddingResult = placeMenu(
      { x: 1, y: 1, w: 2, h: 2 },
      { w: 20, h: 20 },
      { w: 5, h: 5 },
      8,
      8
    );
    expect(subPaddingResult.maxWidth).toBe(0);
    expect(subPaddingResult.maxHeight).toBe(0);
    expect(subPaddingResult.x).toBeGreaterThanOrEqual(0);
    expect(subPaddingResult.y).toBeGreaterThanOrEqual(0);
    expect(subPaddingResult.x).toBeLessThanOrEqual(5);
    expect(subPaddingResult.y).toBeLessThanOrEqual(5);
  });

  it("centers horizontally on anchor across different zoom-transformed screen positions", () => {
    const zoom1Anchor = { x: 60, y: 130, w: 80, h: 40 };
    const menu = { w: 60, h: 30 };
    const viewport = { w: 1000, h: 800 };

    const result1 = placeMenu(zoom1Anchor, menu, viewport);
    expect(result1.x).toBe(70);
    expect(result1.x + menu.w / 2).toBe(zoom1Anchor.x + zoom1Anchor.w / 2);

    const zoom2Anchor = { x: 140, y: 205, w: 120, h: 60 };
    const result2 = placeMenu(zoom2Anchor, menu, viewport);
    expect(result2.x).toBe(170);
    expect(result2.x + menu.w / 2).toBe(zoom2Anchor.x + zoom2Anchor.w / 2);
  });

  it("guarantees no offscreen rect under effective width and height across diverse layouts", () => {
    const anchors = [
      { x: -50, y: -50, w: 40, h: 40 },
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 200, y: 15, w: 80, h: 40 },
      { x: 300, y: 400, w: 120, h: 60 },
      { x: 950, y: 750, w: 100, h: 80 },
      { x: 1200, y: 900, w: 50, h: 50 },
    ];

    const menus = [
      { w: 0, h: 0 },
      { w: 40, h: 20 },
      { w: 160, h: 80 },
      { w: 800, h: 600 },
      { w: 3000, h: 2000 },
    ];

    const viewports = [
      { w: 0, h: 0 },
      { w: 6, h: 6 },
      { w: 16, h: 16 },
      { w: 100, h: 100 },
      { w: 1024, h: 768 },
    ];

    for (const vp of viewports) {
      for (const anc of anchors) {
        for (const m of menus) {
          const res = placeMenu(anc, m, vp);
          const effW = Math.max(0, Math.min(m.w, res.maxWidth));
          const effH = Math.max(0, Math.min(m.h, res.maxHeight));

          expect(res.x).toBeGreaterThanOrEqual(0);
          expect(res.y).toBeGreaterThanOrEqual(0);
          expect(res.maxWidth).toBeGreaterThanOrEqual(0);
          expect(res.maxHeight).toBeGreaterThanOrEqual(0);
          expect(res.x + effW).toBeLessThanOrEqual(vp.w);
          expect(res.y + effH).toBeLessThanOrEqual(vp.h);
        }
      }
    }
  });

  const anchor = { x: 300, y: 250, w: 100, h: 50 };
  const menu = { w: 200, h: 38 };
  const viewport = { w: 800, h: 600 };
  const area = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  it("places below when a label blocks the toolbar above the anchor", () => {
    const label = { x: 240, y: 202, w: 220, h: 40, weight: 4 };
    const result = placeMenu(anchor, menu, viewport, 8, 8, [label]);
    expect(result.placement).toBe("below");
    expect(area({ ...result, ...menu }, label)).toBe(0);
  });

  it("finds a clear side when labels block above and below", () => {
    const labels = [
      { x: 200, y: 140, w: 300, h: 102, weight: 4 },
      { x: 200, y: 308, w: 300, h: 102, weight: 4 },
    ];
    const result = placeMenu(anchor, menu, viewport, 8, 8, labels);
    expect(["left", "right"]).toContain(result.placement);
    for (const label of labels) expect(area({ ...result, ...menu }, label)).toBe(0);
    expect(area({ ...result, ...menu }, anchor)).toBe(0);
  });

  it("pushes above outward in 12 pixel steps when every base candidate is blocked", () => {
    const obstacles = [
      { x: 200, y: 226, w: 300, h: 16, weight: 4 },
      { x: 0, y: 250, w: 800, h: 100, weight: 4 },
    ];
    const result = placeMenu(anchor, menu, viewport, 8, 8, obstacles);
    expect(result.placement).toBe("above");
    expect(result.y).toBe(180); // The first clear candidate has 24 px extra gap.
    for (const obstacle of obstacles) expect(area({ ...result, ...menu }, obstacle)).toBe(0);
  });

  it("preserves the old result with empty or distant obstacles", () => {
    for (const box of [anchor, { ...anchor, y: 10 }]) {
      const legacy = placeMenu(box, menu, viewport);
      expect(placeMenu(box, menu, viewport, 8, 8, [])).toEqual(legacy);
      expect(placeMenu(box, menu, viewport, 8, 8,
        [{ x: 750, y: 550, w: 20, h: 20, weight: 4 }])).toEqual(legacy);
    }
  });

  it("keeps obstacle-aware candidates within the padded viewport", () => {
    for (const box of [anchor, { ...anchor, x: -50, y: -20 }, { ...anchor, x: 780, y: 580 }]) {
      for (const size of [menu, { w: 2000, h: 1000 }]) {
        const result = placeMenu(box, size, viewport, 8, 8,
          [{ x: 0, y: 0, w: 800, h: 600, weight: 4 }]);
        expect(result.x).toBeGreaterThanOrEqual(8);
        expect(result.y).toBeGreaterThanOrEqual(8);
        expect(result.x + Math.min(size.w, result.maxWidth)).toBeLessThanOrEqual(viewport.w - 8);
        expect(result.y + Math.min(size.h, result.maxHeight)).toBeLessThanOrEqual(viewport.h - 8);
      }
    }
  });

  it("never overlaps the anchor when a clear candidate exists despite heavy obstacles", () => {
    const box = { x: 300, y: 15, w: 100, h: 50 };
    const result = placeMenu(box, menu, viewport, 8, 8,
      [{ x: 0, y: 65, w: 800, h: 535, weight: 1_000_000_000 }]);
    expect(area({ ...result, ...menu }, box)).toBe(0);
  });

  it("uses obstacle weights to prefer covering edges over labels", () => {
    const result = placeMenu(anchor, menu, viewport, 8, 8, [
      { x: 0, y: 0, w: 800, h: 250, weight: 4 },
      { x: 0, y: 300, w: 800, h: 300, weight: 1 },
      { x: 0, y: 250, w: 300, h: 50, weight: 3 },
      { x: 400, y: 250, w: 400, h: 50, weight: 3 },
    ]);
    expect(result.placement).toBe("below");
  });


  it("breaks equal scores in favor of above centered even for a tall menu", () => {
    const size = { w: 40, h: 100 };
    expect(placeMenu(anchor, size, viewport, 8, 8,
      [{ x: 750, y: 550, w: 20, h: 20, weight: 4 }])).toEqual(placeMenu(anchor, size, viewport));
  });

});
