/**
 * Dev-only: drive local Chrome over the DevTools protocol against the mock and save screenshots.
 *   npx tsx test/fixtures/agent-ui-mock/shoot.ts <url> <out.png> <width> <height> [script.js]
 * The optional script runs in the page after load (may return a promise); its result is printed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, w, h, scriptPath] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333 + Math.floor(Math.random() * 500);
const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "chen-cdp-"))}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !target; i++) {
  await wait(200);
  try { target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page"); } catch { /* not up yet */ }
}
if (!target) throw new Error("Chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
const logs: string[] = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: { args?: { value?: unknown }[]; exceptionDetails?: { text: string; exception?: { description?: string } }; type?: string } };
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.error ? { error: msg.error } : msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled" && (msg.params?.type === "error" || msg.params?.type === "warning")) logs.push(`console.${msg.params.type}: ${msg.params.args?.map((a) => a.value).join(" ")}`);
  if (msg.method === "Runtime.exceptionThrown") logs.push(`exception: ${msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text}`);
});
const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 600 });
await send("Page.navigate", { url });
await wait(2500);
if (scriptPath) {
  const result = await send("Runtime.evaluate", { expression: readFileSync(scriptPath, "utf8"), awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(result?.result?.value ?? result, null, 1));
}
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
if (logs.length) console.log(logs.join("\n"));
ws.close(); child.kill();
process.exit(0);
