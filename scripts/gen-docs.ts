import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFile, writeRenderOutputs } from "../src/app/render.js";
import { hasErrors } from "../src/core/diagnostics.js";
import { formatDiagnostics } from "../src/cli/commands.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const examples = resolve(root, "examples");
const docs = resolve(root, "docs");
const names = (await readdir(examples, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".er.yaml"))
  .map((entry) => entry.name)
  .sort();

if (!names.length) throw new Error("No public .er.yaml examples found.");
await mkdir(docs, { recursive: true });
for (const name of names) {
  const result = await renderFile(resolve(examples, name), { positions: {} });
  if (result.diagnostics.length) console.error(`${name}\n${formatDiagnostics(result.diagnostics)}`);
  if (!result.svg || hasErrors(result.diagnostics)) throw new Error(`Cannot render ${name}.`);
  const out = resolve(docs, name.replace(/\.er\.yaml$/, ".svg"));
  writeRenderOutputs(result.svg, out, true);
  console.log(`docs/${name.replace(/\.er\.yaml$/, ".svg + .png")}`);
}
