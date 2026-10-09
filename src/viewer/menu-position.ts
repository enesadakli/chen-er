export interface AnchorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MenuDimensions {
  w: number;
  h: number;
}

export interface ViewportDimensions {
  w: number;
  h: number;
}

export type MenuPlacement = "above" | "below";

export interface MenuPositionResult {
  x: number;
  y: number;
  placement: MenuPlacement;
  maxWidth: number;
  maxHeight: number;
}

export function placeMenu(
  anchor: { x: number; y: number; w: number; h: number },
  menu: { w: number; h: number },
  viewport: { w: number; h: number },
  gap = 8,
  padding = 8
): {
  x: number;
  y: number;
  placement: "above" | "below";
  maxWidth: number;
  maxHeight: number;
} {
  const safePadding = Math.max(0, padding);
  const safeGap = Math.max(0, gap);

  const maxWidth = Math.max(0, viewport.w - safePadding * 2);
  const maxHeight = Math.max(0, viewport.h - safePadding * 2);

  const effectiveW = Math.max(0, Math.min(menu.w, maxWidth));
  const effectiveH = Math.max(0, Math.min(menu.h, maxHeight));

  const rawX = anchor.x + (anchor.w - effectiveW) / 2;
  const maxX = Math.max(0, viewport.w - safePadding - effectiveW);
  const minX = Math.max(0, Math.min(safePadding, maxX));
  const x = Math.min(maxX, Math.max(minX, rawX));

  const fitsAbove = anchor.y - safeGap - safePadding >= effectiveH;
  const placement: "above" | "below" = fitsAbove ? "above" : "below";

  const rawY = placement === "above"
    ? anchor.y - safeGap - effectiveH
    : anchor.y + anchor.h + safeGap;

  const maxY = Math.max(0, viewport.h - safePadding - effectiveH);
  const minY = Math.max(0, Math.min(safePadding, maxY));
  const y = Math.min(maxY, Math.max(minY, rawY));

  return {
    x,
    y,
    placement,
    maxWidth,
    maxHeight,
  };
}
