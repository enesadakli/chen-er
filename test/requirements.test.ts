import { describe, expect, it } from "vitest";
import {
  elementName, extractTrace, nextRequirementId, parseRequirements, pendingRequirements, requirementState,
  serializeRequirements, textHash, validateTrace, type Requirement,
} from "../src/core/requirements.js";
import { buildRequirementsPrompt } from "../src/app/agent-prompt.js";
import { parseSaveRequest, requirementsPathFor, textsRevision } from "../src/app/requirements.js";

const applied = (id: string, text: string, trace: string[], why?: string): Requirement => ({ id, text, applied: textHash(text), trace, ...(why ? { why } : {}) });

describe("requirements file", () => {
  it("names the file next to the model like the layout file", () => {
    expect(requirementsPathFor("/m/club.er.yaml")).toBe("/m/club.er.requirements.md");
    expect(requirementsPathFor("/m/club.yml")).toBe("/m/club.er.requirements.md");
  });

  it("round-trips ids, applied hashes, traces and rationales and prints a readable trace line", () => {
    const doc = { title: "Requirements: University", items: [
      applied("r1", "Every course is offered by exactly one department.", ["E:COURSE", "R:OFFERS", "A:COURSE.Title"], "OFFERS is (1,1) on the COURSE side."),
      { id: "r3", text: "A student enrolls in many courses." },
      applied("r4", "Rooms have a capacity.", []),
    ] };
    const text = serializeRequirements(doc, new Map([["A:COURSE.Title", "Course title"]]));
    expect(text).toContain("# Requirements: University\n");
    expect(text).toContain('1. Every course is offered by exactly one department. <!-- chen-er {"id":"r1","applied":');
    expect(text).toContain("   *→ COURSE, OFFERS, Course title (COURSE). OFFERS is (1,1) on the COURSE side.*\n");
    expect(text).toContain('2. A student enrolls in many courses. <!-- chen-er {"id":"r3"} -->\n3.');
    expect(text).toContain("   *△ Not reflected in the model.*");
    expect(parseRequirements(text)).toEqual(doc);
    expect(serializeRequirements(parseRequirements(text), new Map([["A:COURSE.Title", "Course title"]]))).toBe(text);
  });

  it("omits the trace line while a line is changed since its apply", () => {
    const text = serializeRequirements({ items: [{ ...applied("r1", "Old text", ["E:A"]), text: "New text" }] });
    expect(text).not.toContain("*→");
    expect(parseRequirements(text).items[0]).toMatchObject({ id: "r1", text: "New text", trace: ["E:A"] });
  });

  it("reads a hand-written Obsidian list, keeps prose and assigns ids in order", () => {
    const doc = parseRequirements("# My notes\n\nFrom the project brief.\n\n- Students have a number\n* Courses have a code\n   that is unique\n3) Teachers teach courses <!-- chen-er {\"id\":\"r1\"} -->\n\nAsk about rooms.\n");
    expect(doc.title).toBe("My notes");
    expect(doc.intro).toBe("From the project brief.");
    expect(doc.outro).toBe("Ask about rooms.");
    expect(doc.items).toEqual([
      { id: "r2", text: "Students have a number" },
      { id: "r3", text: "Courses have a code that is unique" },
      { id: "r1", text: "Teachers teach courses" },
    ]);
    const again = serializeRequirements(doc);
    expect(again).toContain("From the project brief.");
    expect(again.trimEnd().endsWith("Ask about rooms.")).toBe(true);
    expect(parseRequirements(again)).toEqual(doc);
  });

  it("gives duplicate ids a fresh one and ignores malformed comments", () => {
    const doc = parseRequirements('1. A <!-- chen-er {"id":"r1","applied":"zz","trace":["bad id", "E:A"]} -->\n2. B <!-- chen-er {"id":"r1"} -->\n3. C <!-- chen-er {not json} -->\n');
    expect(doc.items).toEqual([{ id: "r1", text: "A", trace: ["E:A"] }, { id: "r2", text: "B" }, { id: "r3", text: "C" }]);
  });

  it("escapes comment markers in the text so the state comment stays intact", () => {
    const doc = { items: [{ id: "r1", text: "Use <!-- and --> literally" }] };
    const text = serializeRequirements(doc);
    expect(text).toContain("Use &lt;!-- and --&gt; literally <!-- chen-er");
    expect(parseRequirements(text).items).toEqual(doc.items);
    const why = serializeRequirements({ items: [applied("r1", "x", ["E:A"], "a --> b <!-- c")] });
    expect(why.match(/-->/g)).toHaveLength(2); // the format comment and the item's state comment
    expect(why).toContain("*→ A. a --&gt; b &lt;!-- c*");
    expect(parseRequirements(why).items[0]!.why).toBe("a --> b <!-- c");
  });

  it("hashes normalized text and never reuses a higher id", () => {
    expect(textHash("  Every  course\n")).toBe(textHash("Every course"));
    expect(textHash("Every course")).toMatch(/^[0-9a-f]{8}$/);
    expect(textHash("a")).not.toBe(textHash("b"));
    expect(nextRequirementId(["r1", "r7", "x", "r3"])).toBe("r8");
    expect(nextRequirementId([])).toBe("r1");
  });

  it("names elements from their ids when no label is known", () => {
    expect(elementName("A:STUDENT.Name.First")).toBe("First (STUDENT)");
    expect(elementName("R:ENROLLS")).toBe("ENROLLS");
  });
});

describe("line state and pending lines", () => {
  const items: Requirement[] = [
    { id: "r1", text: "new one" },
    { ...applied("r2", "was this", ["E:A"]), text: "now this" },
    applied("r3", "covered", ["E:A", "E:B"]),
    applied("r4", "uncovered", []),
    applied("r5", "elements removed later", ["E:GONE"]),
    { id: "r6", text: "   " },
  ];
  it("derives new, changed, applied and not covered (against the live model when known)", () => {
    expect(items.slice(0, 5).map((i) => requirementState(i))).toEqual(["new", "changed", "applied", "uncovered", "applied"]);
    expect(requirementState(items[4]!, new Set(["E:A"]))).toBe("uncovered");
    expect(requirementState(items[2]!, new Set(["E:B"]))).toBe("applied");
  });
  it("applies only new and changed non-empty lines", () => {
    expect(pendingRequirements(items).map((i) => i.id)).toEqual(["r1", "r2"]);
  });
});

describe("trace from the agent", () => {
  it("takes the last chen-trace block and strips it from the reply", () => {
    const reply = 'Added COURSE.\n\n```json\n{"x":1}\n```\n\n```chen-trace\n{"r1":{"elements":["E:COURSE"],"why":"w"}}\n```\n';
    const { raw, reply: rest } = extractTrace(reply);
    expect(raw).toEqual({ r1: { elements: ["E:COURSE"], why: "w" } });
    expect(rest).toBe('Added COURSE.\n\n```json\n{"x":1}\n```');
    expect(extractTrace("No block here.")).toEqual({ reply: "No block here." });
    expect(extractTrace("```chen-trace\nnot json\n```").raw).toBeUndefined();
    expect(extractTrace('Done.\n```json\n{"r2":["E:A"]}\n```').raw).toEqual({ r2: ["E:A"] });
  });

  it("validates element ids against the model, resolves bare names and ignores ids it did not apply", () => {
    const model = new Set(["E:COURSE", "R:OFFERS", "A:COURSE.Title", "E:DUP", "R:DUP"]);
    const result = validateTrace({
      r1: { elements: ["E:COURSE", "OFFERS", "E:GHOST", "DUP", "E:COURSE", 7], why: "  one\nline " },
      R2: ["A:COURSE.Title"],
      r9: { elements: ["E:COURSE"] },
    }, ["r1", "r2", "r3"], model);
    expect(result.entries).toEqual({
      r1: { elements: ["E:COURSE", "R:OFFERS"], why: "one line.", dropped: ["E:GHOST", "DUP"] },
      r2: { elements: ["A:COURSE.Title"] },
    });
    expect(result.missing).toEqual(["r3"]);
  });

  it("accepts the list form and a wrapped object", () => {
    const model = new Set(["E:A"]);
    expect(validateTrace([{ id: "r1", elements: ["E:A"] }], ["r1"], model).entries).toEqual({ r1: { elements: ["E:A"] } });
    expect(validateTrace({ requirements: { r1: { elements: ["E:A"] } } }, ["r1"], model).entries).toEqual({ r1: { elements: ["E:A"] } });
    expect(validateTrace(undefined, ["r1"], model)).toEqual({ entries: {}, missing: ["r1"] });
  });
});

describe("requirements prompt", () => {
  it("lists the lines to apply with ids, the whole list as context, the rules and the trace format", () => {
    const prompt = buildRequirementsPrompt({ modelPath: "/m/uni.er.yaml", lintCommand: "node /x/bin/chen.js lint",
      apply: [{ id: "r2", label: "R2", text: "Students enroll in courses.", changed: true, trace: ["R:ENROLLS"] }, { id: "r5", label: "R3", text: "Rooms have a capacity." }],
      all: [{ id: "r1", label: "R1", text: "Every course has a code." }, { id: "r2", label: "R2", text: "Students enroll in courses." }, { id: "r5", label: "R3", text: "Rooms have a capacity." }] });
    expect(prompt).toContain("Model file: /m/uni.er.yaml");
    expect(prompt).toContain("- Edit only that YAML file.");
    expect(prompt).toContain("run `node /x/bin/chen.js lint /m/uni.er.yaml` and fix any errors");
    expect(prompt).toContain("- Never edit *.er.layout.json, *.er.agent.json or *.er.requirements.md files.");
    expect(prompt).toContain("- Never write coordinates or layout");
    expect(prompt).toContain("Requirements to apply now (new or changed since the last apply):\nr2 (R2): Students enroll in courses.  [changed; it was linked to R:ENROLLS]\nr5 (R3): Rooms have a capacity.  [new]\n");
    expect(prompt).toContain("All requirements, for context:\nr1 (R1): Every course has a code.\nr2 (R2)");
    expect(prompt).toContain("Model format (version 1 YAML");
    expect(prompt).toContain("{entity: DEPARTMENT, card: \"1..N\"}");
    expect(prompt).toMatch(/```chen-trace\n\{"r2":\{"elements":\["E:COURSE","R:OFFERS","A:COURSE.Title"\],"why":"[^"]+"\},"r5":\{"elements":\[\],"why":"[^"]+"\}\}\n```$/);
  });
});

describe("save requests", () => {
  it("accepts ids and texts with a revision and rejects everything else", () => {
    expect(parseSaveRequest({ items: [{ id: "r1", text: " a  b " }], expectedRevision: "x" })).toEqual({ items: [{ id: "r1", text: "a b" }], expectedRevision: "x" });
    const bad = [
      { items: [], expectedRevision: 1 },
      { items: [{ id: "r1", text: "a" }] },
      { items: [{ id: "r1", text: "a" }, { id: "r1", text: "b" }], expectedRevision: "x" },
      { items: [{ id: "x1", text: "a" }], expectedRevision: "x" },
      { items: [{ id: "r1", text: "  " }], expectedRevision: "x" },
      { items: [{ id: "r1", text: "a", applied: "00000000" }], expectedRevision: "x" },
      { items: Array.from({ length: 301 }, (_, i) => ({ id: `r${i + 1}`, text: "a" })), expectedRevision: "x" },
      { items: [], expectedRevision: "x", extra: 1 },
    ];
    for (const value of bad) expect(() => parseSaveRequest(value as Record<string, unknown>)).toThrow();
  });
  it("revisions cover ids and texts only", () => {
    expect(textsRevision([{ id: "r1", text: "a" }])).toBe(textsRevision([{ id: "r1", text: " a ", applied: "00000000", trace: ["E:A"] } as Requirement]));
    expect(textsRevision([{ id: "r1", text: "a" }])).not.toBe(textsRevision([{ id: "r2", text: "a" }]));
  });
});
