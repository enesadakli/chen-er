import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getSchema, lintEr, lintInput, renderEr, renderInput, type ToolIO } from "./tools.js";

const fileIO: ToolIO = {
  readText: (path) => readFile(path, "utf8"),
  write: async (path, data) => { await writeFile(path, data); },
};

async function safely(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] };
  }
}

export function createServer(io: ToolIO = fileIO): McpServer {
  const server = new McpServer({ name: "chen-er", version: "0.1.0" });
  server.registerTool("get_schema", {
    description: "Get the authoritative draft-2020-12 ER model schema, annotated YAML example, notation cheat sheet and available lint rules. Start here before writing a model.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => safely(getSchema));
  server.registerTool("lint_er", {
    description: "Parse and lint Chen ER YAML. Supply exactly one of model text or file path. Returns JSON diagnostics and a correctness disclaimer; fix errors before rendering.",
    inputSchema: lintInput,
    annotations: { readOnlyHint: true },
  }, (input) => safely(() => lintEr(input, io)));
  server.registerTool("render_er", {
    description: "Render Chen ER YAML and return a PNG image for visual inspection plus JSON diagnostics and written paths. Supply exactly one of model or path. File input loads sibling .er.layout.json pins. Optional out writes SVG and PNG, replacing existing files. Inspect the image and revise the model or pins as needed.",
    inputSchema: renderInput,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, (input) => safely(() => renderEr(input, io)));
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
