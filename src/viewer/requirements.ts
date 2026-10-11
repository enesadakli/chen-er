import { nextRequirementId } from "../core/requirements.js";
import { agentName, elapsedSeconds, labelFor, type ThreadState, type Turn } from "./agent-logic.js";
import {
  applyResult, applySummary, applyTurns, editorKey, lineLabels, lineState, oneLine, pasteLines, receiveView,
  savePayload, traceLinks, type EditResult, type Line, type RequirementsView,
} from "./requirements-logic.js";

const SAVE_DELAY = 600;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface RequirementsHost {
  /** Select and fit an element on the drawing; false when it is not drawn. */
  select(id: string): boolean;
  /** Authenticated agent request (token header); undefined without the agent panel. */
  request?(path: string, init?: RequestInit): Promise<Response>;
  cancel(turnId: string): void;
  showAgent(): void;
  /** Lines or their state changed (the Notes tab lists uncovered requirements). */
  changed(): void;
}

interface Row { item: HTMLLIElement; number: HTMLLabelElement; input: HTMLTextAreaElement; meta: HTMLDivElement; key: string }

/**
 * The Requirements tab: one requirement per line, pencil on paper. Autosaves to `<model>.er.requirements.md`;
 * with `--agent`, Apply sends the new and changed lines to the agent and the trace links come back under each line.
 */
export class RequirementsPanel {
  private lines: Line[] = [];
  private base?: string;
  private saved = "[]";
  private loaded = false;
  private conflict = false;
  private saving?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private error = "";
  private agentKind: string | null = null;
  private thread: ThreadState = { turns: [], running: null };
  private live?: ReadonlySet<string>;
  private labels = new Map<string, string>();
  private rows = new Map<string, Row>();
  private ticker?: ReturnType<typeof setInterval>;
  private applying = false;
  /** Every id seen this session, so a deleted line's id (and its old trace in the file) is never handed out again. */
  private known = new Set<string>();
  /** A view that arrived while a save was in flight; the save's answer decides first. */
  private pendingView?: RequirementsView;
  private list = element<HTMLOListElement>("req-list");
  private status = element("req-save");
  private summary = element("req-summary");
  private apply = element<HTMLButtonElement>("req-apply");
  private notice = element("req-notice");
  private result = element("req-result");
  private progress = element("req-progress");

  constructor(private host: RequirementsHost) {
    this.apply.addEventListener("click", () => { void this.applyNow(); });
    element("req-load").addEventListener("click", () => { void this.reload(true); });
    element("req-keep").addEventListener("click", () => { void this.keepMine(); });
    new ResizeObserver(() => { for (const row of this.rows.values()) this.grow(row.input); }).observe(this.list);
    window.addEventListener("pagehide", () => { if (this.dirty()) void this.save(true); });
  }

  private fresh = () => {
    const id = nextRequirementId([...this.known, ...this.lines.map((l) => l.id)]);
    this.known.add(id);
    return id;
  };
  private dirty() { return JSON.stringify(savePayload(this.lines)) !== this.saved; }
  /** Current lines for the Notes findings. */
  get state() { return { lines: this.lines, live: this.live }; }

  async reload(force = false) {
    let res: Response;
    try { res = await fetch("/api/requirements"); } catch { this.fail("Cannot reach chen serve. Is it still running?"); return; }
    if (!res.ok) { this.fail(await errorText(res, "Cannot read the requirements file.")); return; }
    const view = await res.json() as RequirementsView;
    if (force) { this.base = undefined; this.saved = "[]"; this.lines = []; this.conflict = false; }
    this.view(view);
  }

  /** A `requirements` event or GET answer. */
  view(view: RequirementsView) {
    if (this.saving) { this.pendingView = view; return; }
    for (const item of view.items) this.known.add(item.id);
    this.agentKind = view.agent;
    element("req-file").textContent = view.file;
    const first = !this.loaded;
    const next = receiveView(this.lines, this.base, this.dirty(), view, this.fresh);
    if (next.base !== this.base) this.saved = JSON.stringify(savePayload(view.items));
    this.lines = next.lines; this.base = next.base; this.loaded = true;
    if (next.conflict) this.conflict = true;
    this.error = "";
    this.render(first ? undefined : this.focusKeep());
  }

  /** Element ids and names of the current drawing (null while the model has errors). */
  diagram(ids: ReadonlySet<string> | undefined, labels: Map<string, string>) {
    this.live = ids; for (const [id, label] of labels) this.labels.set(id, label);
    if (this.loaded) this.render(this.focusKeep());
  }

  /** The agent thread changed (apply turns run there). */
  agent(thread: ThreadState, available: boolean) {
    this.thread = thread;
    if (!available) this.thread = { turns: [], running: null };
    this.render(this.focusKeep());
  }

  private focusKeep(): { index: number; caret: number; end: number } | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement) || !this.list.contains(active)) return undefined;
    const index = this.lines.findIndex((l) => l.id === active.dataset.id);
    return index < 0 ? undefined : { index, caret: active.selectionStart, end: active.selectionEnd };
  }

  private fail(text: string) { this.error = text; this.drawStatus(); }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.save(); }, SAVE_DELAY);
    this.drawStatus();
  }

  /** Autosave: the non-empty lines with their ids, guarded by the text revision (409 when the file moved on). */
  private async save(keepalive = false): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) { this.again = true; return this.saving; }
    if (!this.dirty() || this.conflict || this.base === undefined) { this.drawStatus(); return; }
    const items = savePayload(this.lines);
    this.saving = (async () => {
      try {
        const res = await fetch("/api/requirements", { method: "PUT", keepalive, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, expectedRevision: this.base }) });
        if (res.status === 409) { this.conflict = true; return; }
        if (!res.ok) { this.error = await errorText(res, "Not saved."); return; }
        const view = await res.json() as RequirementsView;
        this.saved = JSON.stringify(items); this.base = view.revision; this.error = "";
        const next = receiveView(this.lines, this.base, false, view, this.fresh);
        this.lines = next.lines;
      } catch { this.error = "Not saved: cannot reach chen serve."; }
    })();
    this.drawStatus();
    try { await this.saving; } finally { this.saving = undefined; }
    this.render(this.focusKeep());
    const pending = this.pendingView;
    this.pendingView = undefined;
    if (pending) this.view(pending);
    if (this.again) { this.again = false; await this.save(); }
  }

  /** After a conflict: keep the lines on screen and write them over the file's texts (its trace state merges in). */
  private async keepMine() {
    let res: Response;
    try { res = await fetch("/api/requirements"); } catch { this.fail("Cannot reach chen serve. Is it still running?"); return; }
    if (!res.ok) { this.fail(await errorText(res, "Cannot read the requirements file.")); return; }
    const view = await res.json() as RequirementsView;
    this.base = view.revision; this.saved = JSON.stringify(savePayload(view.items)); this.conflict = false;
    await this.save();
  }

  private async applyNow() {
    if (!this.host.request || this.applying) return;
    this.applying = true; this.say(""); this.drawApply();
    try {
      clearTimeout(this.timer);
      await this.save();
      if (this.saving) await this.saving;
      if (this.conflict || this.dirty()) { this.say("Save the lines first: the requirements file changed outside the viewer."); return; }
      const res = await this.host.request("/api/agent/requirements/apply", { method: "POST", body: JSON.stringify({ expectedRevision: this.base }) });
      if (res.status === 403) { this.say("This page has no valid agent token. Open the address that chen serve printed."); return; }
      if (!res.ok) { this.say(await errorText(res, "Apply was not accepted.")); return; }
    } catch { this.say("Cannot reach chen serve. Is it still running?"); }
    finally { this.applying = false; this.drawApply(); }
  }

  private say(text: string) { this.notice.textContent = text; this.notice.hidden = !text; }

  // ---- Rendering -----------------------------------------------------------------------------------------------

  private render(focus?: { index: number; caret: number; end?: number }) {
    const labels = lineLabels(this.lines);
    const { running } = applyTurns(this.thread.turns, this.thread.running);
    const applyingIds = new Set(running?.requirements?.ids ?? []);
    const ids = new Set(this.lines.map((l) => l.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.item.remove(); this.rows.delete(id); }
    let previous: HTMLElement | null = null;
    this.lines.forEach((line, index) => {
      let row = this.rows.get(line.id);
      if (!row) { row = this.row(line.id); this.rows.set(line.id, row); }
      if (row.input.value !== line.text) row.input.value = line.text;
      row.number.textContent = labels[index] ?? "";
      const state = applyingIds.has(line.id) && line.text.trim() ? "applying" : lineState(line, this.live) ?? "empty";
      const key = JSON.stringify([state, labels[index], line.trace, line.why, this.live && line.trace?.map((id) => this.live!.has(id)), line.trace?.map((id) => this.labels.get(id))]);
      if (row.key !== key) { row.key = key; this.meta(row, line, state, labels[index]); }
      row.item.className = `req is-${state}`;
      row.input.placeholder = index === this.lines.length - 1
        ? this.lines.length === 1 ? "Every course is offered by exactly one department." : "Next requirement"
        : "";
      if (row.item.previousElementSibling !== previous || row.item.parentElement !== this.list) {
        if (previous) previous.after(row.item); else this.list.prepend(row.item);
      }
      previous = row.item;
      this.grow(row.input);
    });
    element("req-empty").hidden = this.lines.some((l) => l.text.trim());
    if (focus) this.focus(focus.index, focus.caret, focus.end);
    this.drawStatus(); this.drawApply();
    this.host.changed();
  }

  private row(id: string): Row {
    const item = el("li", "req");
    const number = el("label", "req-number"); number.htmlFor = `req-${id}`;
    const input = el("textarea", "req-text"); input.id = `req-${id}`; input.rows = 1; input.dataset.id = id;
    input.spellcheck = true; input.maxLength = 1000; input.setAttribute("aria-describedby", `req-${id}-meta`);
    const meta = el("div", "req-meta"); meta.id = `req-${id}-meta`;
    const body = el("div", "req-body"); body.append(input, meta);
    item.append(number, body);
    input.addEventListener("keydown", (e) => this.key(e, input));
    input.addEventListener("input", () => {
      const index = this.lines.findIndex((l) => l.id === id);
      if (index < 0) return;
      const caret = input.selectionStart;
      const text = oneLine(input.value);
      if (text !== input.value) { input.value = text; input.setSelectionRange(caret, caret); }
      this.lines[index] = { ...this.lines[index]!, text };
      const trailing = index === this.lines.length - 1 && text.trim();
      if (trailing) this.lines.push({ id: this.fresh(), text: "" });
      this.render(); this.schedule();
    });
    input.addEventListener("paste", (e) => {
      const clip = e.clipboardData?.getData("text/plain") ?? "";
      const index = this.lines.findIndex((l) => l.id === id);
      const result = index < 0 ? undefined : pasteLines(this.lines, index, input.selectionStart, input.selectionEnd, clip, this.fresh);
      if (!result) return;
      e.preventDefault(); this.edit(result);
    });
    return { item, number, input, meta, key: "" };
  }

  private key(e: KeyboardEvent, input: HTMLTextAreaElement) {
    const index = this.lines.findIndex((l) => l.id === input.dataset.id);
    if (index < 0) return;
    const result = editorKey(this.lines, index, { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      isComposing: e.isComposing, start: input.selectionStart, end: input.selectionEnd, singleRow: this.singleRow(input) }, this.fresh);
    if (!result) return;
    e.preventDefault(); e.stopPropagation();
    this.edit(result);
  }

  private edit(result: EditResult) {
    const changed = JSON.stringify(result.lines.map((l) => [l.id, l.text])) !== JSON.stringify(this.lines.map((l) => [l.id, l.text]));
    this.lines = result.lines;
    this.render(result.focus);
    if (changed) this.schedule();
  }

  private focus(index: number, caret: number, end = caret) {
    const line = this.lines[index];
    const input = line && this.rows.get(line.id)?.input;
    if (!input) return;
    if (document.activeElement !== input) input.focus({ preventScroll: false });
    input.setSelectionRange(caret, end);
  }

  private singleRow(input: HTMLTextAreaElement) {
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight) || 19;
    return input.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) < line * 1.5;
  }
  private grow(input: HTMLTextAreaElement) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  private meta(row: Row, line: Line, state: string, label: string | undefined) {
    row.meta.replaceChildren();
    const name = agentName(this.agentKind ?? "claude");
    if (state === "new" || state === "changed") {
      row.meta.append(el("p", "req-state", state === "new" ? "new" : "changed since the last apply"));
    } else if (state === "applying") {
      row.meta.append(el("p", "req-state", `${name} is applying this line…`));
    } else if (state === "applied" || state === "uncovered") {
      const links = traceLinks(line, this.live);
      if (state === "uncovered") {
        const p = el("p", "req-uncovered");
        const glyph = el("span", "glyph", "△"); glyph.setAttribute("aria-hidden", "true");
        p.append(glyph, line.why && !links.length ? " not covered" : ` not covered: no model element implements ${label ?? "it"}${links.length ? " now" : ""}.`);
        row.meta.append(p);
      }
      if (links.length) {
        const trace = el("p", "req-trace"); trace.setAttribute("aria-label", "Implemented by");
        const arrow = el("span", "req-arrow", "→"); arrow.setAttribute("aria-hidden", "true");
        trace.append(arrow);
        links.forEach((link, i) => {
          if (i) trace.append(", ");
          const text = labelFor(link.id, this.labels);
          if (link.present) {
            const a = el("a", undefined, text); a.href = "#"; a.title = link.id;
            a.addEventListener("click", (e) => { e.preventDefault(); if (!this.host.select(link.id)) this.say(`${text} is not in the drawing now.`); });
            trace.append(a);
          } else {
            const gone = el("span", "req-gone", text); gone.title = `${link.id} is no longer in the model`;
            trace.append(gone);
          }
        });
        row.meta.append(trace);
      }
      if (line.why) row.meta.append(el("p", "req-why", line.why));
    }
  }

  private drawStatus() {
    const text = this.error ? this.error : this.conflict ? "not saved" : this.saving ? "saving…" : this.dirty() ? "editing" : this.loaded && this.base !== undefined && this.lines.some((l) => l.text.trim()) ? "saved" : "";
    this.status.textContent = text;
    this.status.classList.toggle("problem", !!this.error || this.conflict);
    element("req-conflict").hidden = !this.conflict;
  }

  private drawApply() {
    const summary = applySummary(this.lines, this.live);
    const turns = applyTurns(this.thread.turns, this.thread.running);
    const name = agentName(this.agentKind ?? "claude");
    const on = !!this.agentKind && !!this.host.request;
    element("req-off").hidden = on;
    this.apply.hidden = !on;
    this.summary.textContent = summary.text;
    this.apply.disabled = !on || this.applying || turns.busy || !summary.pending || this.conflict;
    this.apply.textContent = this.applying ? "Saving…" : "Apply to model";
    this.apply.title = turns.busy && !turns.running ? `Wait for the running ${name} request to finish.` : "";
    const tabState = element("tab-requirements-state");
    tabState.textContent = turns.running ? "applying" : ""; tabState.hidden = !turns.running;
    clearInterval(this.ticker);
    this.progress.replaceChildren();
    this.progress.hidden = !turns.running;
    if (turns.running) {
      const seconds = el("span", "elapsed");
      const tick = () => { seconds.textContent = `${elapsedSeconds(turns.running!.startedAt, Date.now())} s`; };
      tick(); this.ticker = setInterval(tick, 1000);
      const follow = el("button", "link-button", "Agent tab"); follow.type = "button";
      follow.addEventListener("click", () => this.host.showAgent());
      const cancel = el("button", "req-cancel", "Cancel"); cancel.type = "button";
      cancel.addEventListener("click", () => this.host.cancel(turns.running!.id));
      this.progress.append(el("span", "pencil", `${name} is applying ${turns.running.requirements!.labels.join(", ")}…`), " ", seconds, " · ", follow, cancel);
    }
    const last = !turns.running ? turns.last : undefined;
    this.result.hidden = !last;
    if (last) {
      const result = applyResult(last, this.agentKind ?? "claude");
      this.result.textContent = result.text;
      this.result.className = `req-result ${result.tone}`;
    }
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try { const body = await res.json() as { error?: string }; return body.error ? `${fallback} ${body.error}` : fallback; } catch { return fallback; }
}
export type { Turn };
