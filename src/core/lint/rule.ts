import type { Diagnostic, Severity } from "../diagnostics.js";
import type { NModel } from "../normalize.js";

export interface Rule {
  id: string;
  severity: Severity;
  description: string;
  check(model: NModel): Diagnostic[];
}

export function finding(model: NModel, rule: Rule, path: string, message: string, hint: string): Diagnostic {
  return { rule: rule.id, severity: rule.severity, message, hint, path, ...model.locate(path) };
}

/**
 * A heuristic whose suspicion the author already answered in a relationship `note` stays visible
 * but drops to info, so "justify it in a note" is an instruction that actually resolves the finding.
 */
export function justified(d: Diagnostic, note: string | undefined): Diagnostic {
  if (!note) return d;
  return { ...d, severity: "info", message: `${d.message} Justified by note: "${note}"`, hint: "No action needed unless the note no longer holds." };
}

export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
