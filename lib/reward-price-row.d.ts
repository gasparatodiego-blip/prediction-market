// Types for lib/reward-price-row.js — the price-first row computations (Part A).

export interface RewardScoreLike {
  poolDay?: number | null;
  mid?: number | null;
  maxSpreadCents?: number | null;
  minSize?: number | null;
  competitorQ?: number | null;
  refCapital?: number | null;
  refShare?: number | null;
}

export interface PriceRow {
  scoringMid: number | null;
  maxSpreadCents: number | null;
  minSize: number | null;
  competitorQ: number | null;
  poolDay: number | null;
  tick: number | null;
  bandRadiusC: number | null;
  railRadiusC: number | null;
  bandLo: number | null;
  bandHi: number | null;
  offsetCents: number | null;
  buyYes: number | null;
  sellYes: number | null;
  buyNo: number | null;
  sellYesForNoIdentity: number | null;
  /** Pre-snap targets (mid ∓ offset) — kept so the tick snap is visible, never silent. */
  buyYesRaw: number | null;
  sellYesRaw: number | null;
  /** How far the venue tick grid moved the target, in cents. null when no price was produced. */
  snappedByC: number | null;
  bidInBand: boolean | null;
  askInBand: boolean | null;
  anyOutOfBand: boolean;
  tickKnown: boolean;
  /** Plain-Italian reason the prices are withheld when the tick is unreadable. null when known. */
  tickUnknownReason: string | null;
  totalSizeUsd: number | null;
  perSideUsd: number | null;
  /** THE dollar→share conversion for the YES buy: perSideUsd / buyYes. Shares. Null when either is null. */
  perSideShares: number | null;
  /** Same conversion for the NO buy at its own price: perSideUsd / buyNo. Shares. */
  perSideSharesNo: number | null;
  /** perSideShares × buyYes — the notional the YES side actually commits, in dollars. */
  notionalPerSideUsd: number | null;
  /** perSideSharesNo × buyNo — the notional the NO side actually commits, in dollars. */
  notionalPerSideNoUsd: number | null;
  /** Both sides together — what the configuration really commits against the stated total. */
  notionalTotalUsd: number | null;
  share: number | null;
  grossPerDay: number | null;
  dayYieldPct: number | null;
  ownImpactPct: number | null;
  ownImpactBand: 'low' | 'mid' | 'high' | null;
  eligibleDepthUsd: number | null;
  shareIsCeiling: boolean;
}

export function computePriceRow(args: {
  rewardScore: RewardScoreLike | null | undefined;
  tick: number | null | undefined;
  totalSizeUsd: number | null | undefined;
  offsetCents: number | null | undefined;
  market?: unknown;
}): PriceRow;

export function snapToTick(price: number, tick: number): number | null;
export function ownImpactBand(pct: number): 'low' | 'mid' | 'high' | null;
