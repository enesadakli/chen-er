import type { LayoutEngine, LayoutOptions, LayoutResult } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { interMetrics, type TextMetrics } from "../text/metrics.js";
import { incrementalLayout } from "./incremental.js";
import { makeEngine } from "./pipeline.js";
import { simpleLayout } from "./simple.js";

export const engines: Record<NonNullable<LayoutOptions["engine"]>, LayoutEngine> = {
  simple: simpleLayout,
  layered: makeEngine("layered"),
  stress: makeEngine("stress"),
};

// Layered evaluates compact layered and stress candidates with hard clearance checks.
export const DEFAULT_ENGINE: NonNullable<LayoutOptions["engine"]> = "layered";

export async function layout(model: NModel, options: LayoutOptions = {}, metrics: TextMetrics = interMetrics): Promise<LayoutResult> {
  const engine = engines[options.engine ?? DEFAULT_ENGINE];
  if (options.positions && Object.keys(options.positions).length) return incrementalLayout(engine, model, metrics, options);
  return engine(model, metrics, options);
}
