/** Browser-safe public API of chen-er (no file system access). */
export * from "./schema.js";
export * from "./diagnostics.js";
export * from "./normalize.js";
export * from "./geometry.js";
export * from "./style.js";
export { interMetrics, type TextMetrics } from "./text/metrics.js";
export { renderSvg } from "./render/svg.js";
export { layout } from "./layout/index.js";
