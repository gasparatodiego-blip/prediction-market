// Types for lib/reward-stability.js — measured, band-relative price stability.
// score is null exactly when `known` is false; `reason` then carries WHY it is unmeasured.

export type StabilityReason =
  | 'no-band'         // the market carries no reward band width
  | 'no-history'      // no usable price series for the window
  | 'thin-sample'     // fewer observations than MIN_SAMPLES — dispersion would be meaningless
  | 'no-trade-data'   // Gamma omits volume24hr for this market (ABSENT, not zero)
  | 'no-pool'         // no daily reward pool to size trade flow against
  | 'no-flow'         // traded less in 24h than it pays makers per day → not priced by flow
  | 'no-book';        // in-band depth missing or below the shared depth floor

export type StabilityLabel = 'fermo' | 'medio' | 'si muove';

export interface Stability {
  known: boolean;
  score: number | null;            // 0..100, higher = stiller; null when unmeasured
  label: StabilityLabel | null;
  reason: StabilityReason | null;
  stdev: number | null;            // measured price-fraction stdev over the window
  movedCents: number | null;       // one stdev in cents — the plain-language driver
  consumedBandPct: number | null;  // % of the band half-width one stdev consumes
  nPts: number | null;
  nDistinct: number | null;
  windowHours: number | null;
  volume24hUsd: number | null;
  bookDepthUsd: number | null;
}

export function computeStability(args: {
  stdev?: number | null;
  nPts?: number | null;
  nDistinct?: number | null;
  windowHours?: number | null;
  maxSpreadCents?: number | null;
  volume24hUsd?: number | null;
  dailyPoolUsd?: number | null;
  bookDepthUsd?: number | null;
}): Stability;

export function stabilityOf(m: unknown): Stability;

export const MIN_SAMPLES: number;
export const LABEL_STILL_MIN: number;
export const LABEL_MEDIUM_MIN: number;
export function flowMultiple(): number;
