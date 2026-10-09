import { describe, expect, it } from "vitest";
import { anchor, boxAround, center, type Diagram, type DNode } from "../src/core/geometry.js";
import { hierarchyDag, hierarchyPairs, semanticRelations } from "../src/core/layout/semantic-graph.js";
import { layoutScore } from "../src/core/layout/compact.js";
import { normalize, type NModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";

const node = (id: string, x: number, y: number, kind: DNode["kind"] = "entity"): DNode => ({ id, kind, label: id, box: boxAround({ x, y }, 100, 40), double: false });
const model = (cards: string[] = ["0..N", "1..1"], identifies?: string) => normalize({ version: 1, entities: { A: {}, B: { weak: !!identifies }, C: {}, D: {} }, relationships: { AB: { identifies, ends: cards.map((card, i) => ({ entity: i ? "B" : "A", card })) } } });
function diagram(m: NModel, ns = [node("E:A", 150, 150), node("E:B", 150, 450), node("E:C", 650, 150), node("E:D", 650, 450)], diamonds = [node("R:AB", 150, 300, "relationship")]): Diagram {
  const nodes = [...ns, ...diamonds];
  const edges = m.relationships.flatMap((r) => r.ends.map((end) => {
    const from = nodes.find((n) => n.id === r.id)!, to = nodes.find((n) => n.id === `E:${end.entity}`)!;
    return { id: `edge:${end.id}`, kind: "end" as const, from: from.id, to: to.id, points: [anchor(from, center(to.box)), anchor(to, center(from.box))], end: end.id, double: r.identifies === end.entity };
  }));
  return { width: 1000, height: 1000, nodes, edges, labels: [], notes: [], meta: { engine: "test" } };
}

describe("semantic quality", () => {
  it("counts reversed parent/child pairs and permits a shared row ordered left to right", () => {
    const m = model(), d = diagram(m);
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(0);
    d.nodes.find((n) => n.id === "E:A")!.box.y = 600;
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(1);
    d.nodes.find((n) => n.id === "E:A")!.box = boxAround({ x: 50, y: 450 }, 100, 40);
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(0);
  });
  it.each([["1..1", "0..1"], ["0..N", "1..N"], ["0..N", "1..3"]])("ignores non-hierarchical cardinalities %s / %s", (...cards) => {
    const m = model(cards), d = diagram(m);
    d.nodes[0]!.box.y = 600;
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(0);
  });
  it("places identified weak entities after their owners regardless of cardinality", () => {
    const m = model(["1..1", "1..1"], "B"), d = diagram(m);
    d.nodes[0]!.box.y = 600;
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(1);
  });
  it("counts a violated hierarchy pair once even with parallel relationships", () => {
    const m = model();
    m.relationships.push({ ...m.relationships[0]!, id: "R:AB2" });
    expect(hierarchyPairs(semanticRelations(diagram(model()), m))).toHaveLength(1);
  });
  it("caps violations inside a cycle at one and breaks cycles deterministically for ranking", () => {
    const pairs = [{ parent: "A", child: "B" }, { parent: "B", child: "C" }, { parent: "C", child: "A" }];
    const dag = hierarchyDag(["A", "B", "C"], pairs);
    expect(dag.pairs).toHaveLength(2);
    expect(hierarchyDag(["C", "A", "B"], [...pairs].reverse()).pairs).toEqual(dag.pairs);
    expect([...dag.ranks.values()].sort()).toEqual([0, 1, 2]);
    const m = normalize({ version: 1, entities: { A: {}, B: {}, C: {} }, relationships: Object.fromEntries(pairs.map((p, i) => [`R${i}`, { ends: [{ entity: p.parent, card: "0..N" }, { entity: p.child, card: "1..1" }] }])) });
    const d = diagram(m, [node("E:A", 100, 600), node("E:B", 100, 400), node("E:C", 100, 200)], m.relationships.map((r, i) => node(r.id, 300, 100 + i * 200, "relationship")));
    expect(assessQuality(d, {}, m).hierarchyViolations).toBe(1);
  });
  it("normalizes midpoint offsets by the inter-entity span and ignores recursive diamonds", () => {
    const m = model(), d = diagram(m);
    expect(assessQuality(d, {}, m).diamondOffset).toBe(0);
    d.nodes.at(-1)!.box.x += 45;
    expect(assessQuality(d, {}, m).diamondOffset).toBeCloseTo(0.15);
    m.relationships[0]!.ends[1]!.entity = "A";
    expect(assessQuality(d, {}, m).diamondOffset).toBe(0);
  });
  it("measures n-ary diamonds against the centroid and mean pairwise span", () => {
    const m = normalize({ version: 1, entities: { A: {}, B: {}, C: {} }, relationships: { ABC: { ends: ["A", "B", "C"].map((entity) => ({ entity, card: "0..N" })) } } });
    const d = diagram(m, [node("E:A", 100, 100), node("E:B", 400, 100), node("E:C", 250, 400)], [node("R:ABC", 250, 200, "relationship")]);
    expect(assessQuality(d, {}, m).diamondOffset).toBe(0);
    d.nodes.at(-1)!.box.x += 30;
    expect(assessQuality(d, {}, m).diamondOffset).toBeCloseTo(30 / ((300 + 2 * Math.hypot(150, 300)) / 3));
  });
  it("weights proximity by shared relationship count and normalizes inversions", () => {
    const m = normalize({ version: 1, entities: { A: {}, B: {}, C: {} }, relationships: {
      AB: { ends: [{ entity: "A", card: "0..N" }, { entity: "B", card: "0..N" }] },
      AB2: { ends: [{ entity: "A", card: "0..N" }, { entity: "B", card: "0..N" }] },
      AC: { ends: [{ entity: "A", card: "0..N" }, { entity: "C", card: "0..N" }] },
    } });
    const d = diagram(m, [node("E:A", 100, 100), node("E:B", 600, 100), node("E:C", 400, 100)], m.relationships.map((r, i) => node(r.id, 200 + i * 100, 300, "relationship")));
    const q = assessQuality(d, {}, m);
    expect(q.relatedDistance).toBeCloseTo((500 * 2 + 300) / 3 / 100);
    expect(q.proximityInversions).toBe(1);
  });
  it("uses the 12-degree limit on every segment and excludes attribute edges", () => {
    const m = model(), d = diagram(m);
    const length = 100, angle = 12 * Math.PI / 180;
    d.edges[0]!.points = [{ x: 0, y: 0 }, { x: length, y: length * Math.tan(angle) }];
    expect(assessQuality(d, {}, m).axisAligned).toBe(1);
    d.edges[0]!.points[1]!.y += 0.1;
    expect(assessQuality(d, {}, m).axisAligned).toBe(0.5);
    d.edges.push({ id: "attr", kind: "attribute", from: "E:A", to: "E:B", points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], double: false });
    expect(assessQuality(d, {}, m).axisAligned).toBe(0.5);
  });
  it("measures grid isolation and outward attribute fans", () => {
    const m = model(), d = diagram(m);
    expect(assessQuality(d, {}, m).gridMisalignment).toBe(0);
    d.nodes[0]!.box.x += 25;
    d.nodes[0]!.box.y += 25;
    expect(assessQuality(d, {}, m).gridMisalignment).toBe(0.25);
    d.nodes.push(node("A:A.Name", 50, 50, "attribute"));
    d.edges.push({ id: "attr", kind: "attribute", from: "E:A", to: "A:A.Name", points: [], double: false });
    expect(assessQuality(d, {}, m).attributeInwardRatio).toBe(0);
    d.nodes.at(-1)!.box = boxAround({ x: 300, y: 300 }, 100, 40);
    expect(assessQuality(d, {}, m).attributeInwardRatio).toBe(1);
  });
  it("keeps centrality invariant under translation and rewards a central hub", () => {
    const m = model(), d = diagram(m), q = assessQuality(d, {}, m);
    for (const n of d.nodes) { n.box.x -= 2000; n.box.y -= 2000; }
    expect(assessQuality(d, {}, m).centralityOffset).toBeCloseTo(q.centralityOffset);
    d.nodes[0]!.box = boxAround({ x: -1600, y: -1700 }, 100, 40);
    expect(assessQuality(d, {}, m).centralityOffset).toBeLessThan(q.centralityOffset);
  });
  it("recovers hierarchy from cardinality labels for diagram-only consumers", () => {
    const m = model(), d = diagram(m);
    d.labels = d.edges.map((e, i) => ({ id: `label:${i}`, edge: e.id, kind: "cardinality", text: i ? "(1,1)" : "(0,N)", box: { x: 800, y: i * 30, w: 30, h: 18 } }));
    d.nodes[0]!.box.y = 600;
    expect(assessQuality(d).hierarchyViolations).toBe(1);
    expect(assessQuality(d).diamondOffset).toBe(assessQuality(d, {}, m).diamondOffset);
  });
  it.each(["hierarchyViolations", "diamondOffset", "proximityInversions", "centralityOffset", "gridMisalignment", "attributeInwardRatio", "relatedDistance"] as const)("penalizes %s in the candidate score", (metric) => {
    const q = assessQuality({ width: 600, height: 600, nodes: [], edges: [], labels: [], notes: [], meta: { engine: "test" } });
    expect(layoutScore({ ...q, [metric]: 1 })).toBeGreaterThan(layoutScore(q));
    expect(layoutScore({ ...q, axisAligned: 0 })).toBeGreaterThan(layoutScore(q));
  });
});
