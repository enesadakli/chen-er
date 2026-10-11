import type { ViewerState } from "../app/serve.js";

export const AUTO_RELAYOUT_MESSAGE = "Re-laid out after model change";
export function layoutStatus(state: Pick<ViewerState, "computing" | "autoRelayout" | "updatedAt" | "history">, connected: boolean): string {
  if (state.computing) return "Computing layout…";
  if (!connected) return "disconnected";
  if (state.autoRelayout) return AUTO_RELAYOUT_MESSAGE;
  return `updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour12: false })}`;
}
