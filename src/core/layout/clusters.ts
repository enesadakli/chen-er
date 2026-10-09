import ELK, { type ELK as ElkInstance } from "elkjs/lib/elk.bundled.js";
import { boxAround, center, intersects, type Box, type DNode, type LayoutOptions, type Point } from "../geometry.js";
import { flattenAttrs, type NAttribute, type NModel } from "../normalize.js";
import { attributeSize, entitySize, relationshipSize, style } from "../style.js";
import type { TextMetrics } from "../text/metrics.js";

// elkjs exposes a CommonJS constructor while NodeNext sees a module namespace.
const ElkConstructor = ELK as unknown as new () => ElkInstance;
export interface Cluster { node: DNode; attrs: NAttribute[]; radius: number }
const attrDepth = (attrs: NAttribute[]): number => attrs.length ? 1 + Math.max(...attrs.map((a) => attrDepth(a.parts))) : 0;

export function measureClusters(model: NModel, metrics: TextMetrics, pins: Record<string, Point>): Cluster[] {
  return [
    ...model.entities.map((e) => ({ spec: e, kind: "entity" as const, size: entitySize(e.label, metrics), double: e.weak })),
    ...model.relationships.map((r) => ({ spec: r, kind: "relationship" as const, size: relationshipSize(r.label, metrics), double: !!r.identifies })),
  ].map(({ spec, kind, size, double }) => ({
    node: { id: spec.id, kind, label: spec.label, box: boxAround(pins[spec.id] ?? { x: 0, y: 0 }, size.w, size.h), double, pinned: !!pins[spec.id] },
    attrs: spec.attrs,
    radius: Math.max(size.w / 2 + 80, ...flattenAttrs(spec.attrs).map((a) => attributeSize(a.label, metrics).w / 2 + 80), spec.attrs.reduce((sum, a) => sum + attributeSize(a.label, metrics).w + 45, 0) / 4) + attrDepth(spec.attrs) * 95,
  }));
}

export async function placeClusters(clusters: Cluster[], model: NModel, options: LayoutOptions, name: NonNullable<LayoutOptions["engine"]>, reserved: Box[]): Promise<void> {
  const maxDiameter = Math.max(240, ...clusters.map((c) => c.radius * 2));
  if (name !== "simple" && clusters.length) {
    const elk = new ElkConstructor();
    const graph = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": name,
        "elk.direction": "RIGHT",
        "elk.randomSeed": String(options.seed ?? 1),
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.spacing.nodeNode": String(Math.max(100, maxDiameter / 6)),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(Math.max(140, maxDiameter / 5)),
        "elk.stress.desiredEdgeLength": String(maxDiameter + 180),
        "elk.stress.iterationLimit": "150",
      },
      children: clusters.map(({ node, radius }) => ({
        id: node.id, width: radius * 2, height: radius * 2,
        x: center(node.box).x - radius, y: center(node.box).y - radius,
        layoutOptions: { "org.eclipse.elk.stress.fixed": String(!!node.pinned) },
      })),
      edges: model.relationships.flatMap((r) => r.ends.filter((e) => clusters.some((c) => c.node.id === `E:${e.entity}`)).map((e) => ({
        id: e.id, sources: [e.index === 0 ? `E:${e.entity}` : r.id], targets: [e.index === 0 ? r.id : `E:${e.entity}`],
      }))),
    });
    for (const c of clusters) {
      const placed = graph.children?.find((n) => n.id === c.node.id);
      if (placed && !c.node.pinned) c.node.box = boxAround({ x: (placed.x ?? 0) + c.radius, y: (placed.y ?? 0) + c.radius }, c.node.box.w, c.node.box.h);
    }
  } else {
    const cols = Math.max(1, Math.ceil(Math.sqrt(clusters.length)));
    clusters.forEach((c, i) => {
      if (!c.node.pinned) c.node.box = boxAround({ x: i % cols * (maxDiameter + 160) + c.radius, y: Math.floor(i / cols) * (maxDiameter + 160) + c.radius }, c.node.box.w, c.node.box.h);
    });
  }
  packClusters(clusters, !!model.title, reserved);
}

function packClusters(clusters: Cluster[], title: boolean, reserved: Box[]) {
  const placed = clusters.filter((c) => c.node.pinned);
  const top = style.margin + (title ? style.title.band : 0);
  for (const c of clusters.filter((c) => !c.node.pinned)) {
    const origin = center(c.node.box);
    const start = { x: Math.max(origin.x, c.radius + style.margin), y: Math.max(origin.y, c.radius + top) };
    let point: Point | undefined;
    search: for (let ring = 0; ring < 60; ring++) {
      const candidates = ring === 0 ? [start] : Array.from({ length: ring * 8 }, (_, i) => ({ x: start.x + Math.cos(i * Math.PI / (ring * 4)) * ring * 120, y: start.y + Math.sin(i * Math.PI / (ring * 4)) * ring * 120 }));
      for (const p of candidates) {
        if (p.x - c.radius < style.margin || p.y - c.radius < top) continue;
        if (reserved.some((b) => intersects(boxAround(p, c.node.box.w, c.node.box.h), b, 14))) continue;
        if (placed.some((o) => intersects(boxAround(p, c.radius * 2, c.radius * 2), boxAround(center(o.node.box), o.radius * 2, o.radius * 2), 70))) continue;
        point = p;
        break search;
      }
    }
    if (!point) point = { x: Math.max(start.x, ...placed.map((o) => center(o.node.box).x + o.radius + c.radius + 80), ...reserved.map((b) => b.x + b.w + c.radius + 80)), y: start.y };
    c.node.box = boxAround(point, c.node.box.w, c.node.box.h);
    placed.push(c);
  }
}
