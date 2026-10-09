import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { renderFile, renderText, svgToPng } from "../app/render.js";
import { hasErrors, type Diagnostic } from "../core/diagnostics.js";
import { lint, RULES, LINT_DISCLAIMER } from "../core/lint/index.js";
import { parseModel } from "../core/normalize.js";
import { Model } from "../core/schema.js";

const source = {
  model: z.string().optional().describe("Complete .er.yaml model text. Supply exactly one of model or path."),
  path: z.string().min(1).optional().describe("Model file path on the server computer; relative to its working directory."),
};
const exactlyOne = (input: { model?: string; path?: string }) =>
  (input.model !== undefined) !== (input.path !== undefined);

export const lintInput = z.object({
  ...source,
  disable: z.array(z.string()).optional().describe("Lint rule ids to skip; structural parsing errors cannot be disabled."),
}).strict().refine(exactlyOne, "Supply exactly one of model or path.");

export const renderInput = z.object({
  ...source,
  engine: z.enum(["layered", "stress", "simple"]).optional(),
  out: z.string().regex(/\.svg$/i).optional().describe("Optional SVG output path. Also writes a sibling PNG; existing files are replaced."),
  scale: z.number().finite().positive().optional().describe("PNG zoom factor; default 2. Does not change SVG geometry."),
}).strict().refine(exactlyOne, "Supply exactly one of model or path.");

export interface ToolIO {
  readText(path: string): Promise<string>;
  write(path: string, data: string | Uint8Array): Promise<void>;
}

export const exampleModel = `version: 1
title: Library
entities:
  BOOK: {attrs: [ISBN, Title], keys: [[ISBN]]} # Candidate key
  COPY: {weak: true, attrs: [CopyNo], partialKey: [CopyNo]}
relationships:
  COPY_OF:
    identifies: COPY
    ends:
      - {entity: BOOK, card: 0..N} # A book participates zero or many times
      - {entity: COPY, card: 1..1} # Each copy belongs to exactly one book
notes: ["A copy exists only as a copy of a book."]
`;

const textResult = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function getSchema(): CallToolResult {
  return textResult({
    schema: z.toJSONSchema(Model, { target: "draft-2020-12", io: "input" }),
    example: exampleModel,
    notation: "(min,max) is the participation of the entity at THAT end. min 0 = partial; min >= 1 = total. Rectangles = entities; diamonds = relationships; ellipses = attributes. Double rectangle/diamond = weak entity/identifying relationship; double ellipse = multivalued; dashed ellipse = derived; underline = key; dashed underline = partial key. [[A],[B]] are separate candidate keys; [[A,B]] is one composite key.",
    rules: RULES,
    disclaimer: LINT_DISCLAIMER,
  });
}

export async function lintEr(input: z.infer<typeof lintInput>, io: ToolIO): Promise<CallToolResult> {
  const args = lintInput.parse(input);
  const parsed = parseModel(args.model ?? await io.readText(args.path!));
  const diagnostics = [...parsed.diagnostics, ...(parsed.model ? lint(parsed.model, { disable: args.disable }) : [])];
  return textResult({ diagnostics, disclaimer: LINT_DISCLAIMER }, hasErrors(diagnostics));
}

function summary(diagnostics: Diagnostic[]) {
  return Object.fromEntries(["error", "warning", "course", "heuristic", "info"].map((severity) =>
    [severity, diagnostics.filter((d) => d.severity === severity).length]));
}

export async function renderEr(input: z.infer<typeof renderInput>, io: ToolIO): Promise<CallToolResult> {
  const args = renderInput.parse(input);
  const options = args.engine ? { engine: args.engine } : {};
  const result = args.model !== undefined
    ? await renderText(args.model, options)
    : await renderFile(args.path!, options);
  const diagnostics = [...result.diagnostics, ...(result.model ? lint(result.model) : [])];
  if (!result.svg || hasErrors(diagnostics)) {
    return textResult({ diagnostics, summary: summary(diagnostics), writtenPaths: [], disclaimer: LINT_DISCLAIMER }, true);
  }
  const png = svgToPng(result.svg, args.scale);
  const writtenPaths: string[] = [];
  if (args.out) {
    const pngPath = args.out.replace(/\.svg$/i, ".png");
    await io.write(args.out, result.svg);
    writtenPaths.push(args.out);
    await io.write(pngPath, png);
    writtenPaths.push(pngPath);
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ diagnostics, summary: summary(diagnostics), writtenPaths, disclaimer: LINT_DISCLAIMER }) },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ],
  };
}
