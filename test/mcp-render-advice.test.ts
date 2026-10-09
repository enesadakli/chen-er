import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";

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

const farApart = {
  "E:CUSTOMER": { x: 100, y: 100 },
  "E:ORDER": { x: 3200, y: 2600 },
  "E:PRODUCT": { x: 100, y: 2600 },
  "E:SUPPLIER": { x: 3200, y: 100 },
};

type Result = Awaited<ReturnType<Client["callTool"]>>;
const payload = (result: Result) =>
  JSON.parse((result.content as { type: string; text?: string }[]).find((c) => c.type === "text")!.text!);
const rules = (p: { diagnostics: { rule: string }[] }) => p.diagnostics.map((d) => d.rule);

describe("MCP render advice", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let dir: string;
  let model: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chen-mcp-advice-"));
    model = join(dir, "shop.er.yaml");
    await writeFile(model, MODEL);
    client = new Client({ name: "test-client", version: "1.0.0" });
    server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const writeLayout = (body: object) => writeFile(join(dir, "shop.er.layout.json"), JSON.stringify({ version: 1, ...body }));
  const render = (args: object) => client.callTool({ name: "render_er", arguments: { path: model, ...args } });

  it("warns when saved pins make the drawing clearly worse", async () => {
    await writeLayout({ pins: farApart });
    const result = payload(await render({}));
    expect(rules(result)).toContain("pins-degrade-layout");
    expect(result.diagnostics.find((d: { rule: string }) => d.rule === "pins-degrade-layout").severity).toBe("warning");
    expect(result.summary.warning).toBeGreaterThanOrEqual(1);
  });

  it("ignores the layout file with noPins", async () => {
    await writeLayout({ engine: "stress", pins: farApart });
    const result = payload(await render({ noPins: true }));
    expect(rules(result)).not.toContain("pins-degrade-layout");
    expect(result.notes).toEqual([]);
  });

  it("stays quiet without pins and reports the engine the layout file chose", async () => {
    expect(rules(payload(await render({})))).not.toContain("pins-degrade-layout");
    await writeLayout({ engine: "stress", pins: {} });
    const result = payload(await render({}));
    expect(rules(result)).not.toContain("pins-degrade-layout");
    expect(result.notes.join(" ")).toContain("engine 'stress'");
  });
});
