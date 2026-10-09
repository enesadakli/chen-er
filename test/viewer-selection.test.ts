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
