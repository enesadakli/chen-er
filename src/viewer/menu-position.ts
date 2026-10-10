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

export interface MenuObstacle extends AnchorRect {
  weight: number;
}

export type MenuPlacement = "above" | "below" | "left" | "right";

export interface MenuPositionResult {
  x: number;
  y: number;
  placement: MenuPlacement;
  maxWidth: number;
  maxHeight: number;
}

export function placeMenu(
  anchor: AnchorRect,
  menu: MenuDimensions,
  viewport: ViewportDimensions,
  gap = 8,
  padding = 8,
  obstacles: readonly MenuObstacle[] = []
): MenuPositionResult {
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

  const legacy = { x, y, placement, maxWidth, maxHeight };
  if (!obstacles.length) return legacy;

  const candidates: MenuPositionResult[] = [];
  const add = (rawX: number, rawY: number, placement: MenuPlacement) => candidates.push({
    x: Math.min(maxX, Math.max(minX, rawX)),
    y: Math.min(maxY, Math.max(minY, rawY)),
    placement, maxWidth, maxHeight,
  });
  const xs = [rawX, anchor.x, anchor.x + anchor.w - effectiveW];
  const vertical = (extra: number) => {
    for (const side of ["above", "below"] as const) {
      for (const cx of xs) add(cx, side === "above"
        ? anchor.y - safeGap - extra - effectiveH
        : anchor.y + anchor.h + safeGap + extra, side);
    }
  };
  vertical(0);
  const cy = anchor.y + (anchor.h - effectiveH) / 2;
  add(anchor.x + anchor.w + safeGap, cy, "right");
  add(anchor.x - safeGap - effectiveW, cy, "left");
  for (let extra = 12; extra <= 48; extra += 12) vertical(extra);

  const overlap = (candidate: MenuPositionResult, rect: AnchorRect) =>
    Math.max(0, Math.min(candidate.x + effectiveW, rect.x + rect.w) - Math.max(candidate.x, rect.x)) *
    Math.max(0, Math.min(candidate.y + effectiveH, rect.y + rect.h) - Math.max(candidate.y, rect.y));
  // A finite penalty alone cannot guarantee anchor avoidance for arbitrarily dense drawings.
  const clear = candidates.filter((candidate) => overlap(candidate, anchor) === 0);
  const eligible = clear.length ? clear : candidates;
  const score = (candidate: MenuPositionResult) =>
    obstacles.reduce((sum, rect) => sum + overlap(candidate, rect) * rect.weight, 0) +
    overlap(candidate, anchor) * 1_000_000 + .01 * Math.hypot(
      Math.max(0, anchor.x - candidate.x - effectiveW, candidate.x - anchor.x - anchor.w),
      Math.max(0, anchor.y - candidate.y - effectiveH, candidate.y - anchor.y - anchor.h));
  let best = eligible[0]!;
  let bestScore = score(best);
  for (const candidate of eligible.slice(1)) {
    const candidateScore = score(candidate);
    if (candidateScore < bestScore) { best = candidate; bestScore = candidateScore; }
  }
  return best;
}
