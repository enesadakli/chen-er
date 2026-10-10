import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { center, type Diagram } from "../src/core/geometry.js";
import { hierarchyDag, hierarchyPairs, modelRelations } from "../src/core/layout/semantic-graph.js";
import { DEFAULT_ENGINE, engines, layout } from "../src/core/layout/index.js";
import { parseModel, type NModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { renderSvg } from "../src/core/render/svg.js";
import { svgToPng } from "../src/app/render.js";
import { LayoutFile } from "../src/core/schema.js";

export type RegressionMetric = "zRoutes" | "edgeCrossings" | "endBendsMax" | "routeDetourMax" | "attributeSpokeMax" | "emptyAreaRatio";
// Preserve the best existing route guards and bound empty area by the pre-compaction render.
// Public examples are read directly; the two ternary inputs have separate baselines.
export const regressionBaseline: Record<string, Record<RegressionMetric, number>> = {
  "examples/ternary": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 0, routeDetourMax: 1.1423611111111112, attributeSpokeMax: 1.0588235294117647, emptyAreaRatio: 0.9407170277233993 },
  "company-project": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 0, routeDetourMax: 1.1829629629629628, attributeSpokeMax: 1.0735294117647058, emptyAreaRatio: 0.9528637261622064 },
  "dense-attrs": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 0, routeDetourMax: 1, attributeSpokeMax: 10.168208659840005, emptyAreaRatio: 0.9262881531759711 },
  "hub-company": { zRoutes: 5, edgeCrossings: 0, endBendsMax: 2, routeDetourMax: 1.2857142857142858, attributeSpokeMax: 2.47972935709149, emptyAreaRatio: 0.9053139114525204 },
  // The full pinned canvas includes negative geometry; its area is 1364 × 792.
  "pinned": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 1, routeDetourMax: 1.0360721442885772, attributeSpokeMax: 3.3823529411764706, emptyAreaRatio: 0.957303324218917 },
  "recursive": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 2, routeDetourMax: 1.1562962962962962, attributeSpokeMax: 1.0588235294117647, emptyAreaRatio: 0.8690333701650775 },
  "ternary": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 2, routeDetourMax: 1.1615798922800717, attributeSpokeMax: 1.0654701843573313, emptyAreaRatio: 0.9313489034397789 },
  "turkish-labels": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 0, routeDetourMax: 1, attributeSpokeMax: 1.0588235294117647, emptyAreaRatio: 0.8434353146897209 },
  "library": { zRoutes: 0, edgeCrossings: 0, endBendsMax: 0, routeDetourMax: 1, attributeSpokeMax: 1.0775077508069106, emptyAreaRatio: 0.9271289508500763 },
  // Measured on the default engine; campus is the public stand-in for the private university model.
  // Compact ranks and spacing (0.3): canvas 1700x2162 -> 1669x1588, end-edge length 9821 -> 5148 px,
  // longEdgeMax 6.80 -> 3.40, crossings 1 -> 0. Accepted trade-off within the general limits (1.6, 2.5):
  // routeDetourMax 1.1653 -> 1.3129 and attributeSpokeMax 1.0735 -> 1.5882.
  "campus": { zRoutes: 1, edgeCrossings: 0, endBendsMax: 2, routeDetourMax: 1.312937062937063, attributeSpokeMax: 1.588235294117647, emptyAreaRatio: 0.9206378769430194 },
  "university-curriculum": { zRoutes: 6, edgeCrossings: 1, endBendsMax: 2, routeDetourMax: 1.336048879837067, attributeSpokeMax: 3.395548640169282, emptyAreaRatio: 0.923729974724041 },
};

export type Quality = ReturnType<typeof assessQuality>;
type EngineName = keyof typeof engines;

// The quality metric caps each cyclic component at one unavoidable violation.
export const hierarchyMinimumOf = (model: NModel): number =>
  new Set(hierarchyDag(model.entities.map((e) => e.id), hierarchyPairs(modelRelations(model))).cyclic.values()).size;

export function loadPins(input: string): Record<string, { x: number; y: number }> {
  const pinFile = input.replace(/\.er\.yaml$/, ".er.layout.json");
  return resolve(input) === resolve("bench/fixtures/pinned.er.yaml") && existsSync(pinFile) ? LayoutFile.parse(JSON.parse(readFileSync(pinFile, "utf8"))).pins : {};
}

/** Entity displacement when one extra attribute is added to each entity in turn. */
export async function stabilityOf(model: NModel, diagram: Diagram, engine: EngineName, pins: Record<string, { x: number; y: number }>): Promise<{ max: number; median: number }> {
  const displacement: number[] = [];
  for (const entity of model.entities) {
    const modified: NModel = { ...model, entities: model.entities.map((e) => e !== entity ? e : { ...e, attrs: [...e.attrs, {
      id: `A:${e.name}.Extra`, name: "Extra", label: "Extra", owner: e.name, ownerKind: "entity", parts: [], multivalued: false, derived: false, key: false, partial: false, path: "bench.extra",
    }] }) };
    const next = (await layout(modified, { engine, pins })).diagram;
    displacement.push(...diagram.nodes.filter((n) => n.kind === "entity").map((n) => {
      const c = center(n.box), other = center(next.nodes.find((m) => m.id === n.id)!.box);
      return Math.hypot(c.x - other.x, c.y - other.y);
    }));
  }
  displacement.sort((a, b) => a - b);
  const median = displacement.length ? (displacement[Math.floor(displacement.length / 2)]! + displacement[Math.floor((displacement.length - 1) / 2)]!) / 2 : 0;
  return { max: Math.max(0, ...displacement), median };
}

export interface GuardSubject {
  input: string;
  diagram: Diagram;
  q: Quality;
  hierarchyMinimum: number;
  elapsed: number;
  stabilityMax: number;
  stabilityMedian: number;
}

/** Per-fixture regression guards of the default engine; an empty list means the fixture passes. */
export function guardFailures({ input, diagram, q, hierarchyMinimum, elapsed, stabilityMax, stabilityMedian }: GuardSubject): string[] {
  const failures: string[] = [];
  const base = basename(input, ".er.yaml");
  const baseline = regressionBaseline[base === "ternary" && resolve(input) === resolve("examples/ternary.er.yaml") ? "examples/ternary" : base];
  if (!baseline) failures.push("missing regression baseline");
  else for (const key of Object.keys(baseline) as RegressionMetric[]) if (q[key] > baseline[key] + 1e-6) failures.push(`${key} regressed: ${q[key]} > ${baseline[key]}`);
  if (resolve(input) === resolve("examples/company-project.er.yaml")
    && (diagram.width * diagram.height > 1633632 * 0.7 || q.plainSegmentRatio > 2 || q.endBendsMax > 1 || q.edgeCrossings)) failures.push("company-project compactness guard");
  if (stabilityMax > 60 || stabilityMedian > 20) failures.push(`stability: max ${stabilityMax.toFixed(1)}, median ${stabilityMedian.toFixed(1)}`);
  if (q.hierarchyViolations > hierarchyMinimum || q.diamondOffset > 0.2) failures.push(`hierarchy or diamond offset: ${q.hierarchyViolations} > ${hierarchyMinimum}, ${q.diamondOffset}`);
  if (q.spokeEdgeViolations || q.spokeLabelViolations) failures.push(`attribute clearance: spoke/edge ${q.spokeEdgeClearance.toFixed(1)}px, oval/label ${q.spokeLabelClearance.toFixed(1)}px`);
  const hard = { diagonalEnds: q.diagonalEnds, overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, labelAmbiguity: q.labelAmbiguity, labelLoose: q.labelLoose, labelOnOwnEdge: q.labelOnOwnEdge, pinDrift: q.pinDrift, attributeEdgeBends: q.attributeEdgeBends, edgeOverlap: q.edgeOverlap, tinySegments: q.tinySegments, endPortCrowding: q.endPortCrowding, diamondVertexViolations: q.diamondVertexViolations, doubleEdgeArtifacts: q.doubleEdgeArtifacts };
  for (const [name, value] of Object.entries(hard)) if (value) failures.push(`${name}: ${value}`);
  if ((input.startsWith("bench/fixtures/") || input.endsWith("/library.er.yaml")) && (q.aspect < 0.5 || q.aspect > 2 || q.meanEdgeRatio > 3.5)) failures.push(`shape: aspect ${q.aspect}, meanEdgeRatio ${q.meanEdgeRatio}`);
  if (input.endsWith("/university-curriculum.er.yaml") && (q.aspect < 0.6 || q.aspect > 1.8 || q.meanEdgeRatio > 3.5 || q.longestEdgeRatio > 7 || Math.max(diagram.width, diagram.height) > 2800 || q.edgeCrossings > 2 || q.diamondOffset > 0.15 || q.axisAligned < 0.6 || q.routeDetourMax > 1.6 || q.routeDetourMean > 1.2 || q.endBendsMax > 2 || elapsed >= 2000)) failures.push("university acceptance");
  return failures;
}

/** Fixtures the guards apply to: bench fixtures and public examples, plus the private model when present. */
export const guardInputs = (): string[] => ["bench/fixtures", "examples", "examples/private"].flatMap((dir) =>
  existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".er.yaml")).sort().map((file) => join(dir, file)) : [],
);

async function main(): Promise<void> {
  const inputs = [...new Map([...guardInputs(), ...process.argv.slice(2)].map((file) => [resolve(file), file])).values()];
  const rows: Record<string, string | number>[] = [];
  let failed = false;
  for (const input of inputs) {
    const parsed = parseModel(readFileSync(input, "utf8"));
    if (!parsed.model) throw new Error(`${input}: ${JSON.stringify(parsed.diagnostics)}`);
    const model = parsed.model;
    const hierarchyMinimum = hierarchyMinimumOf(model);
    const pins = loadPins(input);
    for (const engine of Object.keys(engines) as EngineName[]) {
      const start = performance.now();
      const { diagram } = await layout(model, { engine, pins });
      const elapsed = performance.now() - start;
      const q = assessQuality(diagram, pins, model);
      const stability = await stabilityOf(model, diagram, engine, pins);
      const stabilityMax = stability.max, stabilityMedian = stability.median;
      const directory = join("out/bench", engine);
      mkdirSync(directory, { recursive: true });
      const base = basename(input, ".er.yaml");
      const duplicate = inputs.filter((file) => basename(file, ".er.yaml") === base).length > 1;
      const name = duplicate ? input.replace(/\.er\.yaml$/, "").replaceAll("/", "__") : base;
      const svg = renderSvg(diagram);
      writeFileSync(join(directory, `${name}.svg`), svg);
      if (engine === DEFAULT_ENGINE && (base === "university-curriculum" || base === "hub-company" || base === "library")) writeFileSync(join("out", `${base}.png`), svgToPng(svg, 1));
      rows.push({ input: isAbsolute(input) ? base : input.replace(/\.er\.yaml$/, ""), engine, diagonalEnds: q.diagonalEnds, zRoutes: q.zRoutes, overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, labelAmbiguity: q.labelAmbiguity, labelLoose: q.labelLoose, labelOnOwnEdge: q.labelOnOwnEdge, edgeCrossings: q.edgeCrossings, pinDrift: q.pinDrift, "width×height": `${diagram.width}×${diagram.height}`,
        hierarchyViolations: q.hierarchyViolations, hierarchyMinimum, attributeEdgeBends: q.attributeEdgeBends, edgeOverlap: q.edgeOverlap, tinySegments: q.tinySegments, endPortCrowding: q.endPortCrowding, diamondVertexViolations: q.diamondVertexViolations, doubleEdgeArtifacts: q.doubleEdgeArtifacts, diamondOffset: Number(q.diamondOffset.toFixed(3)), relatedDistance: Number(q.relatedDistance.toFixed(3)), proximityInversions: Number(q.proximityInversions.toFixed(3)), axisAligned: Number(q.axisAligned.toFixed(3)), centralityOffset: Number(q.centralityOffset.toFixed(3)), gridMisalignment: Number(q.gridMisalignment.toFixed(3)), attributeInwardRatio: Number(q.attributeInwardRatio.toFixed(3)),
        aspect: Number(q.aspect.toFixed(3)), edgeLength: Number(q.edgeLength.toFixed(1)), meanEdgeLength: Number(q.meanEdgeLength.toFixed(1)), meanEdgeRatio: Number(q.meanEdgeRatio.toFixed(3)), longestEdgeRatio: Number(q.longestEdgeRatio.toFixed(3)), longEdgeMax: Number(q.longEdgeMax.toFixed(3)), longEdgeMean: Number(q.longEdgeMean.toFixed(3)), spokeEdgeClearance: Number.isFinite(q.spokeEdgeClearance) ? Number(q.spokeEdgeClearance.toFixed(1)) : "-", spokeLabelClearance: Number.isFinite(q.spokeLabelClearance) ? Number(q.spokeLabelClearance.toFixed(1)) : "-", density: Number(q.density.toFixed(4)),
        emptyAreaRatio: Number(q.emptyAreaRatio.toFixed(4)), plainSegmentRatio: Number(q.plainSegmentRatio.toFixed(3)), attributeSpokeMax: Number(q.attributeSpokeMax.toFixed(3)), routeDetourMax: Number(q.routeDetourMax.toFixed(3)), routeDetourMean: Number(q.routeDetourMean.toFixed(3)), endBendsMax: q.endBendsMax, endBendsMean: Number(q.endBendsMean.toFixed(3)),
        ms: Number(elapsed.toFixed(1)), stabilityMax: Number(stabilityMax.toFixed(1)), stabilityMedian: Number(stabilityMedian.toFixed(1)) });
      if (engine === DEFAULT_ENGINE) {
        for (const message of guardFailures({ input, diagram, q, hierarchyMinimum, elapsed, stabilityMax, stabilityMedian })) {
          console.error(`${input}: ${message}`);
          failed = true;
        }
      }
    }
  }
  console.table(rows);
  mkdirSync("out/bench", { recursive: true });
  writeFileSync("out/bench/quality.json", JSON.stringify(rows, null, 2) + "\n");
  if (!inputs.some((input) => input.endsWith("/university-curriculum.er.yaml"))) console.log("Private university-curriculum input is absent; its acceptance result is unverified.");
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
