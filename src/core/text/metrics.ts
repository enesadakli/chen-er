import data from "./metrics-data.json" with { type: "json" };

/**
 * Text measurement against the bundled Inter fonts. Pure table lookups, so the
 * CLI, the MCP server and the browser viewer all get the same widths, and the
 * PNG renderer (which loads the same font files) draws exactly what was measured.
 */
export type FontWeight = "regular" | "bold";

export interface TextMetrics {
  family: string;
  /** Advance width of `text` at `size` px. */
  width(text: string, size: number, weight?: FontWeight): number;
}

const tables: Record<FontWeight, Record<string, number>> = { regular: data.regular, bold: data.bold };
const fallback = (weight: FontWeight) => tables[weight]["M"] ?? data.unitsPerEm * 0.7;

export const interMetrics: TextMetrics = {
  family: data.family,
  width(text, size, weight = "regular") {
    const t = tables[weight];
    let units = 0;
    for (const ch of text) units += t[ch] ?? fallback(weight);
    return (units / data.unitsPerEm) * size;
  },
};
