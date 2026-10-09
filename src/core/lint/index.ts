import type { Diagnostic, Severity } from "../diagnostics.js";
import type { NModel } from "../normalize.js";
import { courseRules } from "./course.js";
import { heuristicRules } from "./heuristics.js";
import { infoRules } from "./info.js";
import { compareText } from "./rule.js";
import { structureRules } from "./structure.js";
import { weakRules } from "./weak.js";

/**
 * Public lint metadata and filtering options.
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

const rules = [...structureRules, ...weakRules, ...courseRules, ...heuristicRules, ...infoRules];

export const RULES: RuleInfo[] = rules.map(({ id, severity, description }) => ({ id, severity, description }));

const severityOrder: Record<Severity, number> = { error: 0, warning: 1, course: 2, heuristic: 3, info: 4 };

export function lint(model: NModel, options: LintOptions = {}): Diagnostic[] {
  const disabled = new Set(options.disable);
  const disabledSeverities = new Set(options.disableSeverities);
  return rules.filter((rule) => !disabled.has(rule.id) && !disabledSeverities.has(rule.severity))
    .flatMap((rule) => rule.check(model))
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] ||
      (a.line ?? Infinity) - (b.line ?? Infinity) || compareText(a.rule, b.rule) ||
      compareText(a.path ?? "", b.path ?? "") || compareText(a.message, b.message));
}

/** Printed after every lint run: a clean result is not a proof of a correct model. */
export const LINT_DISCLAIMER = "0 errors does not mean the model is right; it means nothing obviously wrong was found.";
