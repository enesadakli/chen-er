import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseModel } from "../core/normalize.js";
import { mapModel, type MappingResponse } from "../core/map/index.js";

export function mapText(text: string): MappingResponse {
  const parsed = parseModel(text);
  if (!parsed.model) return { diagnostics: parsed.diagnostics };
  const result = mapModel(parsed.model);
  return { ...result, diagnostics: [...parsed.diagnostics, ...result.diagnostics] };
}
export const mapFile = (path: string) => mapText(readFileSync(path, "utf8"));

export function writeMappingOutput(modelPath: string, out: string, content: string): void {
  if (resolve(modelPath) === resolve(out)) throw new Error("Mapping output must differ from the input model path.");
  writeFileSync(out, content);
}
