import { Command, CommanderError, Option } from "commander";
import {
  initCommand, lintCommand, renderCommand, rulesCommand, schemaCommand,
  type CommandResult, type LintCommandOptions, type RenderCommandOptions,
} from "./commands.js";

const program = new Command("chen")
  .description("Chen ER diagrams")
  .version("0.1.0")
  .addHelpText("after", "\nExit codes: 0 ok; 1 model errors (parse/schema/lint); 2 usage or I/O failure.")
  .exitOverride();

function print(result: CommandResult): void {
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}

program.command("render")
  .argument("<model>", "path to a .er.yaml model")
  .option("-o, --out <file>", "output SVG path (default: next to the model)")
  .option("--png", "also write a PNG")
  .option("--scale <number>", "PNG scale (positive number)", Number, 2)
  .addOption(new Option("--engine <name>", "layout engine").choices(["layered", "stress", "simple"]))
  .option("--report", "print the quality report")
  .option("--json", "print one JSON object")
  .action(async (model: string, options: RenderCommandOptions) => print(await renderCommand(model, options)));

program.command("lint")
  .argument("<model>", "path to a .er.yaml model")
  .option("--json", "print diagnostics and disclaimer as JSON")
  .option("--disable <rules>", "comma-separated rule ids to disable")
  .option("--no-course", "disable course findings")
  .option("--no-heuristic", "disable heuristic findings")
  .action((model: string, options: LintCommandOptions) => print(lintCommand(model, options)));

program.command("schema").description("print the model JSON Schema")
  .action(() => print(schemaCommand()));
program.command("init").description("write a commented starter model")
  .argument("[file]", "output model path", "model.er.yaml")
  .option("--force", "overwrite an existing file")
  .action((file: string, options: { force?: boolean }) => print(initCommand(file, options)));
program.command("rules").description("list lint rules")
  .action(() => print(rulesCommand()));

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
});
