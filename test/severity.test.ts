import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutPathFor } from "../src/app/render.js";
import { lintCommand, renderCommand } from "../src/cli/commands.js";
import { hasErrors, type Diagnostic } from "../src/core/diagnostics.js";
import { RULES } from "../src/core/lint/index.js";
import { createServer } from "../src/mcp/server.js";
import { exampleModel } from "../src/mcp/tools.js";
import { findings, glyphs, severities } from "../src/viewer/logic.js";

const MODEL = `version: 1
title: Shop
entities:
  CUSTOMER: { attrs: [CustomerId, Name], keys: [[CustomerId]] }
  ORDER: { attrs: [OrderId, Placed], keys: [[OrderId]] }
  PRODUCT: { attrs: [Sku, Title], keys: [[Sku]] }
  SUPPLIER: { attrs: [SupplierId, Company], keys: [[SupplierId]] }
relationships:
  PLACES:
    ends: [{ entity: CUSTOMER, card: 1..1 }, { entity: ORDER, card: 0..N }]
  CONTAINS:
    ends: [{ entity: ORDER, card: 0..N }, { entity: PRODUCT, card: 0..N }]
  SUPPLIES:
    ends: [{ entity: SUPPLIER, card: 1..N }, { entity: PRODUCT, card: 0..N }]
`;
const farApart = {
  "E:CUSTOMER": { x: 100, y: 100 }, "E:ORDER": { x: 3200, y: 2600 },
  "E:PRODUCT": { x: 100, y: 2600 }, "E:SUPPLIER": { x: 3200, y: 100 },
};

let dir: string;
let model: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-sev-"));
  model = join(dir, "shop.er.yaml");
  writeFileSync(model, MODEL);
  writeFileSync(layoutPathFor(model), JSON.stringify({ version: 1, pins: farApart }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("warning severity", () => {
  it("pins-degrade-layout is a warning, shown in text and JSON, without failing the render", async () => {
    const text = await renderCommand(model, { out: join(dir, "a.svg") });
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toMatch(/^warning:\?:\? \[pins-degrade-layout\]/m);
    const json = JSON.parse((await renderCommand(model, { out: join(dir, "a.svg"), json: true })).stdout);
    const found = json.diagnostics.find((d: Diagnostic) => d.rule === "pins-degrade-layout");
    expect(found.severity).toBe("warning");
    expect(readFileSync(join(dir, "a.svg"), "utf8")).toContain("<svg");
  });

  it("only errors count as failure", () => {
    const warning: Diagnostic = { rule: "x", severity: "warning", message: "m" };
    expect(hasErrors([warning])).toBe(false);
    expect(hasErrors([warning, { ...warning, severity: "error" }])).toBe(true);
  });

  it("lint filter flags do not hide warnings and no lint rule uses warning", () => {
    expect(RULES.some((r) => r.severity === "warning")).toBe(false);
    expect(lintCommand(model, { course: false, heuristic: false }).exitCode).toBe(0);
  });

  it("viewer groups warnings after errors with their own glyph", () => {
    expect(severities).toEqual(["error", "warning", "course", "heuristic", "info"]);
    expect(glyphs.warning).toBe("!");
    const list = findings([
      { rule: "c", severity: "course", message: "c" },
      { rule: "w", severity: "warning", message: "w" },
      { rule: "e", severity: "error", message: "e" },
    ]);
    expect(list.map((f) => f.rule)).toEqual(["e", "w", "c"]);
  });

  it("MCP summary counts warnings", async () => {
    const client = new Client({ name: "t", version: "1.0.0" });
    const server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const result = await client.callTool({ name: "render_er", arguments: { model: exampleModel, engine: "simple", scale: 1 } });
    const text = (result.content as { type: string; text?: string }[]).find((i) => i.type === "text")!.text!;
    expect(JSON.parse(text).summary).toHaveProperty("warning", 0);
    await client.close();
    await server.close();
  });
});
