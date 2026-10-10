import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { exampleModel } from "../src/mcp/tools.js";

let client: Client, server: ReturnType<typeof createServer>, dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chen-mcp-report-"));
  client = new Client({ name: "test-client", version: "1.0.0" }); server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
});
afterEach(async () => { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
const payload = (result: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((result.content as { type: string; text?: string }[]).find((c) => c.type === "text")!.text!);

it("registers a read-only report tool and returns Markdown without a file dependency", async () => {
  expect((await client.listTools()).tools.find((t) => t.name === "report_er")?.annotations?.readOnlyHint).toBe(true);
  const result = await client.callTool({ name: "report_er", arguments: { model: exampleModel } });
  expect(result.isError).not.toBe(true);
  const data = payload(result);
  expect(data.report).toContain("(diagram: call render_er)");
  expect(data.report).not.toContain("![");
  expect(data.report).toContain("## Relational schema");
  expect(data.diagnostics).toEqual([]);
  expect(await readdir(dir)).toEqual([]);
});

it("loads path requirements and returns inlined HTML without writing outputs", async () => {
  const path = join(dir, "library.er.yaml"), requirements = join(dir, "library.er.requirements.md");
  const bytes = "1. Copies belong to books. <!-- chen-er {\"id\":\"r1\"} -->\n";
  await writeFile(path, exampleModel); await writeFile(requirements, bytes);
  const result = await client.callTool({ name: "report_er", arguments: { path, format: "html" } });
  expect(result.isError).not.toBe(true);
  const data = payload(result);
  expect(data.report).toContain("<svg");
  expect(data.report).toContain("Not applied yet");
  expect(data.report).not.toContain(dir);
  expect((await readdir(dir)).sort()).toEqual(["library.er.requirements.md", "library.er.yaml"]);
  expect(await readFile(requirements, "utf8")).toBe(bytes);
});

it("rejects missing or ambiguous inputs, invalid formats and invalid models", async () => {
  for (const args of [{}, { model: exampleModel, path: "file.yaml" }, { model: exampleModel, format: "pdf" }, { model: "version: 2" }, { path: join(dir, "missing.yaml") }]) {
    expect((await client.callTool({ name: "report_er", arguments: args })).isError).toBe(true);
  }
  const result = payload(await client.callTool({ name: "report_er", arguments: { model: "version: 2" } }));
  expect(result.report).toBeUndefined();
  expect(result.diagnostics[0].severity).toBe("error");
});
