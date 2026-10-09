import {
  agentName, applyTurn, canSend, changeNote, composerKey, EXAMPLES, elapsedSeconds, flashIds, labelFor,
  loadThread, MAX_TEXT, outcome, selectionChips, takeToken, undoableTurn,
  type AgentInfo, type ThreadState, type Turn,
} from "./agent-logic.js";

const TOKEN_KEY = "chen-agent-token";
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

export interface AgentHost {
  /** Select and focus an element on the drawing; false when it is not drawn. */
  select(id: string): boolean;
  /** Brief halo on changed elements. */
  flash(ids: string[]): void;
}

/**
 * The Agent tab in the notes column. Hidden unless GET /api/agent answers (server started with --agent).
 * The thread reads like pencil notes in the margin: the request in ink, the agent in graphite.
 */
export class AgentPanel {
  private token: string | null = null;
  private enabled = false;
  private kind = "claude";
  private thread: ThreadState = { turns: [], running: null };
  private chips: string[] = [];
  private current?: string;
  private dismissed?: string;
  private labels = new Map<string, string>();
  private rendered = new Map<string, { node: HTMLElement; key: string }>();
  private openSteps = new Set<string>();
  private notices = new Map<string, string>();
  private ticker?: ReturnType<typeof setInterval>;
  private sending = false;
  private unread = false;
  private tablist = element("tabs");
  private tabs = [element<HTMLButtonElement>("tab-notes"), element<HTMLButtonElement>("tab-agent")];
  private panel = element("agent");
  private notesPanel = element("findings");
  private list = element("agent-thread");
  private empty = element("agent-empty");
  private input = element<HTMLTextAreaElement>("agent-input");
  private send = element<HTMLButtonElement>("agent-send");
  private chipRow = element("agent-chips");
  private notice = element("agent-notice");
  private live = element("agent-live");
  private context = element("agent-context");

  constructor(private host: AgentHost) {
    this.token = this.readToken();
    this.input.maxLength = MAX_TEXT;
    this.tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => this.activate(index));
      tab.addEventListener("keydown", (e) => {
        const next = e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? this.tabs.length - 1 : undefined;
        if (next === undefined) return;
        e.preventDefault(); const target = (next + this.tabs.length) % this.tabs.length; this.activate(target); this.tabs[target]!.focus();
      });
    });
    this.input.addEventListener("keydown", (e) => {
      if (composerKey(e) !== "send") return;
      e.preventDefault(); void this.submit();
    });
    this.input.addEventListener("input", () => { this.grow(); this.controls(); });
    element("agent-form").addEventListener("submit", (e) => { e.preventDefault(); void this.submit(); });
    for (const example of EXAMPLES) {
      const item = el("li"); const button = el("button", "example", example); button.type = "button";
      button.addEventListener("click", () => { this.input.value = example; this.grow(); this.controls(); this.input.focus(); });
      item.append(button); element("agent-examples").append(item);
    }
    // Capture phase: `/` and Escape must win over the diagram shortcuts registered on window.
    window.addEventListener("keydown", (e) => this.key(e), true);
  }

  private readToken(): string | null {
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(TOKEN_KEY); } catch { /* Storage may be disabled. */ }
    const { token, cleanHref } = takeToken(location.href, stored);
    if (cleanHref !== undefined) history.replaceState(history.state, "", cleanHref);
    if (token) try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* The page keeps it in memory. */ }
    return token;
  }

  private request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("X-Chen-Token", this.token);
    if (init.body) headers.set("Content-Type", "application/json");
    return fetch(path, { ...init, headers });
  }

  /** Load or reload the thread. Also called after the event stream reconnects, so missed events are recovered. */
  async sync() {
    let res: Response;
    try { res = await this.request("/api/agent"); } catch { return; }
    if (res.status === 404) { this.setEnabled(false); return; }
    this.setEnabled(true);
    if (res.status === 403) { this.say("This page has no valid agent token. Open the address that chen serve printed."); this.controls(); return; }
    if (!res.ok) { this.say(`Cannot load the agent thread (HTTP ${res.status}).`); return; }
    const info = await res.json() as AgentInfo;
    this.kind = info.kind || "claude";
    this.context.textContent = `‎${info.cwd}‎`; this.context.title = `${agentName(this.kind)} works in ${info.cwd}`;
    this.input.placeholder = `Ask ${agentName(this.kind)} to change the model`;
    element("agent-empty-lead").textContent = `Ask ${agentName(this.kind)} for a model change in plain words. It edits the YAML file and the drawing updates here.`;
    this.thread = loadThread(info);
    this.render();
  }

  /** One `agent-turn` event from /api/events. */
  event(turn: Turn) {
    if (!this.enabled) return;
    const before = this.thread.turns.find((t) => t.id === turn.id);
    const next = applyTurn(this.thread, turn);
    if (next === this.thread) return;
    this.thread = next;
    const now = next.turns.find((t) => t.id === turn.id)!;
    if (before?.status !== now.status && now.status !== "running") {
      this.host.flash(flashIds(now));
      const result = outcome(now, this.kind);
      this.live.textContent = `${agentName(this.kind)} finished. ${now.reply ?? ""} ${result?.message ?? ""}`.trim();
      if (this.active() !== 1) this.unread = true;
    }
    this.render();
  }

  /** Keep element names in step with the drawing (removed elements keep their last known name). */
  diagram(labels: Map<string, string>) {
    for (const [id, label] of labels) this.labels.set(id, label);
    this.drawChips();
  }
  /** The canvas selection changed. */
  selected(id?: string) {
    if (id === this.current) return;
    this.current = id; this.dismissed = undefined; this.drawChips();
  }

  private setEnabled(on: boolean) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.tablist.hidden = !on;
    const notes = element("notes");
    if (on) {
      notes.setAttribute("aria-label", "Notes and agent");
      this.notesPanel.setAttribute("role", "tabpanel"); this.notesPanel.setAttribute("aria-labelledby", "tab-notes");
      this.activate(this.active());
    } else {
      notes.setAttribute("aria-label", "Model findings");
      this.notesPanel.removeAttribute("role"); this.notesPanel.removeAttribute("aria-labelledby");
      this.notesPanel.hidden = false; this.panel.hidden = true;
    }
  }
  private active() { return this.tabs[1]!.getAttribute("aria-selected") === "true" ? 1 : 0; }
  private activate(index: number) {
    this.tabs.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    this.notesPanel.hidden = index !== 0; this.panel.hidden = index !== 1;
    if (index === 1) { this.unread = false; if (this.thread.turns.length) this.scrollToEnd(true); }
    this.tabState();
  }
  showNotes() { this.activate(0); }
  private tabState() {
    const state = element("tab-agent-state");
    state.textContent = this.thread.running ? "working" : this.unread ? "new" : "";
    state.hidden = !state.textContent;
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const editing = e.target instanceof Element && !!e.target.closest("select, input, textarea, [contenteditable=true]");
    if (e.key === "/" && !editing) {
      e.preventDefault(); e.stopPropagation();
      if (this.active() !== 1) this.activate(1);
      this.input.focus();
    } else if (e.key === "Escape" && this.thread.running && this.active() === 1) {
      e.preventDefault(); e.stopPropagation(); void this.cancel(this.thread.running);
    }
  }

  private grow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight + 2, 168)}px`;
  }
  private controls() {
    this.send.disabled = this.sending || !this.token || !canSend(this.input.value, this.thread.running);
    this.send.textContent = this.sending ? "Sending…" : "Send";
  }
  private say(text: string) { this.notice.textContent = text; this.notice.hidden = !text; }

  private async submit() {
    const text = this.input.value.trim();
    if (this.thread.running) { this.say("A request is already running."); return; }
    if (this.sending || !canSend(text, null)) return;
    this.sending = true; this.controls(); this.say("");
    const selection = [...this.chips];
    try {
      const res = await this.request("/api/agent/turns", { method: "POST", body: JSON.stringify({ text, selection }) });
      if (res.status === 409) { this.say("A request is already running."); void this.sync(); return; }
      if (res.status === 403) { this.say("This page has no valid agent token. Open the address that chen serve printed."); return; }
      if (!res.ok) { this.say(await errorText(res, "The request was not accepted.")); return; }
      const { turnId } = await res.json() as { turnId: string };
      this.input.value = ""; this.grow();
      // The start event normally arrives first; this placeholder covers a slow event stream.
      if (!this.thread.turns.some((t) => t.id === turnId)) {
        this.event({ id: turnId, text, selection, startedAt: new Date().toISOString(), status: "running", steps: [] });
      }
      this.scrollToEnd(true);
    } catch {
      this.say("Cannot reach chen serve. Is it still running?");
    } finally {
      this.sending = false; this.controls();
    }
  }

  private async cancel(id: string) {
    try {
      const res = await this.request(`/api/agent/turns/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (!res.ok) this.note(id, await errorText(res, "Cancel failed."));
    } catch { this.note(id, "Cannot reach chen serve."); }
  }
  private async undo(id: string) {
    this.note(id, "Undoing…");
    try {
      const res = await this.request(`/api/agent/turns/${encodeURIComponent(id)}/undo`, { method: "POST" });
      if (!res.ok) { this.note(id, await errorText(res, "Undo failed.")); return; }
      this.note(id, "");
      const turn = this.thread.turns.find((t) => t.id === id);
      if (turn && turn.status === "ok") this.event({ ...turn, status: "undone" });
    } catch { this.note(id, "Cannot reach chen serve."); }
  }
  private note(id: string, text: string) {
    if (text) this.notices.set(id, text); else this.notices.delete(id);
    this.render();
  }

  private drawChips() {
    this.chips = selectionChips(this.current, this.dismissed);
    this.chipRow.replaceChildren();
    this.chipRow.hidden = !this.chips.length;
    for (const id of this.chips) {
      const chip = el("span", "chip");
      const label = labelFor(id, this.labels);
      chip.append(el("span", "chip-mark", "▸"), el("span", "chip-label", label));
      const remove = el("button", "chip-remove", "×");
      remove.type = "button"; remove.setAttribute("aria-label", `Remove ${label} from the request`);
      remove.addEventListener("click", () => {
        this.dismissed = id; this.drawChips();
        (this.chipRow.querySelector<HTMLButtonElement>(".chip-remove") ?? this.input).focus();
      });
      chip.append(remove); this.chipRow.append(chip);
    }
  }

  private render() {
    const nearEnd = this.atEnd();
    const turns = this.thread.turns;
    this.empty.hidden = turns.length > 0;
    const undoable = undoableTurn(turns);
    const ids = new Set(turns.map((t) => t.id));
    for (const [id, entry] of this.rendered) if (!ids.has(id)) { entry.node.remove(); this.rendered.delete(id); }
    let previous: HTMLElement | null = null;
    for (const turn of turns) {
      const key = JSON.stringify([turn, undoable === turn.id, this.notices.get(turn.id) ?? "", [...this.labels.entries()].length]);
      let entry = this.rendered.get(turn.id);
      if (!entry || entry.key !== key) {
        const node = this.turn(turn, undoable === turn.id);
        const focused = entry && document.activeElement instanceof HTMLElement && entry.node.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
        if (entry) entry.node.replaceWith(node);
        entry = { node, key }; this.rendered.set(turn.id, entry);
        if (focused) node.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
      }
      if (entry.node.previousElementSibling !== previous || entry.node.parentElement !== this.list) {
        if (previous) previous.after(entry.node); else this.list.prepend(entry.node);
      }
      previous = entry.node;
    }
    this.tick();
    clearInterval(this.ticker);
    if (this.thread.running) this.ticker = setInterval(() => this.tick(), 1000);
    this.controls(); this.tabState();
    if (nearEnd) this.scrollToEnd(true);
  }

  private tick() {
    for (const node of this.list.querySelectorAll<HTMLElement>("[data-started]")) {
      node.textContent = `${elapsedSeconds(node.dataset.started!, Date.now())} s`;
    }
  }

  private turn(turn: Turn, undoable: boolean): HTMLElement {
    const name = agentName(this.kind);
    const article = el("article", `turn is-${turn.status}`);
    article.dataset.turn = turn.id;
    const ask = el("div", "ask");
    const text = el("p", "ask-text", turn.text);
    const time = el("time", "turn-time", clock(turn.startedAt)); time.dateTime = turn.startedAt;
    ask.append(text, time); article.append(ask);
    if (turn.selection.length) {
      const context = el("p", "turn-context");
      context.textContent = turn.selection.map((id) => `▸ ${labelFor(id, this.labels)}`).join("  ");
      context.setAttribute("aria-label", `Context: ${turn.selection.map((id) => labelFor(id, this.labels)).join(", ")}`);
      article.append(context);
    }
    if (turn.steps.length) {
      const details = el("details", "steps");
      details.open = this.openSteps.has(turn.id);
      details.addEventListener("toggle", () => { if (details.open) this.openSteps.add(turn.id); else this.openSteps.delete(turn.id); });
      const tools = turn.steps.filter((s) => s.kind === "tool").length;
      const summary = el("summary", undefined, tools ? `${tools} ${tools === 1 ? "step" : "steps"}` : `${turn.steps.length} notes`);
      summary.dataset.focus = "steps";
      const list = el("ol");
      for (const step of turn.steps) list.append(el("li", step.kind, step.summary));
      details.append(summary, list); article.append(details);
    }
    if (turn.status === "running") {
      const line = el("p", "working");
      const seconds = el("span", "elapsed"); seconds.dataset.started = turn.startedAt;
      const cancel = el("button", undefined, "Cancel"); cancel.type = "button"; cancel.dataset.focus = "cancel";
      cancel.title = "Cancel (Esc)";
      cancel.addEventListener("click", () => { void this.cancel(turn.id); });
      line.append(el("span", "pencil", `${name} is working…`), " ", seconds, cancel);
      article.append(line);
    }
    if (turn.reply) article.append(el("p", "reply", turn.reply));
    const result = outcome(turn, this.kind);
    const lines = changeNote(turn.changes, this.labels);
    if (lines.length) {
      const note = el("ul", "change-note"); note.setAttribute("aria-label", "Changes");
      for (const line of lines) {
        const item = el("li", `change ${line.sign === "+" ? "added" : line.sign === "~" ? "modified" : "removed"}`);
        const sign = el("span", "sign", line.sign); sign.setAttribute("aria-label", line.sign === "+" ? "added" : line.sign === "~" ? "changed" : "removed");
        item.append(sign);
        if (line.linkable && turn.status !== "undone") {
          const link = el("a", undefined, line.text); link.href = "#"; link.dataset.focus = `change-${line.id}`;
          link.addEventListener("click", (e) => {
            e.preventDefault();
            if (!this.host.select(line.id)) this.note(turn.id, `${line.text} is not in the drawing now.`);
          });
          item.append(link);
        } else item.append(el("span", "change-text", line.text));
        note.append(item);
      }
      article.append(note);
    }
    if (result && result.message) {
      const p = el("p", `outcome ${result.kind}`);
      p.append(...code(result.message));
      if (result.kind === "parse") {
        const show = el("button", "link-button", "Show findings"); show.type = "button"; show.dataset.focus = "findings";
        show.addEventListener("click", () => { this.showNotes(); this.tabs[0]!.focus(); });
        p.append(" ", show);
      }
      article.append(p);
      if (result.kind === "error" && result.detail) {
        const details = el("details", "stderr");
        const summary = el("summary", undefined, "Error output"); summary.dataset.focus = "stderr";
        details.append(summary, el("pre", undefined, result.detail)); article.append(details);
      }
    }
    const notice = this.notices.get(turn.id);
    if (notice) { const p = el("p", "turn-notice", notice); p.setAttribute("role", "status"); article.append(p); }
    if (undoable) {
      const row = el("p", "turn-actions");
      const undo = el("button", undefined, "Undo agent change"); undo.type = "button"; undo.dataset.focus = "undo";
      undo.addEventListener("click", () => { void this.undo(turn.id); });
      row.append(undo); article.append(row);
    }
    return article;
  }

  private scroller() { return element("notes"); }
  private atEnd() { const s = this.scroller(); return s.scrollHeight - s.scrollTop - s.clientHeight < 48; }
  private scrollToEnd(force = false) {
    if (this.panel.hidden || (!force && !this.atEnd())) return;
    const s = this.scroller(); s.scrollTop = s.scrollHeight;
  }
}

/** Render `backtick` spans as inline code. */
function code(text: string): (string | HTMLElement)[] {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((part) => part.startsWith("`") ? el("code", undefined, part.slice(1, -1)) : part);
}
async function errorText(res: Response, fallback: string): Promise<string> {
  try { const body = await res.json() as { error?: string }; return body.error ? `${fallback} ${body.error}` : fallback; } catch { return fallback; }
}
