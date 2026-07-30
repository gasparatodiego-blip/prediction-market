// Types for lib/reward-operator-estimate.js (the .js module is the source of truth for the math).
export const ASSUMED_ORDER_SIZE_USD: number;
export const ASSUMED_PLACEMENT_SCORE: number;
export const ASSUMED_PLACEMENT_LABEL: string;

export interface OperatorShareEstimate {
  estUsdPerDay: number | null;   // poolDay × refShare — the modelled per-operator $/day ("stima")
  share: number | null;          // refShare — the modelled pool share at the assumed order size
  assumedOrderSizeUsd: number;   // the refCapital the feed scored refShare at (fallback: ASSUMED_ORDER_SIZE_USD)
  unknown: boolean;              // true ⇒ caller renders "—" and keeps the pot visible (never 0)
  capitalCapUsd: number | null;  // measured in-band depth handed in, if any
  cappedCapitalUsd: number | null; // the capital the returned share is actually priced for
  capitalCapped: boolean;        // true ⇒ share/estUsdPerDay are the DEPTH-CAPPED figures
  capNote: string | null;        // plain-Italian statement of the cap, when it binds
}

export function estimatedOperatorSharePerDay(
  rewardScore:
    | { poolDay?: number | null; refShare?: number | null; refCapital?: number | null }
    | null
    | undefined,
  opts?: { inBandDepthUsd?: number | null },
): OperatorShareEstimate;

export interface CapitalPricedEstimate {
  estUsdPerDay: number | null;
  share: number | null;
  /** The capital the returned figures are priced for: the operator's, or the book's depth if smaller. */
  capitalUsd: number | null;
  depthLimited: boolean;
  unknown: boolean;
  reason: string | null;
}

/** The same estimate priced at a REAL capital instead of the $1,000 reference. A null/absent capital
 *  yields unknown — it is never silently replaced by the reference, which would overstate. Pure and
 *  browser-safe, so server and client compute one number. */
export function estimateAtCapital(
  rewardScore:
    | { poolDay?: number | null; refShare?: number | null; refCapital?: number | null }
    | null
    | undefined,
  capitalUsd: number | null,
  inBandDepthUsd: number | null,
): CapitalPricedEstimate;
