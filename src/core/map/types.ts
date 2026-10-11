import type { Diagnostic } from "../diagnostics.js";

export type MappingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface MappingExplanation {
  step: MappingStep;
  elementIds: string[];
  reason: string;
}
export interface MappingColumn {
  name: string;
  sourceIds: string[];
  notNull: boolean;
}
export interface MappingForeignKey {
  columns: string[];
  references: { relation: string; columns: string[] };
  sourceIds: string[];
}
export interface MappingRelation extends MappingExplanation {
  name: string;
  columns: MappingColumn[];
  primaryKey: string[];
  uniqueKeys: string[][];
  foreignKeys: MappingForeignKey[];
  /** Includes the producing step and later steps that add columns or constraints. */
  steps: MappingExplanation[];
}
export interface MappingResult {
  relations: MappingRelation[];
  notes: string[];
}
export interface MappingResponse {
  mapping?: MappingResult;
  diagnostics: Diagnostic[];
}
