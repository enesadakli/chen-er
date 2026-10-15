import type { Diagnostic } from "../diagnostics.js";
import { lint, LINT_DISCLAIMER } from "../lint/index.js";
import { mapModel, mappingMarkdown, type MappingResponse } from "../map/index.js";
import { flattenAttrs, type NAttribute, type NModel } from "../normalize.js";
import { elementName, liveTrace, ordinalLabel, requirementState, type RequirementsDoc } from "../requirements.js";

export type ReportBlock =
  | { kind: "text"; text: string; italic?: boolean }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "list"; title?: string; items: string[]; numbered?: boolean }
  | { kind: "diagram" }
  | { kind: "mapping"; markdown: string };
export interface ReportSection { heading: string; blocks: ReportBlock[] }
export interface ReportDoc { title: string; source: string; sections: ReportSection[] }
export interface ReportInput {
  model: NModel;
  fileName: string;
  requirements?: RequirementsDoc;
  liveIds?: ReadonlySet<string>;
  labels?: ReadonlyMap<string, string>;
  diagnostics?: readonly Diagnostic[];
  mapping?: MappingResponse;
}

const status = { applied: "Covered", changed: "Changed since last apply", new: "Not applied yet", uncovered: "Not covered" } as const;
const text = (value: string): ReportBlock => ({ kind: "text", text: value });
const table = (headers: string[], rows: string[][]): ReportBlock => ({ kind: "table", headers, rows });
const diagnosticTable = (diagnostics: readonly Diagnostic[]): ReportBlock => diagnostics.length
  ? table(["Severity", "Rule", "Message"], diagnostics.map((d) => [d.severity, d.rule, d.message + (d.hint ? ` — ${d.hint}` : "")]))
  : text("No findings.");

function attribute(a: NAttribute): string {
  let name = a.label + (a.parts.length ? `(${a.parts.map(attribute).join(", ")})` : "");
  if (a.multivalued) name = `{${name}}`;
  if (a.derived) name = `/${name}/`;
  return name;
}

function reportElementName(id: string, labels: ReadonlyMap<string, string>): string {
  const parts = id.slice(2).split(".");
  if (!id.startsWith("A:") || parts.length < 3) return elementName(id, labels);
  const owner = parts[0]!;
  const parents = parts.slice(1, -1).map((part, i) => labels.get(`A:${parts.slice(0, i + 2).join(".")}`) ?? part);
  const ownerLabel = labels.get(`E:${owner}`) ?? labels.get(`R:${owner}`) ?? owner;
  return `${labels.get(id) ?? parts.at(-1)} (${[...parents, ownerLabel].join(", ")})`;
}

const modelName = (element: { label: string; name: string }): string =>
  element.label === element.name ? element.name : `${element.label} (${element.name})`;

/** Build a submission document without I/O or layout work. */
export function buildReport(input: ReportInput): ReportDoc {
  const { model, requirements } = input;
  const elements = [...model.entities, ...model.relationships].flatMap((owner) => [owner, ...flattenAttrs(owner.attrs)]);
  const liveIds = input.liveIds ?? new Set(elements.map((e) => e.id));
  const labels = input.labels ?? new Map(elements.map((e) => [e.id, e.label]));
  const name = (id: string) => reportElementName(id, labels);
  const entities = new Map(model.entities.map((e) => [e.name, modelName(e)]));
  const sections: ReportSection[] = [];
  if (requirements) {
    const blocks: ReportBlock[] = [table(["#", "Requirement", "Model elements", "Status"], requirements.items.map((item, i) => [
      ordinalLabel(i), item.text, liveTrace(item, liveIds).map(name).join(", "), status[requirementState(item, liveIds)],
    ]))];
    const rationale = requirements.items.flatMap((item, i) => item.why ? [`${ordinalLabel(i)}: ${item.why}`] : []);
    if (rationale.length) blocks.push({ kind: "list", title: "Rationale", numbered: true, items: rationale });
    sections.push({ heading: "Requirements", blocks });
  }
  sections.push({ heading: "ER diagram", blocks: [{ kind: "diagram" }] });
  const blocks: ReportBlock[] = [
    table(["Entity", "Kind", "Key", "Attributes"], model.entities.map((e) => {
      const keyName = (key: string) => e.attrs.find((a) => a.name === key)?.label ?? key;
      const key = e.weak ? e.partialKey.map(keyName).join(", ") : e.keys.map((k) => `(${k.map(keyName).join(", ")})`).join("; ");
      return [modelName(e), e.weak ? "Weak" : "Strong", key, e.attrs.map(attribute).join(", ")];
    })),
    table(["Relationship", "Degree", "Participants (min,max)", "Attributes", "Identifying"], model.relationships.map((r) => [
      modelName(r), String(r.ends.length), r.ends.map((e) => `${entities.get(e.entity) ?? e.entity}${e.role ? ` [${e.role}]` : ""} (${e.min},${e.max})`).join(", "),
      r.attrs.map(attribute).join(", "), r.identifies ? `Yes (${name(`E:${r.identifies}`)})` : "No",
    ])),
    ...model.specializations.map((s) => text(`Specialization: ${name(`E:${s.supertype}`)} → ${s.subtypes.map((n) => name(`E:${n}`)).join(", ")} (${s.disjointness}, ${s.completeness})${s.attribute ? `; defining attribute: ${s.attribute}` : ""}${Object.keys(s.predicates).length ? `; predicates: ${s.subtypes.filter((n) => s.predicates[n]).map((n) => `${name(`E:${n}`)}: ${s.predicates[n]}`).join(", ")}` : ""}.`)),
    ...model.categories.map((c) => text(`Category (union type): ${name(`E:${c.subtype}`)} ⊆ ${c.supertypes.map((n) => name(`E:${n}`)).join(" ∪ ")} (${c.completeness}).`)),
  ];
  sections.push({ heading: "Model", blocks });
  if (requirements) {
    const traced = new Set(requirements.items.flatMap((item) => liveTrace(item, liveIds)));
    const untraced = elements.filter((e) => !traced.has(e.id)).map((e) => name(e.id));
    const uncovered = requirements.items.flatMap((item, i) => requirementState(item, liveIds) === "uncovered" ? [`${ordinalLabel(i)}: ${item.text}`] : []);
    sections.push({ heading: "Traceability", blocks: traced.size === 0
      ? [text("No requirement has been applied to the model yet, so traceability is not available.")]
      : [
      untraced.length ? { kind: "list", title: "Untraced elements", items: untraced } : text("Every model element is traced to a requirement."),
      ...(uncovered.length ? [{ kind: "list" as const, title: "Not covered", items: uncovered }] : []),
    ] });
  }
  sections.push({ heading: "Lint", blocks: [diagnosticTable(input.diagnostics ?? lint(model)), { kind: "text", text: LINT_DISCLAIMER, italic: true }] });
  const mapping = input.mapping ?? mapModel(model);
  sections.push({ heading: "Relational schema", blocks: [mapping.mapping
    ? { kind: "mapping", markdown: mappingMarkdown(mapping.mapping).replace(/^(#+) /gm, "##$1 ") }
    : diagnosticTable(mapping.diagnostics)] });
  const fileName = input.fileName.split(/[\\/]/).at(-1)!;
  return { title: model.title || fileName.replace(/(\.er)?\.ya?ml$/i, ""), source: `Model: ${fileName}`, sections };
}

const escapeMd = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/[\\`*_{}\[\]|]/g, "\\$&").replace(/\r\n|[\r\n]/g, " ");
const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function reportMarkdown(doc: ReportDoc, options: { svgFile?: string } = {}): string {
  const block = (b: ReportBlock): string => {
    switch (b.kind) {
      case "text": return b.italic ? `*${escapeMd(b.text)}*` : escapeMd(b.text);
      case "diagram": return options.svgFile ? `![ER diagram](${encodeURIComponent(options.svgFile).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)})` : "(diagram: call render_er)";
      case "table": return [b.headers, b.headers.map(() => "---"), ...b.rows].map((r) => `| ${r.map(escapeMd).join(" | ")} |`).join("\n");
      case "list": return (b.title ? `### ${b.title}\n\n` : "") + b.items.map((item, i) => `${b.numbered ? `${i + 1}.` : "-"} ${escapeMd(item)}`).join("\n");
      case "mapping": return b.markdown.trimEnd();
    }
  };
  return [`# ${escapeMd(doc.title)}`, escapeMd(doc.source), ...doc.sections.map((s) => `## ${s.heading}\n\n${s.blocks.map(block).join("\n\n")}`)].join("\n\n") + "\n";
}

/** Render the mapping formatter's paragraphs, hard breaks and PK underline markup. */
function mappingHtml(markdown: string): string {
  return markdown.trim().split(/\n\s*\n/).map((paragraph) => {
    const lines = paragraph.split("\n").map((line) => line.trimEnd().split(/(<\/?u>)/g).map((part) =>
      part === "<u>" || part === "</u>" ? part : escapeHtml(part.replace(/\\([\\`*_{}\[\]<>|])/g, "$1"))).join(""));
    return `<p>${lines.join("<br>\n")}</p>`;
  }).join("\n");
}

export function reportHtml(doc: ReportDoc, options: { svg: string }): string {
  const block = (b: ReportBlock): string => {
    switch (b.kind) {
      case "text": return `<p>${b.italic ? `<em>${escapeHtml(b.text)}</em>` : escapeHtml(b.text)}</p>`;
      case "diagram": return `<figure aria-label="ER diagram">${options.svg.replace(/^\s*<\?xml[^?]*\?>\s*/, "")}</figure>`;
      case "table": return `<table${b.headers[0] === "#" ? ' class="requirements"' : ""}><thead><tr>${b.headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "list": return (b.title ? `<h3>${escapeHtml(b.title)}</h3>` : "") + `<${b.numbered ? "ol" : "ul"}>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</${b.numbered ? "ol" : "ul"}>`;
      case "mapping": return `<div class="mapping">${mappingHtml(b.markdown)}</div>`;
    }
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.title)}</title>
<style>
@page { size: A4; margin: 16mm; }
body { font: 11pt/1.5 Arial, Helvetica, sans-serif; color: #202020; background: white; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
h1, h2, h3 { line-height: 1.2; } h2 { margin-top: 2rem; } h1, h2, h3 { break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; } th, td { border: 1px solid #777; padding: .4rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; white-space: pre-line; } th { background: #f0f0f0; }
.requirements th:first-child, .requirements td:first-child { white-space: nowrap; min-width: 3ch; overflow-wrap: normal; }
.requirements th:last-child, .requirements td:last-child { white-space: nowrap; min-width: 16ch; overflow-wrap: normal; }
table, figure { page-break-inside: avoid; break-inside: avoid; } figure { margin: 1rem 0; } svg { width: 100%; height: auto; } .mapping p { break-inside: avoid; }
@media print { body { margin: 0; padding: 0; max-width: none; font-size: 10pt; } }
</style></head><body>
<h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.source)}</p>
${doc.sections.map((s) => `<section><h2>${escapeHtml(s.heading)}</h2>\n${s.blocks.map(block).join("\n")}</section>`).join("\n")}
</body></html>\n`;
}
