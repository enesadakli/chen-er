import { describe, expect, it } from "vitest";
import { normalize } from "../src/core/normalize.js";
import { buildReport, reportHtml, reportMarkdown } from "../src/core/report/index.js";
import { textHash, type Requirement } from "../src/core/requirements.js";

const model = normalize({ version: 1, entities: {
  PERSON: { label: "Person | <student>", attrs: ["Id", { name: "Name", parts: ["First", "Last"] }, { name: "Phones", multivalued: true }, { name: "Age", derived: true }], keys: [["Id"]] },
  RECORD: { weak: true, attrs: ["Sequence"], partialKey: ["Sequence"] },
}, relationships: { HAS_RECORD: { identifies: "RECORD", ends: [{ entity: "PERSON", card: "0..N", role: "owner" }, { entity: "RECORD", card: "1..1" }], attrs: ["Date"] } } });
const applied = (id: string, text: string, trace: string[], why?: string): Requirement => ({ id, text, applied: textHash(text), trace, why });
const items = [
  applied("r8", "Identify people", ["E:PERSON", "A:PERSON.Id", "E:REMOVED"], "A key | identifies <people>."),
  { ...applied("r2", "Changed rule", ["E:RECORD"]), applied: textHash("Old rule") },
  { id: "r3", text: "A new | rule\nwith <text>" },
  applied("r4", "Missing capacity", ["A:REMOVED.Capacity"]),
];

describe("method report core", () => {
  it("keeps sections in order and omits requirements and traceability when absent", () => {
    const doc = buildReport({ model, fileName: "/ignored/course.er.yml" });
    expect(doc.title).toBe("course");
    expect(doc.source).toBe("Model: course.er.yml");
    expect(doc.sections.map((s) => s.heading)).toEqual(["ER diagram", "Model", "Lint", "Relational schema"]);
    const withRequirements = buildReport({ model, fileName: "course.er.yaml", requirements: { items } });
    expect(withRequirements.sections.map((s) => s.heading)).toEqual(["Requirements", "ER diagram", "Model", "Traceability", "Lint", "Relational schema"]);
    const md = reportMarkdown(doc, { svgFile: "course.report.svg" });
    expect(md).toContain("![ER diagram](course.report.svg)");
    expect(md).toContain("Name(First, Last)");
    expect(md).toContain("\\{Phones\\}");
    expect(md).toContain("/Age/");
    expect(md).toContain("\\[owner\\]");
    expect(md).toContain("Step 2:");
    expect(md).toContain("does not mean the model is right");
  });

  it("uses ordinal labels, live model names, all states and a separate rationale list", () => {
    const doc = buildReport({ model, fileName: "course.er.yaml", requirements: { items } });
    const requirements = doc.sections[0]!.blocks;
    expect(requirements[0]).toMatchObject({ kind: "table", rows: [
      ["R1", "Identify people", "Person | <student>, Id (Person | <student>)", "Covered"],
      ["R2", "Changed rule", "RECORD", "Changed since last apply"],
      ["R3", "A new | rule\nwith <text>", "", "Not applied yet"],
      ["R4", "Missing capacity", "", "Not covered"],
    ] });
    expect(requirements[1]).toMatchObject({ kind: "list", title: "Rationale", numbered: true, items: ["R1: A key | identifies <people>."] });
    const trace = doc.sections.find((s) => s.heading === "Traceability")!;
    expect(trace.blocks[0]).toMatchObject({ title: "Untraced elements", items: expect.arrayContaining(["First (Name, Person | <student>)", "Date (HAS_RECORD)"]) });
    expect(trace.blocks[1]).toMatchObject({ title: "Not covered", items: ["R4: Missing capacity"] });
  });

  it("reports complete traces and treats an empty existing requirements document as present", () => {
    const ids = ["E:PERSON", "E:RECORD", "R:HAS_RECORD", "A:PERSON.Id", "A:PERSON.Name", "A:PERSON.Name.First", "A:PERSON.Name.Last", "A:PERSON.Phones", "A:PERSON.Age", "A:RECORD.Sequence", "A:HAS_RECORD.Date"];
    const doc = buildReport({ model, fileName: "course.er.yaml", requirements: { items: [applied("r1", "All facts", ids)] } });
    expect(reportMarkdown(doc)).toContain("Every model element is traced to a requirement.");
    expect(buildReport({ model, fileName: "course.er.yaml", requirements: { items: [] } }).sections[0]!.heading).toBe("Requirements");
  });

  it("escapes cells, HTML text and hints and generates identical bytes on repeated builds", () => {
    const input = { model, fileName: "course.er.yaml", requirements: { items }, diagnostics: [{ severity: "info" as const, rule: "test", message: "a | b\n<script>", hint: "Use <safe>" }] };
    const a = buildReport(input), b = buildReport(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(reportMarkdown(a)).toBe(reportMarkdown(b));
    expect(reportHtml(a, { svg: "<svg></svg>" })).toBe(reportHtml(b, { svg: "<svg></svg>" }));
    const md = reportMarkdown(a);
    expect(md).toContain("a \\| b &lt;script&gt; — Use &lt;safe&gt;");
    expect(md).toContain("A new \\| rule with &lt;text&gt;");
    const html = reportHtml(a, { svg: "<svg></svg>" });
    expect(html).toContain("Person | &lt;student&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<svg>");
  });

  it.each([
    { items: [] },
    { items: [{ id: "r1", text: "New requirement" }] },
    { items: [applied("r1", "No coverage", [])] },
    { items: [applied("r1", "Removed element", ["E:REMOVED"])] },
  ])("shows a traceability sentence when no live trace exists: %j", ({ items }) => {
    const doc = buildReport({ model, fileName: "course.er.yaml", requirements: { items } });
    expect(doc.sections.find((s) => s.heading === "Traceability")!.blocks).toEqual([
      { kind: "text", text: "No requirement has been applied to the model yet, so traceability is not available." },
    ]);
    for (const output of [reportMarkdown(doc), reportHtml(doc, { svg: "<svg></svg>" })]) {
      expect(output).not.toContain("Untraced elements");
    }
  });

  it("qualifies composite parts by their full labeled parent chain for both owner kinds", () => {
    const club = normalize({ version: 1, entities: { CLUB: { label: "Sports Club", keys: [["Id"]], attrs: ["Id", "Name",
      { name: "TrainingGround", label: "Training ground", parts: ["Name", { name: "Address", label: "Postal address", parts: ["Name", "City"] }] },
    ] } }, relationships: { MEETS: { attrs: [{ name: "Venue", parts: ["Name", "City"] }], ends: [
      { entity: "CLUB", role: "host", card: "0..N" }, { entity: "CLUB", role: "guest", card: "0..N" },
    ] } } });
    const input = { model: club, fileName: "club.er.yaml", requirements: { items: [applied("r1", "Naming", [
      "A:CLUB.Name", "A:CLUB.TrainingGround.Name", "A:CLUB.TrainingGround.Address.Name", "A:MEETS.Venue.Name",
    ], "Keep this rationale unchanged.")] } };
    const doc = buildReport(input);
    expect(doc.sections[0]!.blocks[0]).toMatchObject({ rows: [["R1", "Naming",
      "Name (Sports Club), Name (Training ground, Sports Club), Name (Training ground, Postal address, Sports Club), Name (Venue, MEETS)", "Covered"]] });
    expect(doc.sections[0]!.blocks[1]).toMatchObject({ items: ["R1: Keep this rationale unchanged."] });
    const partial = buildReport({ ...input, requirements: { items: [applied("r1", "Club", ["E:CLUB"])] } });
    expect(partial.sections.find((s) => s.heading === "Traceability")!.blocks[0]).toMatchObject({ items: expect.arrayContaining([
      "Name (Sports Club)", "Name (Training ground, Sports Club)", "Name (Training ground, Postal address, Sports Club)", "Name (Venue, MEETS)",
    ]) });
    expect(reportHtml(doc, { svg: "<svg></svg>" })).toContain("Name (Training ground, Postal address, Sports Club)");
  });

  it("connects model labels to relational ids without repeating identical labels", () => {
    const labeled = { ...model, relationships: model.relationships.map((r) => ({ ...r, label: "Has record" })) };
    const doc = buildReport({ model: labeled, fileName: "course.er.yaml" });
    const blocks = doc.sections.find((s) => s.heading === "Model")!.blocks;
    expect(blocks[0]).toMatchObject({ rows: [
      ["Person | <student> (PERSON)", "Strong", "(Id)", expect.any(String)],
      ["RECORD", "Weak", "Sequence", "Sequence"],
    ] });
    expect(blocks[1]).toMatchObject({ rows: [["Has record (HAS_RECORD)", "2",
      "Person | <student> (PERSON) [owner] (0,N), RECORD (1,1)", "Date", "Yes (RECORD)"]] });
    const html = reportHtml(doc, { svg: "<svg></svg>" });
    expect(html).toContain("Person | &lt;student&gt; (PERSON)");
    expect(html).toContain("Has record (HAS_RECORD)");
    expect(reportMarkdown(doc)).toContain("Has record (HAS\\_RECORD)");
    expect(html).not.toContain("RECORD (RECORD)");
  });

  it("keeps R10 and status cells on one line with widths scoped to the HTML requirements table", () => {
    const doc = buildReport({ model, fileName: "course.er.yaml", requirements: { items: Array.from({ length: 10 }, (_, i) => ({ id: `r${i + 1}`, text: "New requirement" })) } });
    const html = reportHtml(doc, { svg: "<svg></svg>" });
    expect(html).toContain('<table class="requirements">');
    expect(html).toContain("<td>R10</td>");
    expect(html).toMatch(/\.requirements th:first-child, \.requirements td:first-child \{ white-space: nowrap; min-width: 3ch;/);
    expect(html).toMatch(/\.requirements th:last-child, \.requirements td:last-child \{ white-space: nowrap; min-width: 16ch;/);
    expect(reportMarkdown(doc)).toContain("| R10 | New requirement |  | Not applied yet |");
    expect(reportMarkdown(doc)).not.toContain("requirements\"");
  });

  it("includes specializations and mapping failure diagnostics", () => {
    const doc = buildReport({ model: { ...model, title: "Course", specializations: [{ supertype: "PERSON", subtypes: ["RECORD"], disjointness: "disjoint", completeness: "partial" }] }, fileName: "course.er.yaml", mapping: { diagnostics: [{ rule: "mapping", severity: "error", message: "Cannot map" }] } });
    expect(doc.title).toBe("Course");
    const md = reportMarkdown(doc);
    expect(md).toContain("Specialization:");
    expect(md).toContain("disjoint, partial");
    expect(md).toContain("| error | mapping | Cannot map |");
    const clean = buildReport({ model: normalize({ version: 1, entities: {} }), fileName: "empty.yaml" });
    expect(reportMarkdown(clean)).toContain("No findings.");
  });
});
