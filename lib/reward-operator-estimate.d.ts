// Types for lib/reward-operator-estimate.js (the .js module is the source of truth for the math).
export const ASSUMED_ORDER_SIZE_USD: number;
export const ASSUMED_PLACEMENT_SCORE: number;
export const ASSUMED_PLACEMENT_LABEL: string;

export interface OperatorShareEstimate {
  estUsdPerDay: number | null;   // poolDay × refShare — the modelled per-operator $/day ("stima")
  share: number | null;          // refShare — the modelled pool share at the assumed order size
  assumedOrderSizeUsd: number;   // the refCapital the feed scored refShare at (fallback: ASSUMED_ORDER_SIZE_USD)
  unknown: boolean;              // true ⇒ caller renders "—" and keeps the pot visible (never 0)
}

export function estimatedOperatorSharePerDay(
  rewardScore:
    | { poolDay?: number | null; refShare?: number | null; refCapital?: number | null }
    | null
    | undefined,
): OperatorShareEstimate;
