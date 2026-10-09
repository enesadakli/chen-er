import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand, lintCommand, renderCommand, rulesCommand, schemaCommand } from "../src/cli/commands.js";
import { layoutPathFor, lintText, quality, readPins, renderText, writePins } from "../src/app/render.js";
import { LINT_DISCLAIMER, RULES } from "../src/core/lint/index.js";

let dir: string;
let model: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chen-cli-"));
  model = join(dir, "sample.er.yaml");
  initCommand(model);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CLI commands and app services", () => {
  it("writes SVG and PNG and reports JSON in one object", async () => {
    const result = await renderCommand(model, { png: true, scale: 1, json: true, report: true, engine: "simple" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const data = JSON.parse(result.stdout);
    expect(data.outputs).toEqual([join(dir, "sample.svg"), join(dir, "sample.png")]);
    expect(data.diagnostics).toEqual([]);
    expect(data.quality).toHaveProperty("implemented");
    expect(readFileSync(data.outputs[0], "utf8")).toContain("<svg");
    expect(readFileSync(data.outputs[1]).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("respects explicit output paths and prints a human quality report", async () => {
    const out = join(dir, "chosen.svg");
    const result = await renderCommand(model, { out, report: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(out);
    expect(result.stdout).toContain('"overlaps"');
  });

  it("returns model errors with source positions and the disclaimer", async () => {
    writeFileSync(model, "version: 2\nentities: {}\n");
    const result = lintCommand(model);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/error:1:10 \[schema\]/);
    expect(result.stdout).toContain("hint:");
    expect(result.stdout.endsWith(LINT_DISCLAIMER)).toBe(true);
    const data = JSON.parse(lintCommand(model, { json: true }).stdout);
    expect(data.diagnostics[0].severity).toBe("error");
    expect(data.disclaimer).toBe(LINT_DISCLAIMER);
    const rendered = await renderCommand(model, { json: true });
    expect(rendered.exitCode).toBe(1);
    expect(JSON.parse(rendered.stdout).outputs).toEqual([]);
    expect(lintText("version: [").model).toBeUndefined();
  });

  it("refuses overwrite unless force is supplied", () => {
    writeFileSync(model, "keep me");
    expect(initCommand(model).exitCode).toBe(2);
    expect(readFileSync(model, "utf8")).toBe("keep me");
    expect(initCommand(model, { force: true }).exitCode).toBe(0);
    expect(lintCommand(model).exitCode).toBe(0);
    expect(readFileSync(model, "utf8")).toContain("# Chen ER model");
  });

  it("prints a runtime JSON Schema and the rule table", () => {
    const result = schemaCommand();
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.version.const).toBe(1);
    expect(schema.required).toContain("entities");
    expect(rulesCommand().stdout).toContain("id");
    for (const rule of RULES) expect(rulesCommand().stdout).toContain(rule.id);
  });

  it("writes validated, sorted version 1 pins next to the model", async () => {
    const pins = { "E:STUDENT": { y: 200, x: 100 }, "E:COURSE": { x: 400, y: 200 } };
    writePins(model, pins);
    const raw = readFileSync(layoutPathFor(model), "utf8");
    expect(raw).toBe(JSON.stringify({ version: 1, pins: {
      "E:COURSE": { x: 400, y: 200 }, "E:STUDENT": { x: 100, y: 200 },
    } }, null, 2) + "\n");
    expect(readPins(model).options.pins).toEqual(pins);
    const rendered = await renderText(readFileSync(model, "utf8"));
    expect(quality(rendered.diagram!, pins)).toHaveProperty("issues");
    expect(() => writePins(model, { invalid: { x: NaN, y: 2 } })).toThrow();
    writeFileSync(layoutPathFor(model), "broken");
    expect(readPins(model).diagnostics[0]?.rule).toBe("layout-file");
  });

  it("returns code 2 for I/O and invalid options", async () => {
    expect(lintCommand(join(dir, "missing.yaml")).exitCode).toBe(2);
    expect((await renderCommand(model, { scale: 0 })).exitCode).toBe(2);
    expect((await renderCommand(model, { scale: Infinity })).exitCode).toBe(2);
    expect((await renderCommand(model, { out: join(dir, "missing", "out.svg") })).exitCode).toBe(2);
  });

  it("wires help, usage exit codes, and JSON without extra stdout", () => {
    const args = ["--import", "tsx", "src/cli/index.ts"];
    const help = execFileSync(process.execPath, [...args, "--help"], { encoding: "utf8" });
    expect(help).toContain("Exit codes: 0 ok; 1 model errors");
    expect(help).toContain("schema");
    const json = execFileSync(process.execPath, [...args, "lint", model, "--json", "--no-course", "--no-heuristic", "--disable", "foo,bar"], { encoding: "utf8" });
    expect(JSON.parse(json)).toHaveProperty("disclaimer");
    expect(spawnSync(process.execPath, [...args, "render", model, "--engine", "invalid"]).status).toBe(2);
    expect(spawnSync(process.execPath, [...args, "lint"]).status).toBe(2);
  });

  it("documents --no-pins and parses it as a flag that leaves the layout file alone", () => {
    const args = ["--import", "tsx", "src/cli/index.ts"];
    const help = execFileSync(process.execPath, [...args, "render", "--help"], { encoding: "utf8" });
    expect(help).toContain("--no-pins");
    expect(help).toContain("ignore the layout file entirely");
    writeFileSync(layoutPathFor(model), "broken");
    const run = spawnSync(process.execPath, [...args, "render", model, "--no-pins", "--json"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).outputs).toEqual([join(dir, "sample.svg")]);
    expect(readFileSync(layoutPathFor(model), "utf8")).toBe("broken");
  });
});
