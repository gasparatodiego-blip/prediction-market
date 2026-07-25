// Types for lib/maker/market-cap.js — the per-market collateral ceiling applied to a quote set.
export interface CollateralCapResult<Q = any> {
  quotes: Q[];
  capUsd: number | null;
  plannedNotionalUsd: number;
  admittedNotionalUsd: number;
  blockedCount: number;
  capExceeded: boolean;
  unknownNotionalCount: number;
}

export function applyCollateralCap<Q = any>(args: {
  quotes: Q[];
  capUsd?: number | null;
}): CollateralCapResult<Q>;

export function notionalOf(q: { notionalUsd?: number | null; price?: number | null; size?: number | null }): number | null;
