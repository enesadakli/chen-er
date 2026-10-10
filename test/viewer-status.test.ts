import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTO_RELAYOUT_MESSAGE, layoutStatus } from "../src/viewer/status.js";

describe("viewer automatic re-layout status", () => {
  const state = { computing: false, autoRelayout: true, updatedAt: "2026-10-10T10:00:00Z", history: { canUndo: true, canRedo: false } };
  it("shows the automatic change, gives computing and offline priority, and clears after undo", () => {
    expect(layoutStatus(state, true)).toBe("Re-laid out after model change");
    expect(AUTO_RELAYOUT_MESSAGE).toBe(layoutStatus(state, true));
    expect(layoutStatus({ ...state, computing: true }, true)).toBe("Computing layout…");
    expect(layoutStatus(state, false)).toBe("disconnected");
    expect(layoutStatus({ ...state, autoRelayout: false }, true)).toMatch(/^updated /);
  });
  it("provides a keyboard accessible status Undo and a separate sr-only live region", () => {
    const html = readFileSync("src/viewer/index.html", "utf8");
    const main = readFileSync("src/viewer/main.ts", "utf8");
    expect(html).toContain('<button id="status-undo" hidden aria-label="Undo automatic re-layout">· Undo</button>');
    expect(html).toContain('<p id="layout-live" class="sr-only" aria-live="polite"></p>');
    expect(main).toContain('element("status-undo").addEventListener("click", () => { void write("/api/history/undo", "POST"); });');
    expect(main).toContain('Pins kept. Undo is available in the header.');
  });
});
