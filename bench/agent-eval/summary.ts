import type { AgentKind, RunStatus } from "../../src/app/agent-runner.js";
import type { ScoreReport } from "./score.js";
import type { ScenarioSet } from "./scenarios.js";

export interface SummaryRecord {
  scenario: string;
  set: ScenarioSet;
  run: number;
  status: RunStatus;
  wallTimeMs: number;
  hasChecks: boolean;
  score: ScoreReport | null;
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

export function summary(agent: AgentKind, records: readonly SummaryRecord[]): string {
  const lines = [`# Requirements evaluation: ${agent}`, "", "Failed, limited, cancelled, or unparseable attempts contribute zero to score means. Time includes every attempt.", "",
    "| Scenario | Set | Variant | Runs (ok/total) | Overall mean | Entity F1 | Rel F1 | Attr F1 | Key acc | Card acc | Decisions | Time (mean s) |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const scenario of [...new Set(records.map((record) => record.scenario))]) {
    const runs = records.filter((record) => record.scenario === scenario);
    const mean = (pick: (report: ScoreReport) => number): string =>
      (runs.reduce((sum, record) => sum + (record.status === "ok" && record.score ? pick(record.score) : 0), 0) / runs.length).toFixed(4);
    const counts = new Map<string, number>();
    for (const run of runs) if (run.score) counts.set(run.score.goldVariant, (counts.get(run.score.goldVariant) ?? 0) + 1);
    const variant = [...counts].sort(([a, ac], [b, bc]) => bc - ac || Number(b === "primary") - Number(a === "primary") || compare(a, b))[0]?.[0] ?? "—";
    const decisions = runs.some((r) => r.hasChecks) ? mean((s) => s.decisions?.accuracy ?? 0) : "—";
    lines.push(`| ${cell(scenario)} | ${runs[0]!.set} | ${variant} | ${runs.filter((record) => record.status === "ok").length}/${runs.length} | ${mean((s) => s.overall)} | ${mean((s) => s.entities.f1)} | ${mean((s) => s.relationships.f1)} | ${mean((s) => s.attributes.f1)} | ${mean((s) => s.keys.accuracy)} | ${mean((s) => s.cardinality.accuracy)} | ${decisions} | ${(runs.reduce((sum, r) => sum + r.wallTimeMs, 0) / runs.length / 1000).toFixed(2)} |`);
  }
  lines.push("", "## Failed decision checks", "", "| Scenario | Run | Check id | Kind | Reason |", "| --- | ---: | --- | --- | --- |");
  for (const record of records) for (const failure of record.score?.decisions?.failed ?? []) {
    lines.push(`| ${cell(record.scenario)} | ${record.run} | ${cell(failure.id)} | ${failure.kind} | ${cell(failure.reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}
