/**
 * Diagnostics shared by parsing, linting and layout.
 *
 * Severities:
 * - error:     the model is malformed or breaks an ER rule; rendering may be wrong.
 * - course:    breaks a course convention (e.g. generic relationship names); can be disabled.
 * - heuristic: a suspicion worth a look (e.g. two paths carrying the same fact); can be disabled.
 * - info:      a hint, never a problem by itself.
 *
 * Zero errors never means the model is right: it only means nothing obviously wrong was found.
 */
export type Severity = "error" | "course" | "heuristic" | "info";

export interface Diagnostic {
  /** Stable rule id, e.g. "weak-entity-without-identifying-relationship". */
  rule: string;
  severity: Severity;
  message: string;
  /** How to fix it, phrased as an instruction an agent can follow. */
  hint?: string;
  /** Dotted path into the model, e.g. "relationships.DEFINES.ends.1.card". */
  path?: string;
  /** 1-based source position when the path maps to the YAML file. */
  line?: number;
  column?: number;
}

export const hasErrors = (ds: readonly Diagnostic[]): boolean => ds.some((d) => d.severity === "error");
