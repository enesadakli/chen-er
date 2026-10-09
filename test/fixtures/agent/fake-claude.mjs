#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json` used by the agent panel tests.
// FAKE_AGENT_MODE: ok (default) | error | limit | slow | stubborn | layout | noedit
// FAKE_AGENT_LOG: append one JSON line per run with argv and cwd.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGENT_MODE ?? "ok";
const prompt = args[args.indexOf("-p") + 1] ?? "";
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const session = resume ?? "fake-session-1";
const model = /^Model file: (.+)$/m.exec(prompt)?.[1];
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

out({ type: "system", subtype: "init", session_id: session, tools: ["Edit", "Bash"] });
process.stdout.write("this line is not json\n");
out({ type: "something-new", session_id: session });

if (mode === "error") {
  process.stderr.write(Array.from({ length: 25 }, (_, i) => `stderr line ${i + 1}`).join("\n") + "\n");
  process.exit(3);
}
if (mode === "limit") {
  out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000", session_id: session });
  process.exit(1);
}
if (mode === "slow" || mode === "stubborn") {
  if (mode === "stubborn") process.on("SIGTERM", () => { /* ignore */ });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: model } }] }, session_id: session });
  setTimeout(() => process.exit(0), 30_000);
} else {
  out({ type: "assistant", message: { content: [{ type: "text", text: "Adding the attribute." }, { type: "tool_use", name: "Edit", input: { file_path: model, old_string: "a", new_string: "b" } }] }, session_id: session });
  if (mode !== "noedit" && model) {
    const text = readFileSync(model, "utf8");
    writeFileSync(model, text.replace(/^(    attrs:\n)/m, "$1      - BirthDate\n"));
  }
  if (mode === "layout" && model) writeFileSync(model.replace(/(\.er)?\.ya?ml$/i, ".er.layout.json"), JSON.stringify({ version: 1, pins: { "E:X": { x: 1, y: 1 } } }));
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npx tsx lint model.er.yaml" } }] }, session_id: session });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Added BirthDate to the first entity." }] }, session_id: session });
  out({ type: "result", subtype: "success", is_error: false, result: "Added BirthDate to the first entity.", session_id: session });
}
