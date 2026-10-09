import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutPathFor, renderFile } from "../src/app/render.js";
import { renderCommand } from "../src/cli/commands.js";
import { center } from "../src/core/geometry.js";
import { layout } from "../src/core/layout/index.js";
import { parseModel } from "../src/core/normalize.js";

const MODEL = `version: 1
title: Shop
entities:
  CUSTOMER:
    attrs: [CustomerId, Name]
    keys: [[CustomerId]]
  ORDER:
    attrs: [OrderId, Placed]
    keys: [[OrderId]]
  PRODUCT:
    attrs: [Sku, Title]
    keys: [[Sku]]
  SUPPLIER:
    attrs: [SupplierId, Company]
    keys: [[SupplierId]]
relationships:
  PLACES:
    ends:
      - { entity: CUSTOMER, card: 1..1 }
      - { entity: ORDER, card: 0..N }
  CONTAINS:
    ends:
      - { entity: ORDER, card: 0..N }
      - { entity: PRODUCT, card: 0..N }
  SUPPLIES:
    ends:
      - { entity: SUPPLIER, card: 1..N }
      - { entity: PRODUCT, card: 0..N }
`;

let dir: string;
let model: string;
const writeLayout = (body: object) => writeFileSync(layoutPathFor(model), JSON.stringify({ version: 1, ...body }));
const layoutBefore = () => readFileSync(layoutPathFor(model), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-pins-"));
  model = join(dir, "shop.er.yaml");
  writeFileSync(model, MODEL);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Entity centers of the plain layout: pinning to these changes nothing. */
async function sensiblePins() {
  const parsed = parseModel(MODEL);
  const { diagram } = await layout(parsed.model!, {});
  return Object.fromEntries(diagram.nodes.filter((n) => n.kind === "entity").map((n) => [n.id, center(n.box)]));
}

const farApart = {
  "E:CUSTOMER": { x: 100, y: 100 },
  "E:ORDER": { x: 3200, y: 2600 },
  "E:PRODUCT": { x: 100, y: 2600 },
  "E:SUPPLIER": { x: 3200, y: 100 },
};

describe("stale pins", () => {
  it("warns with both measurements and the fix when pins degrade the layout", async () => {
    writeLayout({ pins: farApart });
    const result = await renderCommand(model, { out: join(dir, "out.svg") });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("[pins-degrade-layout]");
    expect(result.stderr).toMatch(/\d+x\d+ px with pins vs \d+x\d+ px without/);
    expect(result.stderr).toMatch(/edge crossings \d+ vs \d+/);
    expect(result.stderr).toContain("run with --no-pins to compare, or use Reset pins in `chen serve`");
    const json = JSON.parse((await renderCommand(model, { out: join(dir, "out.svg"), json: true })).stdout);
    expect(json.diagnostics.map((d: { rule: string }) => d.rule)).toContain("pins-degrade-layout");
  });

  it("stays quiet for sensible pins and when there are no pins", async () => {
    writeLayout({ pins: await sensiblePins() });
    expect((await renderCommand(model, { out: join(dir, "out.svg") })).stderr).not.toContain("pins-degrade-layout");
    writeLayout({ pins: {} });
    expect((await renderCommand(model, { out: join(dir, "out.svg") })).stderr).toBe("");
  });

  it("does not run the comparison outside the CLI path", async () => {
    writeLayout({ pins: farApart });
    const result = await renderFile(model);
    expect(result.diagnostics.map((d) => d.rule)).not.toContain("pins-degrade-layout");
    expect(result.notes).toBeUndefined();
  });

  it("--no-pins ignores pins, positions and the stored engine without touching the file", async () => {
    writeLayout({ engine: "stress", pins: farApart });
    const before = layoutBefore();
    const out = join(dir, "out.svg");
    const result = await renderCommand(model, { out, pins: false });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const noFile = join(dir, "plain.er.yaml");
    writeFileSync(noFile, MODEL);
    await renderCommand(noFile, { out: join(dir, "plain.svg") });
    expect(readFileSync(out, "utf8")).toBe(readFileSync(join(dir, "plain.svg"), "utf8"));
    expect(layoutBefore()).toBe(before);
  });

  it("--no-pins also skips a broken layout file", async () => {
    writeFileSync(layoutPathFor(model), "broken");
    expect((await renderCommand(model, { out: join(dir, "out.svg") })).exitCode).toBe(1);
    expect(await renderCommand(model, { out: join(dir, "out.svg"), pins: false })).toMatchObject({ exitCode: 0, stderr: "" });
  });
});

describe("engine note", () => {
  it("is printed once on stderr when the layout file decides a non-default engine", async () => {
    writeLayout({ engine: "stress", pins: {} });
    const result = await renderCommand(model, { out: join(dir, "out.svg"), json: true });
    expect(result.stderr).toBe("using engine 'stress' from shop.er.layout.json (default is 'layered'); pass --engine to override");
    expect(JSON.parse(result.stdout)).toHaveProperty("outputs");
  });

  it("is absent with --engine, --no-pins, a default engine or no layout file", async () => {
    writeLayout({ engine: "stress", pins: {} });
    expect((await renderCommand(model, { out: join(dir, "out.svg"), engine: "simple" })).stderr).toBe("");
    expect((await renderCommand(model, { out: join(dir, "out.svg"), pins: false })).stderr).toBe("");
    writeLayout({ engine: "layered", pins: {} });
    expect((await renderCommand(model, { out: join(dir, "out.svg") })).stderr).toBe("");
    rmSync(layoutPathFor(model));
    expect((await renderCommand(model, { out: join(dir, "out.svg") })).stderr).toBe("");
  });
});
