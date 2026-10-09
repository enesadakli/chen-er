import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { center } from "../src/core/geometry.js";
import { DEFAULT_ENGINE, engines, layout } from "../src/core/layout/index.js";
import { parseModel, type NModel } from "../src/core/normalize.js";
import { assessQuality } from "../src/core/quality.js";
import { renderSvg } from "../src/core/render/svg.js";
import { svgToPng } from "../src/app/render.js";
import { LayoutFile } from "../src/core/schema.js";

const discovered = ["bench/fixtures", "examples", "examples/private"].flatMap((dir) =>
  existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".er.yaml")).sort().map((file) => join(dir, file)) : [],
);
const inputs = [...new Map([...discovered, ...process.argv.slice(2)].map((file) => [resolve(file), file])).values()];
const rows: Record<string, string | number>[] = [];
let failed = false;
for (const input of inputs) {
  const parsed = parseModel(readFileSync(input, "utf8"));
  if (!parsed.model) throw new Error(`${input}: ${JSON.stringify(parsed.diagnostics)}`);
  const model = parsed.model;
  const pinFile = input.replace(/\.er\.yaml$/, ".er.layout.json");
  const pins = resolve(input) === resolve("bench/fixtures/pinned.er.yaml") && existsSync(pinFile) ? LayoutFile.parse(JSON.parse(readFileSync(pinFile, "utf8"))).pins : {};
  for (const engine of Object.keys(engines) as (keyof typeof engines)[]) {
    const start = performance.now();
    const { diagram } = await layout(model, { engine, pins });
    const elapsed = performance.now() - start;
    const q = assessQuality(diagram, pins, model);
    const modified: NModel = { ...model, entities: model.entities.map((e, i) => i ? e : { ...e, attrs: [...e.attrs, {
      id: `A:${e.name}.__bench_extra`, name: "__bench_extra", label: "Extra", owner: e.name, ownerKind: "entity", parts: [], multivalued: false, derived: false, key: false, partial: false, path: "bench.extra",
    }] }) };
    const next = (await layout(modified, { engine, pins })).diagram;
    const displacement = diagram.nodes.filter((n) => n.kind === "entity").map((n) => {
      const c = center(n.box), other = center(next.nodes.find((m) => m.id === n.id)!.box);
      return Math.hypot(c.x - other.x, c.y - other.y);
    });
    const stability = displacement.reduce((sum, n) => sum + n, 0) / (displacement.length || 1);
    const directory = join("out/bench", engine);
    mkdirSync(directory, { recursive: true });
    const base = basename(input, ".er.yaml");
    const duplicate = inputs.filter((file) => basename(file, ".er.yaml") === base).length > 1;
    const name = duplicate ? input.replace(/\.er\.yaml$/, "").replaceAll("/", "__") : base;
    const svg = renderSvg(diagram);
    writeFileSync(join(directory, `${name}.svg`), svg);
    if (engine === DEFAULT_ENGINE && (base === "university-curriculum" || base === "library")) writeFileSync(join("out", `${base}.png`), svgToPng(svg, 1));
    rows.push({ input: isAbsolute(input) ? base : input.replace(/\.er\.yaml$/, ""), engine, overlaps: q.overlaps, shapeCrossings: q.shapeCrossings, labelCollisions: q.labelCollisions, labelAmbiguity: q.labelAmbiguity, edgeCrossings: q.edgeCrossings, pinDrift: q.pinDrift, "width×height": `${diagram.width}×${diagram.height}`,
      hierarchyViolations: q.hierarchyViolations, diamondOffset: Number(q.diamondOffset.toFixed(3)), relatedDistance: Number(q.relatedDistance.toFixed(3)), proximityInversions: Number(q.proximityInversions.toFixed(3)), axisAligned: Number(q.axisAligned.toFixed(3)), centralityOffset: Number(q.centralityOffset.toFixed(3)), gridMisalignment: Number(q.gridMisalignment.toFixed(3)), attributeInwardRatio: Number(q.attributeInwardRatio.toFixed(3)),
      aspect: Number(q.aspect.toFixed(3)), edgeLength: Number(q.edgeLength.toFixed(1)), meanEdgeLength: Number(q.meanEdgeLength.toFixed(1)), meanEdgeRatio: Number(q.meanEdgeRatio.toFixed(3)), longestEdgeRatio: Number(q.longestEdgeRatio.toFixed(3)), density: Number(q.density.toFixed(4)),
      ms: Number(elapsed.toFixed(1)), "stability(px)": Number(stability.toFixed(1)) });
    if (engine === DEFAULT_ENGINE && (q.hierarchyViolations || q.diamondOffset > 0.2)) failed = true;
    if (engine === DEFAULT_ENGINE && (q.overlaps || q.shapeCrossings || q.labelCollisions || q.labelAmbiguity || q.pinDrift)) failed = true;
    if (engine === DEFAULT_ENGINE && (input.startsWith("bench/fixtures/") || input.endsWith("/library.er.yaml")) && (q.aspect < 0.5 || q.aspect > 2 || q.meanEdgeRatio > 3.5)) failed = true;
    if (engine === DEFAULT_ENGINE && input.endsWith("/university-curriculum.er.yaml") && (q.aspect < 0.6 || q.aspect > 1.8 || q.meanEdgeRatio > 3.5 || q.longestEdgeRatio > 7 || Math.max(diagram.width, diagram.height) > 2800 || q.edgeCrossings > 4 || q.diamondOffset > 0.15 || q.axisAligned < 0.6)) failed = true;
  }
}
console.table(rows);
mkdirSync("out/bench", { recursive: true });
writeFileSync("out/bench/quality.json", JSON.stringify(rows, null, 2) + "\n");
if (!inputs.some((input) => input.endsWith("/university-curriculum.er.yaml"))) console.log("Private university-curriculum input is absent; its acceptance result is unverified.");
process.exitCode = failed ? 1 : 0;
