// Runs one headless agent process and turns its stream into steps and a final outcome.
import { spawn } from "node:child_process";
import { parseStreamLine, type Step } from "./agent-stream.js";

export type RunStatus = "ok" | "error" | "cancelled" | "limit";
export interface RunOutcome { status: RunStatus; reply?: string; error?: string; sessionId?: string }
export interface RunOptions {
  bin: string;
  args: string[];
  cwd: string;
  onStep(step: Step): void;
  /** Delay between SIGTERM and SIGKILL on cancel. */
  killAfterMs?: number;
}
export interface RunHandle { done: Promise<RunOutcome>; cancel(): Promise<RunOutcome> }

const LIMIT = /usage limit|limit reached|hit your (?:usage )?limit/i;
const STDERR_LINES = 20;

export function tail(text: string, lines = STDERR_LINES): string {
  return text.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n");
}

export interface ExitFacts {
  code: number | null;
  cancelled: boolean;
  spawnError?: NodeJS.ErrnoException;
  bin: string;
  result?: { text: string; isError: boolean };
  lastText?: string;
  stderr: string;
}

/** Pure classification of a finished process. */
export function classifyExit(facts: ExitFacts): Omit<RunOutcome, "sessionId"> {
  const reply = facts.result?.text || facts.lastText;
  const stderr = tail(facts.stderr);
  if (facts.cancelled) return { status: "cancelled", ...(reply ? { reply } : {}) };
  if (facts.spawnError) {
    const missing = facts.spawnError.code === "ENOENT";
    return { status: "error", error: missing
      ? `The ${facts.bin} command was not found. Install Claude Code, run \`claude\`, then \`/login\`.`
      : `Could not start ${facts.bin}: ${facts.spawnError.message}` };
  }
  const failed = facts.code !== 0 || facts.result?.isError === true;
  const resultText = facts.result?.text ?? "";
  // A short final result such as "Claude AI usage limit reached|…" can arrive even with exit 0.
  if (LIMIT.test(stderr) || ((failed || resultText.length < 300) && LIMIT.test(resultText))) {
    return { status: "limit", error: tail(resultText || stderr) };
  }
  if (failed) return { status: "error", error: stderr || tail(resultText) || `${facts.bin} exited with code ${facts.code}.` };
  return { status: "ok", ...(reply ? { reply } : {}) };
}

export function runAgent(options: RunOptions): RunHandle {
  let sessionId: string | undefined;
  let result: ExitFacts["result"];
  let lastText: string | undefined;
  let stderr = "";
  let buffer = "";
  let cancelled = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(options.bin, options.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const line = (raw: string) => {
    const update = parseStreamLine(raw);
    if (update.sessionId) sessionId = update.sessionId;
    if (update.result) result = update.result;
    if (update.lastText) lastText = update.lastText;
    for (const step of update.steps) options.onStep(step);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) if (raw.trim()) line(raw);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65_536); });
  const done = new Promise<RunOutcome>((settle) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (buffer.trim()) line(buffer);
      buffer = "";
      const outcome = classifyExit({ code, cancelled, spawnError, bin: options.bin, result, lastText, stderr });
      settle({ ...outcome, ...(sessionId ? { sessionId } : {}) });
    };
    child.once("error", (error) => {
      spawnError = error;
      // A process that never started emits no reliable close event.
      if (child.pid === undefined) finish(null);
    });
    child.once("close", (code) => finish(code));
  });
  return {
    done,
    cancel() {
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        cancelled = true;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), options.killAfterMs ?? 3000);
      }
      return done;
    },
  };
}
