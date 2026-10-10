import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rescoreResults } from "../bench/agent-eval/rescore.js";
import type { ScoreReport } from "../bench/agent-eval/score.js";
import { parseRequirements, serializeRequirements, textHash } from "../src/core/requirements.js";

const cli = fileURLToPath(new URL("../bench/agent-eval/rescore.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "chen-rescore-test-"));
  temporary.push(dir);
  return dir;
}

function fakeResults(root: string): string {
  const dir = join(root, "fake-results");
  mkdirSync(dir);
  const yaml = readFileSync(new URL("fixtures/agent-eval/kutuphane-candidate.er.yaml", import.meta.url), "utf8");
  const requirements = parseRequirements(readFileSync(new URL("../bench/agent-eval/scenarios/n-kutuphane-agi/requirements.md", import.meta.url), "utf8"));
  for (const item of requirements.items) { item.applied = textHash(item.text); item.trace = ["E:SUBE"]; }
  for (const [index, status] of ["ok", "error", "limit", "cancelled"].entries()) {
    const attempt = join(dir, `claude-n-kutuphane-agi-${index + 1}`);
    mkdirSync(attempt);
    writeFileSync(join(attempt, "model.er.yaml"), status === "limit" ? "version: [" :
      status === "cancelled" ? yaml.replace("multivalued: true", "multivalued: false") : yaml);
    writeFileSync(join(attempt, "model.er.requirements.md"), serializeRequirements(requirements));
    writeFileSync(join(attempt, "run.json"), JSON.stringify({ status, wallTimeMs: 1000, scenario: "ignored-stale-name", score: { overall: 0 } }));
    writeFileSync(join(attempt, "score.json"), '{ "old": true }\n');
  }
  writeFileSync(join(dir, "summary.md"), "Original summary\n");
  return dir;
}

function originals(dir: string): Map<string, Buffer> {
  return new Map(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(dir.length + 1), readFileSync(path)];
    }));
}

describe("offline rescore", () => {
  it("rescores a temporary copy, preserves every original byte and retains failed statuses", () => {
    const root = workspace(), source = fakeResults(root), copy = join(root, "copy");
    cpSync(source, copy, { recursive: true });
    const before = originals(copy);
    execFileSync(tsx, [cli, copy], { encoding: "utf8" });
    for (const [path, bytes] of before) expect(readFileSync(join(copy, path))).toEqual(bytes);
    expect(originals(source)).toEqual(before);
    const score = JSON.parse(readFileSync(join(copy, "claude-n-kutuphane-agi-1/score.rescored.json"), "utf8")) as ScoreReport;
    expect(score.overall).toBe(1);
    expect(score.decisions!.accuracy).toBe(1);
    expect(score.trace!.coverage).toBe(1);
    const failed = JSON.parse(readFileSync(join(copy, "claude-n-kutuphane-agi-2/score.rescored.json"), "utf8")) as ScoreReport;
    expect(failed.overall).toBe(1);
    expect(readFileSync(join(copy, "claude-n-kutuphane-agi-3/score.rescored.json"), "utf8")).toBe("null\n");
    const cancelled = JSON.parse(readFileSync(join(copy, "claude-n-kutuphane-agi-4/score.rescored.json"), "utf8")) as ScoreReport;
    expect(cancelled.decisions!.accuracy).toBeLessThan(1);
    const text = readFileSync(join(copy, "summary.rescored.md"), "utf8");
    expect(text).toContain("| n-kutuphane-agi | natural | primary | 1/4 | 0.2500 |");
    expect(text).toContain("| 0.2500 | 1.00 |");
    for (const failure of cancelled.decisions!.failed) {
      expect(text).toContain(`| n-kutuphane-agi | 4 | ${failure.id} | ${failure.kind} | ${failure.reason} |`);
    }
    expect(originals(copy).size).toBe(before.size + 5);
  });

  it("supports --out without writing into the source results", () => {
    const root = workspace(), source = fakeResults(root), out = join(root, "rescored");
    const before = originals(source);
    execFileSync(tsx, [cli, source, "--out", out], { encoding: "utf8" });
    expect(originals(source)).toEqual(before);
    expect(existsSync(join(source, "summary.rescored.md"))).toBe(false);
    expect(originals(out).size).toBe(5);
    expect(existsSync(join(out, "claude-n-kutuphane-agi-1/score.rescored.json"))).toBe(true);
    expect(readFileSync(join(out, "summary.rescored.md"), "utf8")).toContain("# Requirements evaluation: claude");
  });

  it("prints help without needing a results directory", () => {
    const text = execFileSync(tsx, [cli, "--help"], { encoding: "utf8" });
    expect(text).toContain("rescore.ts <results dir> [--out <dir>]");
    expect(text).toContain("--help");
  });

  it("rejects unknown scenarios before writing any reports", () => {
    const root = workspace(), source = fakeResults(root);
    mkdirSync(join(source, "codex-n-unknown-scenario-1"));
    const before = originals(source);
    expect(() => rescoreResults(source)).toThrow("Unknown scenario: n-unknown-scenario");
    expect(originals(source)).toEqual(before);
  });

  it("rejects missing artifacts and invalid run metadata without modifying originals", () => {
    const root = workspace(), source = fakeResults(root);
    const run = join(source, "claude-n-kutuphane-agi-1/run.json");
    writeFileSync(run, JSON.stringify({ status: "running", wallTimeMs: 1000 }));
    const before = originals(source);
    expect(() => rescoreResults(source)).toThrow();
    expect(originals(source)).toEqual(before);
    writeFileSync(run, JSON.stringify({ status: "ok", wallTimeMs: 1000 }));
    rmSync(join(source, "claude-n-kutuphane-agi-1/model.er.requirements.md"));
    const missing = originals(source);
    expect(() => rescoreResults(source)).toThrow("model.er.requirements.md");
    expect(originals(source)).toEqual(missing);
  });

  it("reuses separate agent summaries for mixed result directories", () => {
    const source = fakeResults(workspace());
    cpSync(join(source, "claude-n-kutuphane-agi-1"), join(source, "codex-n-kutuphane-agi-1"), { recursive: true });
    rescoreResults(source);
    const text = readFileSync(join(source, "summary.rescored.md"), "utf8");
    expect(text).toContain("# Requirements evaluation: claude");
    expect(text).toContain("# Requirements evaluation: codex");
    expect(text).toContain("| n-kutuphane-agi | natural | primary | 1/1 | 1.0000 |");
  });
});
