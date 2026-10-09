import type { LayoutEngine, LayoutOptions, LayoutResult } from "../geometry.js";
import type { NModel } from "../normalize.js";
import { interMetrics, type TextMetrics } from "../text/metrics.js";
import { simpleLayout } from "./simple.js";

/** Registered engines. "layered" and "stress" are added by the layout lane and fall back to "simple" until then. */
export const engines: Partial<Record<NonNullable<LayoutOptions["engine"]>, LayoutEngine>> = {
  simple: simpleLayout,
};

export const DEFAULT_ENGINE: NonNullable<LayoutOptions["engine"]> = "simple";

export async function layout(model: NModel, options: LayoutOptions = {}, metrics: TextMetrics = interMetrics): Promise<LayoutResult> {
  const name = options.engine ?? DEFAULT_ENGINE;
  const engine = engines[name] ?? simpleLayout;
  const result = await engine(model, metrics, options);
  if (!engines[name]) {
    result.diagnostics.push({
      rule: "layout-engine-unavailable",
      severity: "info",
      message: `Layout engine "${name}" is not available; used "simple".`,
    });
  }
  return result;
}
