import { z } from "zod";
import { initFile, lintFile, quality, readPins, renderFile, writeRenderOutputs } from "../app/render.js";
import { hasErrors, type Diagnostic, type Severity } from "../core/diagnostics.js";
import type { LayoutOptions } from "../core/geometry.js";
import { LINT_DISCLAIMER, RULES } from "../core/lint/index.js";
import { Model } from "../core/schema.js";

export interface CommandResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface RenderCommandOptions {
  out?: string;
  png?: boolean;
  scale?: number;
  engine?: LayoutOptions["engine"];
  report?: boolean;
  json?: boolean;
  /** Ignore saved soft positions and lay the diagram out from scratch (pins still apply). */
  fresh?: boolean;
  /** `--no-pins` sets this to false: ignore the layout file entirely (pins, positions and engine). */
  pins?: boolean;
}

export interface LintCommandOptions {
  json?: boolean;
  disable?: string;
  course?: boolean;
  heuristic?: boolean;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((d) =>
    `${d.severity}:${d.line ?? "?"}:${d.column ?? "?"} [${d.rule}] ${d.message}${d.hint ? `\n  hint: ${d.hint}` : ""}`,
  ).join("\n");
}

function failure(error: unknown): CommandResult {
  return { exitCode: 2, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

export async function renderCommand(modelPath: string, options: RenderCommandOptions = {}): Promise<CommandResult> {
  try {
    if (options.engine && !["layered", "stress", "simple"].includes(options.engine)) {
      throw new Error("Engine must be layered, stress or simple.");
    }
    const scale = options.scale ?? 2;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be a positive finite number.");
    const noPins = options.pins === false;
    const result = await renderFile(
      modelPath,
      { ...(options.engine ? { engine: options.engine } : {}), ...(options.fresh ? { positions: {} } : {}) },
      { noPins, advise: true },
    );
    const outputs = result.svg
      ? writeRenderOutputs(result.svg, options.out ?? modelPath.replace(/(\.er)?\.ya?ml$/i, "") + ".svg", options.png, scale)
      : [];
    const report = options.report && result.diagram
      ? quality(result.diagram, noPins ? {} : readPins(modelPath).options.pins)
      : undefined;
    return {
      exitCode: hasErrors(result.diagnostics) ? 1 : 0,
      stdout: options.json
        ? JSON.stringify({ outputs, diagnostics: result.diagnostics, ...(report ? { quality: report } : {}) })
        : [...outputs, ...(report ? [JSON.stringify(report, null, 2)] : [])].join("\n"),
      stderr: [...(result.notes ?? []), ...(options.json ? [] : [formatDiagnostics(result.diagnostics)])].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return failure(error);
  }
}

export function lintCommand(modelPath: string, options: LintCommandOptions = {}): CommandResult {
  try {
    const disableSeverities: Severity[] = [];
    if (options.course === false) disableSeverities.push("course");
    if (options.heuristic === false) disableSeverities.push("heuristic");
    const result = lintFile(modelPath, {
      disable: options.disable?.split(",").map((id) => id.trim()).filter(Boolean),
      disableSeverities,
    });
    return {
      exitCode: hasErrors(result.diagnostics) ? 1 : 0,
      stdout: options.json
        ? JSON.stringify({ diagnostics: result.diagnostics, disclaimer: LINT_DISCLAIMER })
        : [formatDiagnostics(result.diagnostics), LINT_DISCLAIMER].filter(Boolean).join("\n"),
      stderr: "",
    };
  } catch (error) {
    return failure(error);
  }
}

export function schemaCommand(): CommandResult {
  try {
    return { exitCode: 0, stdout: JSON.stringify(z.toJSONSchema(Model, { target: "draft-2020-12", io: "input" }), null, 2), stderr: "" };
  } catch (error) {
    return failure(error);
  }
}

export function initCommand(file = "model.er.yaml", options: { force?: boolean } = {}): CommandResult {
  try {
    initFile(file, options.force);
    return { exitCode: 0, stdout: file, stderr: "" };
  } catch (error) {
    return failure(error);
  }
}

export function rulesCommand(): CommandResult {
  const rows = [["id", "severity", "description"], ...RULES.map((r) => [r.id, r.severity, r.description])];
  const widths = [0, 1].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  return {
    exitCode: 0,
    stdout: rows.map((row) => `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]}`).join("\n"),
    stderr: "",
  };
}

export interface ServeCommandOptions {
  port?: number;
  open?: boolean;
  engine?: LayoutOptions["engine"];
  /** `claude` enables the agent panel; `codex` is reserved. */
  agent?: string;
  agentCwd?: string;
}

/** Maps CLI flags to the server's agent options; throws a usage message for unsupported combinations. */
export function agentOptions(options: Pick<ServeCommandOptions, "agent" | "agentCwd">): { kind: "claude"; cwd?: string } | undefined {
  if (options.agent === undefined) {
    if (options.agentCwd !== undefined) throw new Error("--agent-cwd requires --agent claude.");
    return undefined;
  }
  if (options.agent === "codex") throw new Error("--agent codex is not supported yet. Use --agent claude.");
  if (options.agent !== "claude") throw new Error(`Unknown agent: ${options.agent}. Use --agent claude.`);
  return { kind: "claude", ...(options.agentCwd !== undefined ? { cwd: options.agentCwd } : {}) };
}

export async function serveCommand(modelPath: string, options: ServeCommandOptions = {}) {
  const agent = agentOptions(options);
  const { serve } = await import("../app/serve.js");
  return serve(modelPath, { port: options.port, open: options.open, engine: options.engine, ...(agent ? { agent } : {}) });
}
