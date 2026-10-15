import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderText } from "../src/app/render.js";
import { selectionNeighborhood } from "../src/viewer/selection.js";

for (const kind of ["binary", "recursive", "ternary"]) describe(`${kind} selection neighborhood`, () => {
  it("keeps all relationship ends and their labels together when selecting either the diamond or a participant", async () => {
    const yaml = readFileSync(new URL(`./fixtures/viewer-focus/${kind}.er.yaml`, import.meta.url), "utf8");
    const { diagram } = await renderText(yaml, { engine: "simple" });
    expect(diagram).toBeDefined();
    const rel = diagram!.nodes.find((n) => n.kind === "relationship")!;
    const ends = diagram!.edges.filter((e) => e.kind === "end" && e.from === rel.id);
    for (const owner of [rel.id, ends[0]!.to]) {
      const selection = selectionNeighborhood(diagram!, owner);
      for (const end of ends) {
        expect(selection.edgeIds).toContain(end.id); expect(selection.nodeIds).toContain(end.to);
        for (const label of diagram!.labels.filter((l) => l.edge === end.id)) expect(selection.labelIds).toContain(label.id);
      }
      expect(selection.box).toBeDefined();
      const disconnected = diagram!.nodes.find((n) => n.kind === "entity" && !ends.some((e) => e.to === n.id));
      if (disconnected) expect(selection.nodeIds).not.toContain(disconnected.id);
    }
  });
});

describe("specialization selection neighborhood", () => {
  it("collects superclass, subclasses and predicate labels without needing a model owner", () => {
    const diagram: import("../src/core/geometry.js").Diagram = {
      width: 300, height: 300, notes: [], meta: { engine: "test" },
      nodes: [
        { id: "S:Person.0", kind: "specialization", label: "Person.0", double: false, box: { x: 90, y: 90, w: 30, h: 30 } },
        ...["Person", "Student", "Teacher"].map((name, i) => ({ id: `E:${name}`, kind: "entity" as const, label: name, double: false, box: { x: i * 80, y: i ? 200 : 0, w: 70, h: 40 } })),
      ],
      edges: ["super", "Student", "Teacher"].map((end) => ({ id: `edge:S:Person.0#${end}`, kind: "end" as const, from: "S:Person.0", to: `E:${end === "super" ? "Person" : end}`, double: end === "super", points: [] })),
      labels: [{ id: "predicate", kind: "specialization", text: "Job", edge: "edge:S:Person.0#Teacher", box: { x: 120, y: 150, w: 30, h: 18 } }],
    };
    for (const id of ["S:Person.0", "E:Student"]) {
      const selection = selectionNeighborhood(diagram, id);
      expect(selection.nodeIds.sort()).toEqual(diagram.nodes.map((n) => n.id).sort());
      expect(selection.edgeIds).toHaveLength(3);
      expect(selection.labelIds).toEqual(["predicate"]);
      expect(selection.box).toBeDefined();
    }
    expect(() => selectionNeighborhood(diagram, "edge:S:Person.0#Teacher")).not.toThrow();
  });
});
