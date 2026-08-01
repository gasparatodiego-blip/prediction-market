// Types for lib/reward-operator-estimate.js (the .js module is the source of truth for the math).
export const ASSUMED_ORDER_SIZE_USD: number;
export const ASSUMED_PLACEMENT_SCORE: number;
export const ASSUMED_PLACEMENT_LABEL: string;

/** Shared by both estimates: the venue's min_incentive_size verdict at the capital actually priced. */
export interface MinSizeFields {
  /** true ⇒ the capital does not buy a qualifying order; estUsdPerDay is 0 BY THE VENUE'S RULE. */
  belowVenueMinSize: boolean;
  minSizeShares: number | null;
  /** Total capital for a qualifying order on BOTH sides: 2 × clamp(mid) × minSize. */
  capitalToQualifyUsd: number | null;
  /** false ⇒ mid or minSize unreadable, so the threshold could not be judged. The estimate passes
   *  through unchanged (as the allocator does), and the caller should say the check did not run. */
  minSizeJudgeable: boolean;
}

export interface MinSizeVerdict {
  qualifies: boolean | null;
  sizePerSideShares: number | null;
  minSizeShares: number | null;
  capitalToQualifyUsd: number | null;
  reason: string | null;
}

/** 2 × clamp(mid) × minSize. Same formula as scripts/rewards-ceiling/lib/curve.capitalToQualify —
 *  restated here because this module must stay browser-safe; the test guards them against drift. */
export function capitalToQualifyUsd(mid: number | null, minSize: number | null): number | null;
export function minSizeVerdict(args: {
  capitalUsd?: number | null; mid?: number | null; minSize?: number | null;
}): MinSizeVerdict;

export interface OperatorShareEstimate extends MinSizeFields {
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
    | { poolDay?: number | null; refShare?: number | null; refCapital?: number | null; mid?: number | null; minSize?: number | null }
    | null
    | undefined,
  opts?: { inBandDepthUsd?: number | null },
): OperatorShareEstimate;

export interface CapitalPricedEstimate extends MinSizeFields {
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
    | { poolDay?: number | null; refShare?: number | null; refCapital?: number | null; mid?: number | null; minSize?: number | null }
    | null
    | undefined,
  capitalUsd: number | null,
  inBandDepthUsd: number | null,
): CapitalPricedEstimate;
