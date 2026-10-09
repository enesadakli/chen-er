import type { ViewerState } from "../app/serve.js";
import { center, type Box, type Point } from "../core/geometry.js";
import { glyphs, snap, targetBox, type Finding } from "./logic.js";

const ns = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}
export class NotebookCanvas {
  private state?: ViewerState;
  private good: ViewerState | undefined;
  private list: Finding[] = [];
  private scale = 1;
  private offset: Point = { x: 24, y: 24 };
  private selected?: string;
  private hovered?: string;
  private selectedFinding?: number;
  private hoverFinding?: number;
  private space = false;
  private drag?: { pointer: number; start: Point; offset: Point; id?: string; group?: SVGGElement; center?: Point; next?: Point };
  private touches = new Map<number, Point>();
  private pinch?: { distance: number; scale: number; diagram: Point };
  private pending?: { state: ViewerState; list: Finding[] };
  private sheet = document.querySelector<HTMLDivElement>("#sheet")!;
  private lastNodeIds = "";
  private figure = document.querySelector<HTMLDivElement>("#figure")!;
  private overlay = document.querySelector<SVGSVGElement>("#overlay")!;
  constructor(private canvas: HTMLElement, private selectFinding: (number: number) => void,
    private hover: (number?: number) => void, private pin: (id: string, point: Point | null) => Promise<void>) {
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e, true));
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .002)), this.local(e)); }, { passive: false });
    canvas.addEventListener("keydown", (e) => this.key(e));
    window.addEventListener("keydown", (e) => { if (e.code === "Space" && !this.editable(e.target)) this.space = true; });
    window.addEventListener("keyup", (e) => { if (e.code === "Space") this.space = false; });
    window.addEventListener("blur", () => { this.space = false; });
    new ResizeObserver(() => this.transform()).observe(canvas);
  }
  private editable(target: EventTarget | null) { return target instanceof Element && !!target.closest("input, select, textarea, button, summary, a"); }
  private local(e: { clientX: number; clientY: number }): Point {
    const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private diagramPoint(p: Point): Point { return { x: (p.x - this.offset.x) / this.scale, y: (p.y - this.offset.y) / this.scale }; }
  private transform() {
    this.sheet.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;
    document.querySelector<HTMLOutputElement>("#zoom")!.value = `${Math.round(this.scale * 100)}%`;
  }
  zoom(factor: number, around = { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 }) {
    const point = this.diagramPoint(around);
    this.scale = Math.max(.1, Math.min(4, this.scale * factor));
    this.offset = { x: around.x - point.x * this.scale, y: around.y - point.y * this.scale };
    this.transform();
  }
  actual() { this.zoom(1 / this.scale); }
  fit(box?: Box) {
    const diagram = this.good?.diagram;
    if (!diagram) return;
    const figure = this.figure.querySelector("svg");
    const b = box ?? { x: 0, y: 0, w: diagram.width, h: Number(figure?.getAttribute("height") ?? diagram.height) };
    this.scale = Math.max(.1, Math.min(box ? 2 : 1.5, (this.canvas.clientWidth - 48) / Math.max(b.w, 80), (this.canvas.clientHeight - 48) / Math.max(b.h, 80)));
    const c = center(b);
    this.offset = { x: this.canvas.clientWidth / 2 - c.x * this.scale, y: this.canvas.clientHeight / 2 - c.y * this.scale };
    this.transform();
  }
  show(state: ViewerState, list: Finding[]) {
    if (this.drag) { this.pending = { state, list }; return; }
    const active = document.activeElement;
    const focusId = active instanceof SVGGElement && this.figure.contains(active) ? active.dataset.id : undefined;
    const previousMark = active instanceof SVGGElement && this.overlay.contains(active)
      ? this.list.find((f) => f.number === Number(active.dataset.finding)) : undefined;
    const focusMark = previousMark ? list.find((f) => f.rule === previousMark.rule && f.path === previousMark.path && f.message === previousMark.message)?.number : undefined;
    const first = !this.good;
    this.state = state; this.list = list;
    if (state.svg && state.diagram) {
      this.good = state;
      const previous = this.figure.querySelector("svg:last-child");
      for (const old of this.figure.querySelectorAll("svg")) if (old !== previous) old.remove();
      if (previous) {
        (previous as SVGSVGElement).style.pointerEvents = "none";
        previous.setAttribute("aria-hidden", "true");
        for (const group of previous.querySelectorAll("[tabindex]")) group.removeAttribute("tabindex");
      }
      const parsed = new DOMParser().parseFromString(state.svg, "image/svg+xml").documentElement;
      const next = document.importNode(parsed, true) as unknown as SVGSVGElement;
      next.style.position = "absolute";
      this.figure.append(next);
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Crossfade only when the model itself changed; a drag or pin change swaps instantly so that
      // untouched nodes (identical in both drawings) never flicker.
      const ids = state.diagram.nodes.map((n) => n.id).sort().join("|");
      const modelChanged = ids !== this.lastNodeIds;
      this.lastNodeIds = ids;
      if (previous && !reduced && modelChanged) {
        next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
        const fade = previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 });
        fade.onfinish = () => previous.remove();
      } else previous?.remove();
      this.sheet.style.width = `${state.diagram.width}px`;
      this.sheet.style.height = `${next.getAttribute("height")}px`;
      this.overlay.setAttribute("viewBox", `0 0 ${state.diagram.width} ${next.getAttribute("height")}`);
      this.overlay.setAttribute("width", String(state.diagram.width));
      this.overlay.setAttribute("height", next.getAttribute("height")!);
      for (const node of state.diagram.nodes) {
        const group = this.group(node.id);
        group?.setAttribute("tabindex", "0");
        group?.setAttribute("role", "button");
        group?.setAttribute("aria-label", `${node.kind} ${node.label}${state.pins[node.id] ? ', pinned' : ''}. Arrow keys move; Delete unpins.`);
        group?.addEventListener("focus", () => { this.selected = node.id; this.drawOverlay(); });
        group?.addEventListener("pointerenter", () => {
          this.hovered = node.id;
          const finding = this.list.find((f) => f.target === node.id);
          this.hover(finding?.number); this.drawOverlay();
        });
        group?.addEventListener("pointerleave", () => { this.hovered = undefined; this.hover(); this.drawOverlay(); });
      }
    }
    this.figure.classList.toggle("stale", !state.svg);
    const placeholder = document.querySelector<HTMLElement>("#placeholder")!;
    placeholder.hidden = !!state.svg;
    placeholder.textContent = this.good ? "Model errors. Showing the last good diagram." : "The model cannot be drawn. Read the findings and fix the YAML file.";
    this.drawOverlay(true);
    if (focusId) this.group(focusId)?.focus({ preventScroll: true });
    if (focusMark) this.overlay.querySelector<SVGGElement>(`[data-finding="${focusMark}"]`)?.focus({ preventScroll: true });
    if (first && state.svg) this.fit();
  }
  highlight(number?: number, selected = false, focus = false) {
    if (selected) this.selectedFinding = number; else this.hoverFinding = number;
    const finding = this.list.find((f) => f.number === number);
    if (selected) this.selected = finding?.target;
    if (focus && finding) this.fit(targetBox(this.good?.diagram ?? null, finding.target));
    this.drawOverlay();
  }
  clear() { this.selected = undefined; this.selectedFinding = undefined; this.hovered = undefined; this.hoverFinding = undefined; this.drawOverlay(); }
  private group(id: string): SVGGElement | undefined {
    const groups = [...this.figure.querySelectorAll<SVGGElement>("svg:last-child g[data-id]")];
    return groups.find((g) => g.dataset.id === id);
  }
  private drawOverlay(rebuild = false) {
    if (rebuild) this.overlay.replaceChildren();
    const diagram = this.good?.diagram;
    if (!diagram) return;
    if (rebuild) {
    const defs = svg("defs", {});
    const minor = svg("pattern", { id: "minor-grid", width: 8, height: 8, patternUnits: "userSpaceOnUse" });
    minor.append(svg("path", { d: "M 8 0 H 0 V 8", fill: "none", stroke: "var(--grid)", "stroke-width": .5 }));
    const major = svg("pattern", { id: "major-grid", width: 40, height: 40, patternUnits: "userSpaceOnUse" });
    major.append(svg("rect", { width: 40, height: 40, fill: "url(#minor-grid)" }), svg("path", { d: "M 40 0 H 0 V 40", fill: "none", stroke: "var(--grid-major)", "stroke-width": .7 }));
    defs.append(minor, major); this.overlay.append(defs, svg("rect", { width: "100%", height: "100%", fill: "url(#major-grid)" }));
    }
    this.overlay.querySelector(".halos")?.remove();
    const halos = svg("g", { class: "halos" });
    this.overlay.append(halos);
    for (const id of new Set([this.selected, this.hovered,
      this.list.find((f) => f.number === this.selectedFinding)?.target,
      this.list.find((f) => f.number === this.hoverFinding)?.target])) {
      const box = targetBox(diagram, id);
      if (!box) continue;
      const node = diagram.nodes.find((n) => n.id === id);
      const attrs = { fill: "none", stroke: "var(--graphite)", "stroke-opacity": .35, "stroke-width": 3, ...(id && this.state?.pins[id] ? { "stroke-dasharray": "2 4" } : {}) };
      if (node?.kind === "attribute") halos.append(svg("ellipse", { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2 + 6, ry: box.h / 2 + 6, ...attrs }));
      else if (node?.kind === "relationship") halos.append(svg("polygon", { points: `${box.x + box.w / 2},${box.y - 6} ${box.x + box.w + 6},${box.y + box.h / 2} ${box.x + box.w / 2},${box.y + box.h + 6} ${box.x - 6},${box.y + box.h / 2}`, ...attrs }));
      else halos.append(svg("rect", { x: box.x - 6, y: box.y - 6, width: box.w + 12, height: box.h + 12, ...attrs }));
    }
    if (!rebuild) return;
    for (const node of diagram.nodes) if (this.state?.pins[node.id]) {
      this.overlay.append(svg("path", { d: `M ${node.box.x - 3} ${node.box.y - 6} v 6 h 6`, fill: "none", stroke: "var(--graphite)", "stroke-width": 1 }));
    }
    const used = new Map<string, number>();
    for (const finding of this.list) {
      const box = targetBox(diagram, finding.target);
      if (!box || !finding.target) continue;
      const index = used.get(finding.target) ?? 0; used.set(finding.target, index + 1);
      const x = box.x + box.w + 8 + index * 24, y = box.y - 8;
      const mark = svg("g", { class: "mark", "data-finding": finding.number, tabindex: 0, role: "button", "aria-label": `Finding ${finding.number}, ${finding.severity}: ${finding.message}` });
      const color = finding.severity === "heuristic" ? "var(--graphite)" : `var(--${finding.severity})`;
      mark.append(svg("circle", { cx: x, cy: y, r: 8, fill: "var(--sheet)", stroke: color }));
      const text = svg("text", { x, y: y + 3, "text-anchor": "middle", "font-size": 10, fill: "var(--ink)" });
      text.textContent = String(finding.number); mark.append(text);
      const glyph = svg("text", { x: x + 9, y: y + 3, "font-size": 10, fill: color }); glyph.textContent = glyphs[finding.severity]; mark.append(glyph);
      mark.addEventListener("click", () => this.selectFinding(finding.number));
      mark.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.selectFinding(finding.number); } });
      mark.addEventListener("pointerenter", () => this.hover(finding.number));
      mark.addEventListener("pointerleave", () => this.hover());
      this.overlay.append(mark);
    }
  }
  private down(e: PointerEvent) {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".zoom-controls, .mark"))) return;
    const point = this.local(e); this.touches.set(e.pointerId, point);
    this.canvas.setPointerCapture(e.pointerId);
    if (this.touches.size === 2) {
      if (this.drag?.group) this.drag.group.removeAttribute("transform");
      this.drag = undefined;
      const [a, b] = [...this.touches.values()] as [Point, Point];
      this.pinch = { distance: Math.hypot(b.x - a.x, b.y - a.y), scale: this.scale, diagram: this.diagramPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
      return;
    }
    const group = e.target instanceof Element ? e.target.closest<SVGGElement>(".er-entity, .er-relationship, .er-attribute") : null;
    const id = !this.space ? group?.dataset.id : undefined;
    const node = this.good?.diagram?.nodes.find((n) => n.id === id);
    if (id && e.altKey && this.state?.pins[id]) { void this.pin(id, null); this.touches.delete(e.pointerId); return; }
    this.selected = id;
    this.drag = { pointer: e.pointerId, start: point, offset: { ...this.offset }, ...(node && group ? { id, group, center: center(node.box) } : {}) };
    if (group && id) group.focus(); else this.canvas.focus();
    this.drawOverlay();
  }
  private move(e: PointerEvent) {
    if (!this.touches.has(e.pointerId)) return;
    const p = this.local(e); this.touches.set(e.pointerId, p);
    if (this.pinch && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()] as [Point, Point];
      this.scale = Math.max(.1, Math.min(4, this.pinch.scale * Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, this.pinch.distance)));
      this.offset = { x: (a.x + b.x) / 2 - this.pinch.diagram.x * this.scale, y: (a.y + b.y) / 2 - this.pinch.diagram.y * this.scale };
      this.transform(); return;
    }
    const drag = this.drag;
    if (!drag || drag.pointer !== e.pointerId) return;
    if (drag.center && drag.group) {
      drag.next = snap({ x: drag.center.x + (p.x - drag.start.x) / this.scale, y: drag.center.y + (p.y - drag.start.y) / this.scale }, e.altKey);
      drag.group.setAttribute("transform", `translate(${drag.next.x - drag.center.x},${drag.next.y - drag.center.y})`);
    } else { this.offset = { x: drag.offset.x + p.x - drag.start.x, y: drag.offset.y + p.y - drag.start.y }; this.transform(); }
  }
  private up(e: PointerEvent, cancel = false) {
    this.touches.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.pinch) { if (this.touches.size < 2) this.pinch = undefined; }
    const drag = this.drag;
    if (drag?.pointer === e.pointerId) {
      this.drag = undefined;
      if (!cancel && drag.id && drag.next) {
        void this.pin(drag.id, drag.next).finally(() => drag.group?.removeAttribute("transform"));
      } else drag.group?.removeAttribute("transform");
    }
    if (!this.drag && this.pending) { const pending = this.pending; this.pending = undefined; this.show(pending.state, pending.list); }
  }
  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest("button, .mark")) return;
    const node = this.good?.diagram?.nodes.find((n) => n.id === this.selected);
    if (e.key === "Enter" && node) {
      const finding = this.list.find((f) => f.target === node.id);
      if (finding) { e.preventDefault(); this.selectFinding(finding.number); }
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const dx = e.key === "ArrowLeft" ? -8 : e.key === "ArrowRight" ? 8 : 0;
      const dy = e.key === "ArrowUp" ? -8 : e.key === "ArrowDown" ? 8 : 0;
      if (node) { const p = this.state?.pins[node.id] ?? center(node.box); void this.pin(node.id, snap({ x: p.x + dx, y: p.y + dy }, e.altKey)); }
      else { this.offset.x -= dx * 4; this.offset.y -= dy * 4; this.transform(); }
    } else if (node && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); void this.pin(node.id, null); }
    else if (e.code === "Space") e.preventDefault();
  }
}
