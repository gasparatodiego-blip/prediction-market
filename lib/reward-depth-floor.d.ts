// Types for lib/reward-depth-floor.js (the .js module is the source of truth for the math).
export const DEFAULT_DEPTH_AT_TOUCH_FLOOR_USD: number;
export function depthFloorUsd(): number;
export function competitorDepthUsd(m: {
  venue?: string;
  bookDepthAtBand?: number | null;
  sides?: { no?: { bookDepthAtBand?: number | null } | null } | null;
} | null | undefined): number | null;
export function belowDepthFloor(depthUsd: number | null | undefined, floor?: number): boolean;
