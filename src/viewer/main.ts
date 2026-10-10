import "./style.css";
import type { ViewerState } from "../app/serve.js";
import { NotebookCanvas } from "./canvas.js";
import { Notes } from "./notes.js";
import { findings, type Finding } from "./logic.js";
import type { Box } from "../core/geometry.js";
import { placeMenu } from "./menu-position.js";
import { AgentPanel } from "./agent.js";
import type { Turn } from "./agent-logic.js";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: ViewerState | undefined;
let list: Finding[] = [];
let selected: number | undefined;
let connected = false;
let pendingWrites = 0;
let anchor: Box | undefined;
let firstSheet = true;
let drawerResized = false;
const actions = element("node-actions");
function positionActions() {
  if (actions.hidden || !anchor) return;
  const viewport = element("canvas");
  // Measure the unconstrained content once, then constrain it to the visible canvas.
  actions.style.maxHeight = ""; actions.style.maxWidth = `${Math.max(0, viewport.clientWidth - 16)}px`;
  const placement = placeMenu(anchor, { w: actions.offsetWidth, h: actions.offsetHeight }, { w: viewport.clientWidth, h: viewport.clientHeight });
  actions.style.left = `${placement.x}px`; actions.style.top = `${placement.y}px`;
  actions.style.maxWidth = `${placement.maxWidth}px`; actions.style.maxHeight = `${placement.maxHeight}px`;
}
function nodeActions(id?: string, box?: Box, dragging = false) {
  if (dragging) { actions.hidden = true; return; }
  if (!id) { actions.hidden = true; return; }
  anchor = box;
  element("node-name").textContent = state?.selection.owners.find((o) => o.id === id)?.label ?? id.slice(2);
  actions.hidden = false; positionActions();
}
function historyControls() {
  const busy = pendingWrites > 0 || !!state?.computing;
  for (const id of ["reset", "relayout", "node-focus"]) element<HTMLButtonElement>(id).disabled = busy;
  element<HTMLSelectElement>("engine").disabled = busy;
  element<HTMLButtonElement>("undo").disabled = busy || !state?.history.canUndo;
  element<HTMLButtonElement>("redo").disabled = busy || !state?.history.canRedo;
}
function status(text: string) {
  const short = /saving|computing/i.test(text) ? "saving" : /conflict/i.test(text) ? "conflict" : /fail|cannot|fix/i.test(text) ? "error" : /disconnect|connecting|reconnect/i.test(text) ? "offline" : "live";
  const node = element("status");
  node.querySelector<HTMLElement>(".status-full")!.textContent = text;
  node.querySelector<HTMLElement>(".status-short")!.textContent = short;
  node.dataset.state = short; node.title = text;
}
function choose(number: number) {
  selected = number; notes.select(number); canvas.highlight(number, true, true);
}
function hover(number?: number) { notes.highlight(number); canvas.highlight(number); }
const notes = new Notes(element("findings"), choose, hover);
const canvas = new NotebookCanvas(element("canvas"), choose, hover, async (id, point) => {
  await write(point ? "/api/pins" : `/api/pins/${encodeURIComponent(id)}`, point ? "POST" : "DELETE", point ? { pins: { [id]: point } } : undefined);
}, nodeActions);
const agent = new AgentPanel({ select: (id) => canvas.selectElement(id), flash: (ids) => canvas.flash(ids) });
canvas.onSelection = (id) => agent.selected(id);
function apply(next: ViewerState) {
  // A POST response may arrive after a newer event from the same write.
  if (state && next.updatedAt <= state.updatedAt) return;
  const previous = selected && list.find((f) => f.number === selected);
  state = next; list = findings(next.diagnostics);
  selected = previous ? list.find((f) => f.rule === previous.rule && f.path === previous.path && f.message === previous.message)?.number : undefined;
  element("title").textContent = next.title; document.title = `${next.title} · chen-er`;
  element("path").textContent = next.modelPath.split("/").filter(Boolean).at(-1) ?? next.modelPath; element("path").title = next.modelPath;
  element("title").title = next.title;
  element<HTMLSelectElement>("engine").value = next.engine;
  const q = next.quality;
  element("quality").textContent = q?.implemented ? `${q.overlaps} overlaps · ${q.edgeCrossings} crossings` : "Quality not measured";
  element("quality").title = q?.implemented ? `${q.shapeCrossings} shape crossings, ${q.labelCollisions} label collisions, ${q.pinDrift} pin drift` : "The layout quality checker is not implemented yet.";
  notes.show(list, next.yaml, selected);
  const labels = new Map<string, string>([...(next.diagram?.nodes ?? []).map((n) => [n.id, n.label] as const), ...next.selection.owners.map((o) => [o.id, o.label] as const)]);
  canvas.show(next, list); if (selected !== undefined || previous) canvas.highlight(selected, true);
  if (firstSheet && next.svg && next.diagram) {
    firstSheet = false;
    if (matchMedia("(max-width: 900px)").matches && !drawerResized) {
      const viewport = element("canvas"), sheet = element("sheet");
      const height = document.querySelector<HTMLElement>(".workspace")!.clientHeight;
      const paperHeight = (viewport.clientWidth - 24) * sheet.offsetHeight / Math.max(sheet.offsetWidth, 1) + 24;
      drawerHeight(Math.max(height * .4, Math.min(height * .6, height - paperHeight)));
      canvas.fit();
    }
  }
  agent.diagram(labels);
  if (next.computing) status("Computing layout…");
  else if (!pendingWrites) status(connected ? `updated ${new Date(next.updatedAt).toLocaleTimeString([], { hour12: false })}` : "disconnected");
  historyControls();
  const chip = element("status"); chip.classList.remove("updated"); void chip.offsetWidth; chip.classList.add("updated");
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".menu a")) {
    link.setAttribute("aria-disabled", String(!next.svg));
  }
}
async function write(path: string, method: string, value?: unknown): Promise<boolean> {
  if (pendingWrites || state?.computing) return false;
  pendingWrites++;
  canvas.setWriting(true); historyControls(); status("Saving…");
  const payload = { ...(value && typeof value === "object" ? value : {}), expectedLayoutRevision: state?.layoutRevision };
  try {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const error = await res.json() as { error: string };
      if (res.status === 409) {
        const latest = await fetch("/api/state"); if (latest.ok) apply(await latest.json() as ViewerState);
        throw new Error(`Conflict: ${error.error}`);
      }
      throw new Error(error.error);
    }
    apply(await res.json() as ViewerState); status("Saved");
    return true;
  } catch (error) {
    const message = (error as Error).message;
    status(message.startsWith("Conflict:") ? "Conflict — review changes" : "Save failed"); element("status").title = message;
    return false;
  } finally {
    pendingWrites--; canvas.setWriting(false); historyControls();
    if (state) element<HTMLSelectElement>("engine").value = state.engine;
  }
}

let events: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let delay = 1000;
function connect() {
  events = new EventSource("/api/events");
  events.onopen = () => { connected = true; void agent.sync(); delay = 1000; if (state && !pendingWrites) status(state.computing ? "Computing layout…" : `updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour12: false })}`); };
  events.addEventListener("state", (event) => {
    try { apply(JSON.parse((event as MessageEvent<string>).data) as ViewerState); }
    catch { status("Invalid update. Reconnecting…"); events?.close(); retry = setTimeout(connect, delay); }
  });
  events.addEventListener("agent-turn", (event) => {
    try { agent.event(JSON.parse((event as MessageEvent<string>).data) as Turn); } catch { /* A malformed agent event never breaks the diagram stream. */ }
  });
  events.onerror = () => { connected = false; status("disconnected"); events?.close(); retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 30000); };
}
connect();
void fetch("/api/state").then(async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  apply(await res.json() as ViewerState);
}).catch((error: unknown) => { if (!state) status(`Cannot load model: ${(error as Error).message}`); });
window.addEventListener("pagehide", () => { events?.close(); clearTimeout(retry); });
for (const id of ["fit", "zoom-fit"]) element(id).addEventListener("click", () => canvas.fit());
element("plus").addEventListener("click", () => canvas.zoom(1.2));
element("minus").addEventListener("click", () => canvas.zoom(1 / 1.2));
element("actual").addEventListener("click", () => canvas.actual());
element("reset").addEventListener("click", () => { void write("/api/pins", "DELETE"); });
element("relayout").addEventListener("click", () => { void write("/api/relayout", "POST"); });
element<HTMLSelectElement>("engine").addEventListener("change", (e) => { void write("/api/engine", "POST", { engine: (e.target as HTMLSelectElement).value }); });
const dark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
function themeLabel() {
  const theme = element("theme"), label = dark() ? "Switch to light desk" : "Switch to dark desk";
  theme.dataset.dark = String(dark()); theme.setAttribute("aria-label", label); theme.title = label;
  theme.querySelector<HTMLElement>(".theme-label")!.textContent = label;
}
try { const stored = localStorage.getItem("chen-theme"); if (stored === "dark" || stored === "light") document.documentElement.dataset.theme = stored; } catch { /* Storage may be disabled by the browser. */ }
themeLabel();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themeLabel);
element("theme").addEventListener("click", () => {
  const next = dark() ? "light" : "dark"; document.documentElement.dataset.theme = next; themeLabel();
  try { localStorage.setItem("chen-theme", next); } catch { /* The current session still keeps its theme. */ }
});
for (const link of document.querySelectorAll<HTMLAnchorElement>(".menu a")) link.addEventListener("click", (e) => { if (!state?.svg) { e.preventDefault(); status("Fix model errors before exporting."); } });
window.addEventListener("keydown", (e) => {
  const editing = e.target instanceof Element && !!e.target.closest("select, input, textarea, [contenteditable=true]");
  if (!editing && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault(); const direction = e.shiftKey ? "redo" : "undo";
    if (state?.history[direction === "undo" ? "canUndo" : "canRedo"]) void write(`/api/history/${direction}`, "POST");
    return;
  }
  if (e.key === "Escape" && closeMenus()) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === "Escape") actions.hidden = true;
  if (e.ctrlKey || e.metaKey || e.altKey || editing) return;
  if (e.key === "Escape") { selected = undefined; notes.select(); canvas.clear(); return; }
  if (e.target instanceof Element && e.target.closest("button, a, summary") && [" ", "Enter"].includes(e.key)) return;
  switch (e.key.toLowerCase()) {
    case "f": e.preventDefault(); canvas.fit(); break;
    case "+": case "=": e.preventDefault(); canvas.zoom(1.2); break;
    case "-": e.preventDefault(); canvas.zoom(1 / 1.2); break;
    case "0": e.preventDefault(); canvas.actual(); break;
    case "j": case "k": {
      if (!list.length) break;
      e.preventDefault();
      const index = list.findIndex((f) => f.number === selected);
      const next = index < 0 ? (e.key.toLowerCase() === "j" ? 0 : list.length - 1) : (index + (e.key.toLowerCase() === "j" ? 1 : -1) + list.length) % list.length;
      choose(list[next]!.number); break;
    }
  }
});
const drawer = element<HTMLButtonElement>("drawer");
let drawerStart: { y: number; height: number } | undefined;
function drawerHeight(height: number) {
  const workspace = document.querySelector<HTMLElement>(".workspace")!.clientHeight;
  document.documentElement.style.setProperty("--drawer-height", `${Math.max(80, Math.min(workspace - 120, height))}px`);
}
drawer.addEventListener("pointerdown", (e) => { drawerResized = true; drawerStart = { y: e.clientY, height: element("notes").clientHeight }; drawer.setPointerCapture(e.pointerId); });
drawer.addEventListener("pointermove", (e) => { if (drawerStart) drawerHeight(drawerStart.height + drawerStart.y - e.clientY); });
drawer.addEventListener("pointerup", () => { drawerStart = undefined; });
drawer.addEventListener("pointercancel", () => { drawerStart = undefined; });
drawer.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); drawerResized = true; drawerHeight(element("notes").clientHeight + (e.key === "ArrowUp" ? 24 : -24)); }
});

for (const direction of ["undo", "redo"]) element(direction).addEventListener("click", () => { void write(`/api/history/${direction}`, "POST"); });
element("node-focus").addEventListener("click", () => canvas.focusSelection());
element("close-actions").addEventListener("click", () => { actions.hidden = true; canvas.closeActions(); });
new ResizeObserver(positionActions).observe(element("canvas"));

// Move the same controls into the narrow header; listeners and ids stay attached.
const menus = [...document.querySelectorAll<HTMLDetailsElement>(".header .actions")];
function closeMenus(except?: HTMLDetailsElement, restoreFocus = true) {
  let closed = false;
  for (const menu of menus) if (menu.open && menu !== except) {
    menu.open = false; closed = true;
    if (restoreFocus) menu.querySelector<HTMLElement>("summary")!.focus();
  }
  return closed;
}
for (const menu of menus) {
  menu.querySelector("summary")!.addEventListener("click", () => { if (!menu.open) closeMenus(menu, false); });
  menu.querySelector(".menu")!.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("button, a") && !e.target.closest("select")) closeMenus();
  });
}
document.addEventListener("click", (e) => {
  if (e.target instanceof Node) for (const menu of menus) if (menu.open && !menu.contains(e.target)) {
    menu.open = false; menu.querySelector<HTMLElement>("summary")!.focus();
  }
});
const narrow = matchMedia("(max-width: 900px)");
function headerLayout() {
  closeMenus(undefined, false);
  const layout = element("layout-items"), exports = element("export-items"), more = element("more-items"), desktop = element("desktop-actions");
  if (narrow.matches) {
    more.append(element("engine").closest("label")!, element("relayout"), element("reset"), element("theme"), ...exports.querySelectorAll("a"));
  } else {
    layout.append(element("engine").closest("label")!, element("relayout"), element("reset"));
    desktop.append(element("theme"));
    exports.append(...more.querySelectorAll("a"));
  }
}
headerLayout(); narrow.addEventListener("change", headerLayout);
