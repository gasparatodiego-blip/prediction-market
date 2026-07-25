// Types for lib/maker/worth-it.js — the "vale la pena?" verdict SSOT (see the .js for the contract).
export type WorthItCode =
  | 'BELOW_MIN_SIZE'
  | 'GROSS_BELOW_FLOOR'
  | 'ADVERSE_EXCEEDS_GROSS'
  | 'OWN_IMPACT_HIGH'
  | 'UNREADABLE';

export interface WorthItReason {
  code: WorthItCode;
  detail: string;
}

export interface WorthItResult {
  verdict: 'ok' | 'thin' | 'no' | 'unknown';
  worthIt: boolean | null;
  headline: string;
  reasons: WorthItReason[];
  floorUsdPerDay: number;
}

export function computeWorthIt(args: {
  grossPerDay?: number | null;
  adverseCostPerDay?: number | null;
  ownImpactPct?: number | null;
  perSideShares?: number | null;
  minSize?: number | null;
  poolDay?: number | null;
  floorUsdPerDay?: number | null;
}): WorthItResult;

export const CODES: Record<WorthItCode, WorthItCode>;
export const MIN_PAYOUT_USD: number;
export const OWN_IMPACT_HIGH_PCT: number;
