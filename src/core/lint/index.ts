import type { Diagnostic, Severity } from "../diagnostics.js";
import type { NModel } from "../normalize.js";

/**
 * Lint contract. Implemented by the lint lane; until then it returns no findings.
 */
export interface RuleInfo {
  id: string;
  severity: Severity;
  /** One sentence describing what the rule checks. */
  description: string;
}

export interface LintOptions {
  /** Rule ids to skip. */
  disable?: string[];
  /** Skip whole severity groups, e.g. ["course", "heuristic"]. */
  disableSeverities?: Severity[];
}

export const RULES: RuleInfo[] = [];

export function lint(model: NModel, options: LintOptions = {}): Diagnostic[] {
  void model;
  void options;
  return [];
}

/** Printed after every lint run: a clean result is not a proof of a correct model. */
export const LINT_DISCLAIMER = "0 errors does not mean the model is right; it means nothing obviously wrong was found.";
