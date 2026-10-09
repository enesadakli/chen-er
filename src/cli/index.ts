import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { renderFile, svgToPng } from "../app/render.js";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";

/**
 * Exit codes: 0 ok · 1 model has errors · 2 usage or I/O failure.
 * Minimal vertical-slice CLI; the CLI lane adds lint, serve, schema and init.
 */
const program = new Command("chen").description("Agent-first Chen ER diagrams").version("0.1.0");

program
  .command("render")
  .argument("<model>", "path to a .er.yaml model")
  .option("-o, --out <file>", "output SVG path (default: next to the model)")
  .option("--png", "also write a PNG")
  .option("--engine <name>", "layout engine: layered | stress | simple")
  .action(async (model: string, opts: { out?: string; png?: boolean; engine?: "layered" | "stress" | "simple" }) => {
    const res = await renderFile(model, opts.engine ? { engine: opts.engine } : {});
    printDiagnostics(res.diagnostics);
    if (!res.svg) return void (process.exitCode = 1);
    const out = opts.out ?? model.replace(/(\.er)?\.ya?ml$/i, "") + ".svg";
    writeFileSync(out, res.svg);
    console.log(out);
    if (opts.png) {
      const png = out.replace(/\.svg$/i, "") + ".png";
      writeFileSync(png, svgToPng(res.svg));
      console.log(png);
    }
    if (hasErrors(res.diagnostics)) process.exitCode = 1;
  });

function printDiagnostics(ds: Diagnostic[]) {
  for (const d of ds) {
    const where = d.line ? `:${d.line}:${d.column ?? 1}` : "";
    console.error(`${d.severity}${where} [${d.rule}] ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ""}`);
  }
}

program.parseAsync().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 2;
});
