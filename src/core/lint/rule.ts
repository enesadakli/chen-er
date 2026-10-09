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

export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
