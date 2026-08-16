import type { UsdcArbRow } from './spread-types';

export declare const USDC_MAJORS: string[];
export declare const USDT_COUNTERPARTIES: string[];

export declare function computeUsdcArb(
  futures: Record<string, Record<string, any>>,
  futuresUsdc: Record<string, Record<string, any>>,
  history: Record<string, Record<string, Array<{ t: number; rate: number } | number>>>,
  now: number,
): { rows: UsdcArbRow[]; excluded: { venue: string; coin: string; reason: string }[] };
