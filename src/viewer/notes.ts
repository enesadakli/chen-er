import { glyphs, severities, yamlExcerpt, type Finding } from "./logic.js";

export class Notes {
  private list: Finding[] = [];
  private selected?: number;
  private yaml = "";
  constructor(private root: HTMLElement, private choose: (number: number) => void, private hover: (number?: number) => void) {}
  show(list: Finding[], yaml: string, selected?: number) {
    const active = document.activeElement;
    const card = active instanceof Element && this.root.contains(active) ? active.closest<HTMLElement>("[data-finding]") : null;
    const previous = card && this.list.find((f) => f.number === Number(card.dataset.finding));
    const focus = previous ? list.find((f) => f.rule === previous.rule && f.path === previous.path && f.message === previous.message)?.number ?? null : undefined;
    this.list = list; this.yaml = yaml; this.selected = selected; this.render(focus);
  }
  select(number?: number) {
    this.selected = number; this.render(number ?? null);
    if (number) this.root.querySelector(`[data-finding="${number}"]`)?.scrollIntoView({ block: "nearest" });
  }
  highlight(number?: number) {
    for (const card of this.root.querySelectorAll<HTMLElement>("[data-finding]")) card.classList.toggle("hovered", Number(card.dataset.finding) === number);
  }
  private render(focusOverride?: number | null) {
    const active = document.activeElement;
    const focusedCard = active instanceof Element && this.root.contains(active) ? active.closest<HTMLElement>("[data-finding]") : null;
    const focusNumber = focusedCard ? focusOverride !== undefined ? focusOverride : Number(focusedCard.dataset.finding) : undefined;
    const focusSelector = active?.classList.contains("line-link") ? ".line-link" : active?.classList.contains("excerpt") ? ".excerpt" : "button";
    this.root.replaceChildren();
    if (!this.list.length) {
      const p = document.createElement("p"); p.textContent = "No findings. That does not mean the model is right."; this.root.append(p); return;
    }
    for (const severity of severities) {
      const group = this.list.filter((f) => f.severity === severity);
      if (!group.length) continue;
      const heading = document.createElement("h2"); heading.textContent = `${severity[0]!.toUpperCase()}${severity.slice(1)} (${group.length})`; this.root.append(heading);
      for (const finding of group) {
        const card = document.createElement("article");
        card.className = `finding ${severity}${this.selected === finding.number ? ' selected' : ''}`;
        card.dataset.finding = String(finding.number);
        const button = document.createElement("button");
        button.setAttribute("aria-expanded", String(this.selected === finding.number));
        const identity = document.createElement("span"); identity.className = "identity";
        const number = document.createElement("span"); number.className = "number"; number.textContent = String(finding.number);
        const glyph = document.createElement("span"); glyph.className = "glyph"; glyph.textContent = glyphs[severity]; glyph.setAttribute("aria-hidden", "true");
        identity.append(number, glyph, document.createTextNode(severity)); button.append(identity);
        const message = document.createElement("span"); message.className = "message"; message.textContent = finding.message; button.append(message);
        button.addEventListener("click", () => this.choose(finding.number)); card.append(button);
        if (finding.hint) { const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = finding.hint; card.append(hint); }
        if (finding.line) {
          const link = document.createElement("a"); link.className = "line-link"; link.href = `#finding-${finding.number}`; link.textContent = `line ${finding.line}`;
          link.addEventListener("click", (e) => { e.preventDefault(); this.choose(finding.number); }); card.append(link);
        }
        card.id = `finding-${finding.number}`;
        if (this.selected === finding.number) {
          const excerpt = document.createElement("div"); excerpt.className = "excerpt"; excerpt.tabIndex = 0; excerpt.setAttribute("aria-label", "YAML excerpt");
          for (const line of yamlExcerpt(this.yaml, finding.line)) {
            const row = document.createElement("div"); row.className = `source-line${line.target ? ' target' : ''}`;
            const number = document.createElement("span"); number.className = "line-number"; number.textContent = String(line.line);
            const code = document.createElement("code"); code.textContent = line.text; row.append(number, code); excerpt.append(row);
          }
          if (!excerpt.childElementCount) excerpt.textContent = "No source location available.";
          card.append(excerpt);
        }
        card.addEventListener("pointerenter", () => this.hover(finding.number));
        card.addEventListener("pointerleave", () => this.hover()); this.root.append(card);
      }
    }
    if (focusNumber === null) { this.root.tabIndex = -1; this.root.focus({ preventScroll: true }); }
    if (focusNumber) this.root.querySelector<HTMLElement>(`[data-finding="${focusNumber}"] ${focusSelector}`)?.focus({ preventScroll: true });
  }
}
