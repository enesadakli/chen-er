import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reportCommand } from "../src/cli/commands.js";
import { exampleModel } from "../src/mcp/tools.js";

let dir: string, path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chen-report-")); path = join(dir, "library.er.yaml"); writeFileSync(path, exampleModel); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "report", path, ...args], { encoding: "utf8" });

it("writes Markdown and sibling SVG with relative reference and deterministic bytes", async () => {
  writeFileSync(join(dir, "library.er.requirements.md"), "# Requirements\n\n1. Each copy belongs to a book. <!-- chen-er {\"id\":\"r1\"} -->\n");
  const out = join(dir, "library.report.md"), svg = join(dir, "library.report.svg");
  const result = await reportCommand(path);
  expect(result).toMatchObject({ exitCode: 0, stdout: `${out}\n${svg}` });
  const md = readFileSync(out, "utf8"), diagram = readFileSync(svg, "utf8");
  expect(md).toContain("![ER diagram](library.report.svg)");
  expect(md).toContain("Not applied yet");
  expect(md).toContain("No requirement has been applied to the model yet, so traceability is not available.");
  expect(md).not.toContain("Untraced elements");
  expect(md).not.toContain(dir);
  expect(diagram).toContain("<svg");
  expect((await reportCommand(path)).exitCode).toBe(0);
  expect(readFileSync(out, "utf8")).toBe(md);
  expect(readFileSync(svg, "utf8")).toBe(diagram);
  const custom = join(dir, "custom name.md");
  expect((await reportCommand(path, { out: custom })).exitCode).toBe(0);
  expect(readFileSync(custom, "utf8")).toContain("custom%20name.svg");
  const special = join(dir, "custom #(name.md");
  expect((await reportCommand(path, { out: special })).exitCode).toBe(0);
  expect(readFileSync(special, "utf8")).toContain("custom%20%23%28name.svg");
});

it("registers CLI flags and writes one self-contained HTML file", () => {
  const result = run(["--format", "html"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(join(dir, "library.report.html"));
  expect(readdirSync(dir).sort()).toEqual(["library.er.yaml", "library.report.html"]);
  const html = readFileSync(join(dir, "library.report.html"), "utf8");
  expect(html).toContain("<svg");
  expect(html).toContain("size: A4");
  expect(html).toContain("page-break-inside: avoid");
  expect(html.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:\/\//);
  expect(html).not.toMatch(/<(?:script|link|img)\b/);
  expect(run(["--format", "wrong"]).status).toBe(2);
});

it("refuses the model path and aliases and returns usage and IO errors", async () => {
  expect(run(["--out", path]).status).toBe(2);
  const alias = join(dir, "alias.md");
  symlinkSync(path, alias);
  expect((await reportCommand(path, { out: alias })).exitCode).toBe(2);
  expect(readFileSync(path, "utf8")).toBe(exampleModel);
  expect((await reportCommand(join(dir, "absent.yaml"))).exitCode).toBe(2);
  expect((await reportCommand(path, { out: join(dir, "absent", "out.md") })).exitCode).toBe(2);
});

it.each(["version: 2", exampleModel.replace("entity: BOOK", "entity: UNKNOWN")])("returns exit 1 for invalid models without writing anything", (yaml) => {
  writeFileSync(path, yaml);
  const result = run([]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("error:");
  expect(result.stdout).toBe("");
  expect(readdirSync(dir)).toEqual(["library.er.yaml"]);
});

it("applies the same layout file as rendering and --no-pins ignores it", async () => {
  const saved = join(dir, "library.er.layout.json");
  const pins = JSON.stringify({ version: 1, engine: "simple", pins: { "E:BOOK": { x: 1300, y: 900 } } });
  writeFileSync(saved, pins);
  expect((await reportCommand(path)).exitCode).toBe(0);
  const pinned = readFileSync(join(dir, "library.report.svg"), "utf8");
  expect(run(["--no-pins"]).status).toBe(0);
  expect(readFileSync(join(dir, "library.report.svg"), "utf8")).not.toBe(pinned);
  expect(readFileSync(saved, "utf8")).toBe(pins);
  writeFileSync(saved, "invalid");
  expect((await reportCommand(path)).exitCode).toBe(1);
  expect((await reportCommand(path, { pins: false })).exitCode).toBe(0);
});
