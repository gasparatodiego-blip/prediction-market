// Type declarations for lib/reward-layered.js — see that file for the layering (not queue-position) rationale.

export const TAIL_LO: 0.10;
export const TAIL_HI: 0.90;

export interface LayerDepth {
  index: number;
  bidSizeAtLevel: number | null;
  askSizeAtLevel: number | null;
  samples?: number;
}

export interface DepthSource { kind: 'storico' | 'live'; hours?: number }

export interface PlanLayer {
  index: number;
  bidPrice: number | null;
  askPrice: number | null;
  distanceBidC: number | null;
  distanceAskC: number | null;
  sizeUsd: number | null;
  bidShares: number | null;
  askShares: number | null;
  tailZero: boolean;
  bidTail: boolean;
  askTail: boolean;
  degraded: boolean;
  weakerSide: 'bid' | 'ask' | 'both' | null;
  quoteValid: boolean;
  note: string | null;
  // added by capLayeredPlan:
  assignedUsd?: number | null;
  committedUsd?: number | null;
  uncommittedUsd?: number | null;
  eligibleDepthUsd?: number | null;
  capBound?: boolean;
  capNote?: string | null;
  // added by scoreLayeredPlan:
  competitorQ?: number | null;
  share?: number | null;
  dailyUsd?: number | null;
  depthSource?: DepthSource | null;
  depthSourceLabel?: string | null;
  bidDepth?: number | null;
  askDepth?: number | null;
}

export interface LayeredPlan {
  maxUsablePerSide: number;
  numLayers: number;
  spacingTicks: number;
  perSideSizeUsd: number | null;
  sizeSplitMode: 'equal' | 'custom';
  layers: PlanLayer[];
  reconciliation?: {
    perSideSizeUsd: number | null;
    totalAssigned: number;
    totalCommitted: number;
    totalUncommitted: number;
    reconciles: boolean;
  };
}

export interface ScoredLayeredPlan {
  layers: PlanLayer[];
  totalDailyUsd: number;
  rawTotalDailyUsd: number;
  poolCapped: boolean;
  poolDay: number | null;
  anyDepthUnreadable: boolean;
  depthSource: DepthSource | null;
  depthSourceLabel: string | null;
}

export function computeLayeredPlan(args: {
  rewardScore: { mid?: number; maxSpreadCents?: number; minSize?: number; poolDay?: number; competitorQ?: number };
  tick: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  perSideSizeUsd: number | null;
  numLayers?: number;
  spacingTicks?: number;
  sizeWeights?: number[];
}): LayeredPlan;

export function capLayeredPlan(plan: LayeredPlan, perLevelDepth?: Array<LayerDepth | null>): LayeredPlan;

export function scoreLayeredPlan(args: {
  plan: LayeredPlan;
  perLevelDepth?: Array<LayerDepth | null>;
  rewardScore: { mid?: number; maxSpreadCents?: number; minSize?: number; poolDay?: number };
  depthSource?: DepthSource | null;
}): ScoredLayeredPlan;

export function layerSizeSplit(n: number, opts?: { weights?: number[] }): number[];
export function depthSourceLabel(depthSource: DepthSource | null | undefined): string | null;
