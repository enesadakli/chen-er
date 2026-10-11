import { relativeAttributePins } from "../core/pins.js";
import type { ViewerState } from "../app/serve.js";
import { center, type Box, type Pin, type Point } from "../core/geometry.js";
import { glyphs, snap, targetBox, type Finding } from "./logic.js";
import type { MenuDimensions, MenuObstacle } from "./menu-position.js";
import { selectionNeighborhood } from "./selection.js";

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
  private actionsOpen = false;
  private savingDrag = false;
  private writing = false;
  setWriting(value: boolean) { this.writing = value; }
  private drag?: { pointer: number; start: Point; offset: Point; id?: string; group?: SVGGElement; center?: Point; next?: Point; moved?: boolean };
  private touches = new Map<number, Point>();
  private pinch?: { distance: number; scale: number; diagram: Point };
  private pending?: { state: ViewerState; list: Finding[] };
  private sheet = document.querySelector<HTMLDivElement>("#sheet")!;
  private lastNodeIds = "";
  private figure = document.querySelector<HTMLDivElement>("#figure")!;
  private overlay = document.querySelector<SVGSVGElement>("#overlay")!;
  private exportCorners: { path: SVGPathElement; x: number; y: number }[] = [];
  private flashes?: { ids: string[]; start: number; timer: ReturnType<typeof setTimeout> };
  private notifiedSelection?: string;
  /** Called whenever the selected drawing element changes (the agent panel turns it into a context chip). */
  onSelection: (id?: string) => void = () => {};
  constructor(private canvas: HTMLElement, private selectFinding: (number: number) => void,
    private hover: (number?: number) => void, private pin: (id: string, point: Pin | null) => Promise<void>,
    private actions: (id?: string, anchor?: Box, dragging?: boolean, obstacles?: (menu: MenuDimensions) => MenuObstacle[]) => void = () => {}) {
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e, true));
    canvas.addEventListener("wheel", (e) => { if (e.target instanceof Element && e.target.closest(".node-actions, .zoom-controls")) return; e.preventDefault(); this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .002)), this.local(e)); }, { passive: false });
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
    const origin = this.good?.diagram?.origin ?? { x: 0, y: 0 };
    this.sheet.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale}) translate(${origin.x}px, ${origin.y}px)`;
    const minor = `${8 * this.scale}px ${8 * this.scale}px`, major = `${40 * this.scale}px ${40 * this.scale}px`;
    this.canvas.style.backgroundSize = `${major}, ${major}, ${minor}, ${minor}`;
    // Offset is diagram zero in canvas coordinates, even when the sheet has a negative origin.
    this.canvas.style.backgroundPosition = `${this.offset.x}px ${this.offset.y}px`;
    // 1px CSS lines carry the ink of the old 0.5px / 0.7px scaled strokes, then fade out when dense.
    const fade = (from: number, to: number) => Math.max(0, Math.min(1, (this.scale - from) / (to - from)));
    this.canvas.style.setProperty("--minor-alpha", `${fade(.35, .5) * Math.min(1, .5 * this.scale) * 100}%`);
    this.canvas.style.setProperty("--major-alpha", `${fade(.1, .15) * Math.min(1, .7 * this.scale) * 100}%`);
    // Cancel the outer CSS scale for both the 12px arms and the 1px stroke.
    for (const { path, x, y } of this.exportCorners) path.setAttribute("transform", `translate(${x} ${y}) scale(${1 / this.scale})`);
    const percent = `${Math.round(this.scale * 100)}%`;
    document.querySelector<HTMLElement>("#zoom")!.textContent = percent;
    document.querySelector<HTMLButtonElement>("#actual")!.setAttribute("aria-label", `Zoom ${percent}. Reset to 100% (0)`);
    if (this.actionsOpen) this.actionPosition();
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
    const origin = diagram.origin ?? { x: 0, y: 0 };
    const b = box ?? { x: origin.x, y: origin.y, w: diagram.width, h: Number(figure?.getAttribute("height") ?? diagram.height) };
    const padding = matchMedia("(max-width: 900px)").matches ? 24 : 48;
    this.scale = Math.max(.1, Math.min(box ? 2 : 1.5, (this.canvas.clientWidth - padding) / Math.max(b.w, 80), (this.canvas.clientHeight - padding) / Math.max(b.h, 80)));
    const c = center(b);
    this.offset = { x: this.canvas.clientWidth / 2 - c.x * this.scale, y: this.canvas.clientHeight / 2 - c.y * this.scale };
    this.transform();
  }
  show(state: ViewerState, list: Finding[]) {
    if (this.drag || this.savingDrag) { this.pending = { state, list }; return; }
    if (state.computing) { this.state = state; return; }
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
      const origin = state.diagram.origin ?? { x: 0, y: 0 };
      this.overlay.setAttribute("viewBox", `${origin.x} ${origin.y} ${state.diagram.width} ${next.getAttribute("height")}`);
      this.overlay.setAttribute("width", String(state.diagram.width));
      this.overlay.setAttribute("height", next.getAttribute("height")!);
      for (const node of state.diagram.nodes) {
        const group = this.group(node.id);
        group?.setAttribute("tabindex", "0");
        group?.setAttribute("role", "button");
        group?.setAttribute("aria-label", `${node.kind} ${node.label}${state.pins[node.id] ? ', pinned' : ''}. ${node.kind !== "attribute" ? "Enter opens actions; " : ""}arrow keys move; Delete unpins.`);
        group?.addEventListener("focus", () => { this.selected = node.id; this.drawOverlay(); });
        group?.addEventListener("pointerenter", () => {
          this.hovered = node.id;
          const finding = this.list.find((f) => f.target === node.id);
          this.hover(finding?.number); this.drawOverlay();
        });
        group?.addEventListener("pointerleave", () => { this.hovered = undefined; this.hover(); this.drawOverlay(); });
      }
    }
    if (this.selected && !state.diagram?.nodes.some((n) => n.id === this.selected)) {
      this.selected = undefined; this.actionsOpen = false; this.actions();
    }
    this.figure.classList.toggle("stale", !state.svg);
    const placeholder = document.querySelector<HTMLElement>("#placeholder")!;
    placeholder.hidden = !!state.svg;
    placeholder.textContent = this.good ? "Model errors. Showing the last good diagram." : "The model cannot be drawn. Read the findings and fix the YAML file.";
    this.drawOverlay(true);
    if (focusId) this.group(focusId)?.focus({ preventScroll: true });
    if (focusMark) this.overlay.querySelector<SVGGElement>(`[data-finding="${focusMark}"]`)?.focus({ preventScroll: true });
    if (first && state.svg) this.fit(); else this.transform();
    if (this.actionsOpen) this.actionPosition();
  }
  highlight(number?: number, selected = false, focus = false) {
    if (selected) this.selectedFinding = number; else this.hoverFinding = number;
    const finding = this.list.find((f) => f.number === number);
    if (selected) this.selected = finding?.target;
    if (focus && finding) this.fit(targetBox(this.good?.diagram ?? null, finding.target));
    this.drawOverlay();
  }
  clear() { this.actionsOpen = false; this.actions(); this.selected = undefined; this.selectedFinding = undefined; this.hovered = undefined; this.hoverFinding = undefined; this.drawOverlay(); }
  closeActions() { this.actionsOpen = false; this.actions(); }
  has(id: string) { return !!this.good?.diagram?.nodes.some((n) => n.id === id); }
  /** Select a drawing element by node id and bring its neighborhood into view (agent change-note links). */
  selectElement(id: string): boolean {
    const diagram = this.good?.diagram;
    if (!diagram || !this.has(id)) return false;
    this.selected = id; this.selectedFinding = undefined;
    this.fit(/^[ER]:/.test(id) ? selectionNeighborhood(diagram, id).box : targetBox(diagram, id));
    if (/^[ER]:/.test(id)) this.openActions(); else { this.actionsOpen = false; this.actions(); }
    this.drawOverlay();
    return true;
  }
  /** Briefly mark changed elements with the selection halo (screen only; the export SVG is never touched). */
  flash(ids: string[], duration = 3000) {
    if (this.flashes) clearTimeout(this.flashes.timer);
    this.flashes = ids.length ? { ids, start: performance.now(), timer: setTimeout(() => { this.flashes = undefined; this.drawFlashes(); }, duration) } : undefined;
    this.drawFlashes();
  }
  private drawFlashes() {
    this.overlay.querySelector(".agent-flashes")?.remove();
    const diagram = this.good?.diagram;
    if (!diagram || !this.flashes) return;
    const group = svg("g", { class: "agent-flashes", "aria-hidden": "true" });
    // A redraw keeps the fade where it was instead of restarting it.
    group.style.animationDelay = `${-(performance.now() - this.flashes.start)}ms`;
    for (const id of this.flashes.ids) {
      const shape = this.haloShape(id, { fill: "none", stroke: "var(--graphite)", "stroke-opacity": .35, "stroke-width": 3 });
      if (shape) group.append(shape);
    }
    this.overlay.insertBefore(group, this.overlay.querySelector(".halos"));
  }
  private haloShape(id: string | undefined, attrs: Record<string, string | number>): SVGElement | undefined {
    const diagram = this.good?.diagram;
    const box = targetBox(diagram ?? null, id);
    if (!diagram || !box) return undefined;
    const node = diagram.nodes.find((n) => n.id === id);
    if (node?.kind === "attribute") return svg("ellipse", { cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2 + 6, ry: box.h / 2 + 6, ...attrs });
    if (node?.kind === "relationship") return svg("polygon", { points: `${box.x + box.w / 2},${box.y - 6} ${box.x + box.w + 6},${box.y + box.h / 2} ${box.x + box.w / 2},${box.y + box.h + 6} ${box.x - 6},${box.y + box.h / 2}`, ...attrs });
    return svg("rect", { x: box.x - 6, y: box.y - 6, width: box.w + 12, height: box.h + 12, ...attrs });
  }
  focusSelection() {
    if (this.good?.diagram && this.selected) this.fit(selectionNeighborhood(this.good.diagram, this.selected).box);
  }
  private actionPosition() {
    const box = targetBox(this.good?.diagram ?? null, this.selected);
    if (!box || !this.selected || !/^[ER]:/.test(this.selected)) { this.actions(); return; }
    const diagram = this.good!.diagram!;
    // Diagram boxes already include the origin; offset locates diagram zero on screen.
    const screen = (box: Box): Box => ({ x: box.x * this.scale + this.offset.x,
      y: box.y * this.scale + this.offset.y, w: box.w * this.scale, h: box.h * this.scale });
    const anchor = screen(box);
    this.actions(this.selected, anchor, false, (menu) => {
      const window = { x: anchor.x - menu.w - 60, y: anchor.y - menu.h - 60,
        w: anchor.w + 2 * (menu.w + 60), h: anchor.h + 2 * (menu.h + 60) };
      const obstacles: MenuObstacle[] = [];
      const add = (rect: Box, weight: number) => {
        if (rect.x < window.x + window.w && rect.x + rect.w > window.x &&
          rect.y < window.y + window.h && rect.y + rect.h > window.y) obstacles.push({ ...rect, weight });
      };
      for (const label of diagram.labels) add(screen(label.box), 4);
      for (const node of diagram.nodes) if (node.id !== this.selected) add(screen(node.box), 3);
      for (const edge of diagram.edges) {
        for (let i = 1; i < edge.points.length; i++) {
          const a = edge.points[i - 1]!, b = edge.points[i]!;
          const segment = screen({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
            w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
          add({ x: segment.x - 3, y: segment.y - 3, w: segment.w + 6, h: segment.h + 6 }, 1);
        }
      }
      return obstacles;
    });
  }
  private openActions() { this.actionsOpen = true; this.actionPosition(); }
  private group(id: string): SVGGElement | undefined {
    const groups = [...this.figure.querySelectorAll<SVGGElement>("svg:last-child g[data-id]")];
    return groups.find((g) => g.dataset.id === id);
  }
  private drawOverlay(rebuild = false) {
    if (rebuild) this.overlay.replaceChildren();
    if (this.selected !== this.notifiedSelection) { this.notifiedSelection = this.selected; this.onSelection(this.selected); }
    const diagram = this.good?.diagram;
    if (!diagram) return;
    const neighborhood = this.selected && /^[ER]:/.test(this.selected) ? selectionNeighborhood(diagram, this.selected) : undefined;
    const activeIds = new Set([...(neighborhood?.nodeIds ?? []), ...(neighborhood?.edgeIds ?? []), ...(neighborhood?.labelIds ?? [])]);
    for (const group of this.figure.querySelectorAll<SVGGElement>("svg:last-child g[data-id]")) {
      const isElement = group.classList.contains("er-entity") || group.classList.contains("er-relationship") || group.classList.contains("er-attribute") || group.classList.contains("er-edge") || diagram.labels.some((l) => l.id === group.dataset.id);
      group.classList.toggle("unrelated", !!neighborhood && isElement && !activeIds.has(group.dataset.id ?? ""));
      group.classList.toggle("connected", !!neighborhood && group.classList.contains("er-edge") && activeIds.has(group.dataset.id ?? ""));
    }
    if (rebuild) {
      const { x, y, width, height } = this.overlay.viewBox.baseVal;
      const corners = [[x, y, 1, 1], [x + width, y, -1, 1], [x, y + height, 1, -1], [x + width, y + height, -1, -1]] as const;
      this.exportCorners = corners.map(([x, y, dx, dy]) => {
        const path = svg("path", { class: "export-corner", d: `M 0 ${12 * dy} V 0 H ${12 * dx}`,
          transform: `translate(${x} ${y}) scale(${1 / this.scale})`, fill: "none", stroke: "var(--graphite)",
          "stroke-opacity": .6, "stroke-width": 1, "aria-hidden": "true" });
        this.overlay.append(path);
        return { path, x, y };
      });
    }
    this.overlay.querySelector(".halos")?.remove();
    const halos = svg("g", { class: "halos" });
    this.overlay.append(halos);
    for (const id of new Set([this.selected, this.hovered,
      this.list.find((f) => f.number === this.selectedFinding)?.target,
      this.list.find((f) => f.number === this.hoverFinding)?.target])) {
      const shape = this.haloShape(id, { fill: "none", stroke: "var(--graphite)", "stroke-opacity": .35, "stroke-width": 3, ...(id && this.state?.pins[id] ? { "stroke-dasharray": "2 4" } : {}) });
      if (shape) halos.append(shape);
    }
    if (!rebuild) return;
    this.drawFlashes();
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
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".zoom-controls, .mark, .node-actions"))) return;
    if (this.writing || this.savingDrag || this.state?.computing) return;
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
    this.actionsOpen = false; this.actions(undefined, undefined, true);
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
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) <= 4) return;
    drag.moved = true;
    this.actionsOpen = false; this.actions(undefined, undefined, true);
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
      if (!cancel && drag.id && drag.next && drag.moved) {
        this.savingDrag = true;
        void this.pinAt(drag.id, drag.next).finally(() => {
          this.savingDrag = false;
          drag.group?.removeAttribute("transform");
          this.flushPending();
        });
      } else {
        drag.group?.removeAttribute("transform");
        if (!cancel && drag.id && !drag.moved) this.openActions();
      }
    }
    this.flushPending();
  }
  private flushPending() {
    if (!this.drag && !this.savingDrag && this.pending) { const pending = this.pending; this.pending = undefined; this.show(pending.state, pending.list); }
  }

  private pinAt(id: string, point: Point): Promise<void> {
    const pin = relativeAttributePins({ [id]: point }, this.good?.diagram ?? undefined)[id]!;
    return this.pin(id, pin);
  }

  private key(e: KeyboardEvent) {
    if (this.writing || this.savingDrag || this.state?.computing) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest("button, .mark, .node-actions")) return;
    const node = this.good?.diagram?.nodes.find((n) => n.id === this.selected);
    if (e.key === "Enter" && node) {
      if (node.kind !== "attribute") { e.preventDefault(); this.openActions(); document.querySelector<HTMLButtonElement>("#node-focus")?.focus(); }
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const dx = e.key === "ArrowLeft" ? -8 : e.key === "ArrowRight" ? 8 : 0;
      const dy = e.key === "ArrowUp" ? -8 : e.key === "ArrowDown" ? 8 : 0;
      if (node) { const p = center(node.box); void this.pinAt(node.id, snap({ x: p.x + dx, y: p.y + dy }, e.altKey)); }
      else { this.offset.x -= dx * 4; this.offset.y -= dy * 4; this.transform(); }
    } else if (node && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); void this.pin(node.id, null); }
    else if (e.code === "Space") e.preventDefault();
  }
}
