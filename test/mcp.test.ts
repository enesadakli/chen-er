import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { exampleModel } from "../src/mcp/tools.js";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text?: string }[];
  return JSON.parse(content.find((item) => item.type === "text")!.text!);
}

describe("MCP in-memory protocol", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chen-mcp-"));
    client = new Client({ name: "test-client", version: "1.0.0" });
    server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the three tools with input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_schema", "lint_er", "render_er"]);
    expect(tools.every((tool) => tool.inputSchema.type === "object" && tool.description)).toBe(true);
  });

  it("returns the input schema, annotated example and notation", async () => {
    const result = payload(await client.callTool({ name: "get_schema", arguments: {} }));
    expect(result.schema.$schema).toContain("2020-12");
    expect(result.schema.properties.version.const).toBe(1);
    expect(result.example).toContain("identifies: COPY");
    expect(result.notation).toContain("THAT end");
  });

  it("lints YAML text and file input", async () => {
    const path = join(dir, "model.er.yaml");
    await writeFile(path, exampleModel);
    for (const args of [{ model: exampleModel, disable: ["generic-relationship-name"] }, { path }]) {
      const result = payload(await client.callTool({ name: "lint_er", arguments: args }));
      expect(result.diagnostics).toEqual([]);
      expect(result.disclaimer).toContain("does not mean");
    }
  });

  it("returns parsing diagnostics and rejects ambiguous or missing sources", async () => {
    const invalid = await client.callTool({ name: "lint_er", arguments: { model: "version: 2" } });
    expect(invalid.isError).toBe(true);
    expect(payload(invalid).diagnostics[0].severity).toBe("error");
    for (const name of ["lint_er", "render_er"]) {
      for (const args of [{}, { model: exampleModel, path: "model.er.yaml" }]) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
      }
    }
  });

  it("renders text to one JSON item and one PNG image", async () => {
    const result = await client.callTool({ name: "render_er", arguments: { model: exampleModel, engine: "simple", scale: 1 } });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; data?: string; mimeType?: string }[];
    expect(content.map((item) => item.type)).toEqual(["text", "image"]);
    expect(content[1]!.mimeType).toBe("image/png");
    expect(Buffer.from(content[1]!.data!, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(payload(result).summary.error).toBe(0);
    expect(payload(result).writtenPaths).toEqual([]);
  });

  it("loads file pins and writes SVG and PNG", async () => {
    const path = join(dir, "model.er.yaml");
    const out = join(dir, "diagram.svg");
    await writeFile(path, exampleModel);
    await writeFile(join(dir, "model.er.layout.json"), JSON.stringify({ version: 1, engine: "simple", pins: { "E:BOOK": { x: 240, y: 160 } } }));
    const result = await client.callTool({ name: "render_er", arguments: { path, out } });
    expect(result.isError).not.toBe(true);
    expect(payload(result).writtenPaths).toEqual([out, join(dir, "diagram.png")]);
    expect(await readFile(out, "utf8")).toContain("<svg");
    expect((await readFile(join(dir, "diagram.png"))).length).toBeGreaterThan(1000);
  });

  it("reports I/O failures and invalid render options", async () => {
    expect((await client.callTool({ name: "lint_er", arguments: { path: join(dir, "missing.yaml") } })).isError).toBe(true);
    for (const args of [{ scale: 0 }, { scale: -1 }, { out: "diagram.png" }, { engine: "unknown" }]) {
      expect((await client.callTool({ name: "render_er", arguments: { model: exampleModel, ...args } })).isError).toBe(true);
    }
  });

  it("does not write images for a malformed model or invalid pins", async () => {
    const out = join(dir, "invalid.svg");
    const path = join(dir, "invalid.er.yaml");
    await writeFile(path, exampleModel);
    await writeFile(join(dir, "invalid.er.layout.json"), "{}");
    for (const args of [{ model: "version: 2", out }, { path, out }]) {
      const result = await client.callTool({ name: "render_er", arguments: args });
      expect(result.isError).toBe(true);
      expect(payload(result).writtenPaths).toEqual([]);
      expect((result.content as { type: string }[]).some((item) => item.type === "image")).toBe(false);
    }
    await expect(readFile(out)).rejects.toThrow();
  });
});
