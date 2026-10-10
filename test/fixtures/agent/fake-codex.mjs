#!/usr/bin/env node
// Stand-in for `codex exec --json ...` used by the agent panel tests. Event shapes follow codex-exec.jsonl,
// recorded from codex-cli 0.160.
// FAKE_AGENT_MODE: ok (default) | error | limit | login | slow | stubborn | noedit
// FAKE_AGENT_LOG: append one JSON line per run with argv and cwd.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGENT_MODE ?? "ok";
const prompt = args.at(-1) ?? "";
const resume = args.includes("resume") ? args[args.indexOf("resume") + 1] : undefined;
const thread = resume ?? "fake-thread-1";
const model = /^Model file: (.+)$/m.exec(prompt)?.[1];
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
process.stderr.write("Reading additional input from stdin...\n");

out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
process.stdout.write("this line is not json\n");

if (mode === "error") {
  process.stderr.write(Array.from({ length: 25 }, (_, i) => `stderr line ${i + 1}`).join("\n") + "\n");
  process.exit(3);
}
if (mode === "limit" || mode === "login") {
  const message = mode === "limit"
    ? "You've hit your usage limit. Try again in 2 hours."
    : "unexpected status 401 Unauthorized: Please run `codex login`.";
  out({ type: "error", message });
  out({ type: "turn.failed", error: { message } });
  process.exit(1);
}
const command = (id, text, status) => out({ type: status === "in_progress" ? "item.started" : "item.completed",
  item: { id, type: "command_execution", command: `/bin/zsh -lc '${text}'`, aggregated_output: "", exit_code: status === "in_progress" ? null : 0, status } });
if (mode === "slow" || mode === "stubborn") {
  if (mode === "stubborn") process.on("SIGTERM", () => { /* ignore */ });
  command("item_0", `cat ${model}`, "in_progress");
  setTimeout(() => process.exit(0), 30_000);
} else {
  out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Thinking." } });
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Adding the attribute.\n" } });
  command("item_2", `cat ${model}`, "in_progress");
  command("item_2", `cat ${model}`, "completed");
  if (mode !== "noedit" && model) {
    out({ type: "item.started", item: { id: "item_3", type: "file_change", changes: [{ path: model, kind: "update" }], status: "in_progress" } });
    const text = readFileSync(model, "utf8");
    writeFileSync(model, text.replace(/^(    attrs:\n)/m, "$1      - BirthDate\n"));
    out({ type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: model, kind: "update" }], status: "completed" } });
  }
  command("item_4", "npx tsx lint model.er.yaml", "in_progress");
  command("item_4", "npx tsx lint model.er.yaml", "completed");
  out({ type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Added BirthDate to the first entity." } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
}
