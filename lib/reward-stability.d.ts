// Types for lib/reward-stability.js — provisional band-relative stability (structure-only).

export interface Stability {
  known: boolean;
  score: number | null;          // 0..100, higher = more stable; null when unmeasured
  stdev: number | null;          // the real 24h price-fraction stdev it was derived from
  consumedBandPct: number | null;
}

export function computeStability(args: {
  volatilityStdev?: number | null;
  maxSpreadCents?: number | null;
}): Stability;

export function stabilityOf(m: unknown): Stability;
