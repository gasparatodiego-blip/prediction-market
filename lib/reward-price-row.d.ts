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
  bidInBand: boolean | null;
  askInBand: boolean | null;
  anyOutOfBand: boolean;
  tickKnown: boolean;
  totalSizeUsd: number | null;
  perSideUsd: number | null;
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
