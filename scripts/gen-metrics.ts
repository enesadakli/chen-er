/**
 * Generates src/core/text/metrics-data.json: advance widths of the bundled Inter
 * fonts, so text is measured identically in Node and in the browser.
 * Run: npm run gen:metrics
 */
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";

const ranges: Array<[number, number]> = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0x17f], // Latin-1 supplement + Latin Extended-A (ç ğ ı İ ö ş ü ...)
];
const extra = "–—‘’“”•…→←↔≥≤×·";

function table(file: string) {
  const buf = readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const widths: Record<string, number> = {};
  const add = (ch: string) => {
    const g = font.charToGlyph(ch);
    if (g && g.advanceWidth !== undefined) widths[ch] = g.advanceWidth;
  };
  for (const [lo, hi] of ranges) for (let c = lo; c <= hi; c++) add(String.fromCodePoint(c));
  for (const ch of extra) add(ch);
  return { unitsPerEm: font.unitsPerEm, widths };
}

const regular = table("assets/fonts/Inter_400Regular.ttf");
const bold = table("assets/fonts/Inter_700Bold.ttf");
writeFileSync(
  "src/core/text/metrics-data.json",
  JSON.stringify({ family: "Inter", unitsPerEm: regular.unitsPerEm, regular: regular.widths, bold: bold.widths }) + "\n",
);
console.log(`metrics: ${Object.keys(regular.widths).length} glyphs`);
