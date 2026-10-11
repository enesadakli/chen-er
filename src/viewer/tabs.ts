/** The notes column tablist: Notes | Requirements | Agent. Arrow keys, Home and End move between visible tabs. */
export type TabName = "notes" | "requirements" | "agent";
interface Tab { name: TabName; tab: HTMLButtonElement; panel: HTMLElement }

export class NotesTabs {
  private listeners: ((name: TabName) => void)[] = [];
  constructor(private items: Tab[]) {
    for (const item of items) {
      item.tab.addEventListener("click", () => this.show(item.name));
      item.tab.addEventListener("keydown", (e) => {
        const visible = this.items.filter((i) => !i.tab.hidden);
        const index = visible.indexOf(item);
        const next = e.key === "ArrowRight" ? index + 1 : e.key === "ArrowLeft" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? visible.length - 1 : undefined;
        if (next === undefined) return;
        e.preventDefault();
        const target = visible[(next + visible.length) % visible.length]!;
        this.show(target.name); target.tab.focus();
      });
    }
  }
  onChange(listener: (name: TabName) => void) { this.listeners.push(listener); }
  active(): TabName { return this.items.find((i) => i.tab.getAttribute("aria-selected") === "true")?.name ?? "notes"; }
  show(name: TabName) {
    const target = this.items.find((i) => i.name === name && !i.tab.hidden) ?? this.items[0]!;
    for (const item of this.items) {
      const on = item === target;
      item.tab.setAttribute("aria-selected", String(on)); item.tab.tabIndex = on ? 0 : -1; item.panel.hidden = !on;
    }
    for (const listener of this.listeners) listener(target.name);
  }
  focus(name: TabName) { this.items.find((i) => i.name === name)?.tab.focus(); }
  /** Show or hide a tab (the Agent tab exists only with `chen serve --agent`). */
  available(name: TabName, on: boolean) {
    const item = this.items.find((i) => i.name === name);
    if (!item || item.tab.hidden === !on) return;
    item.tab.hidden = !on;
    if (!on && this.active() === name) this.show("notes");
  }
}
