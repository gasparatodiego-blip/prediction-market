// Types for lib/maker/market-clock.js — the market's remaining life, and the order window it permits.
//
// `closeKnown:false` is NOT "closing soon": an unreadable close time keeps the ordinary fixed window and
// says so. `tooClose:true` is the refusal — under the threshold nothing new is placed, because the
// shortest expiry the venue accepts would outlive the market.

export interface MarketWindow {
  closeKnown: boolean;
  endMs: number | null;
  secondsToClose: number | null;
  minutesToClose: number | null;
  tooClose: boolean;
  minMinutes: number;
  ttlSeconds: number;
  refreshMarginSeconds: number | null;
  shortened: boolean;
  gate: string | null;
  reason: string;
}

export interface MarketWindowResolved extends MarketWindow {
  endIso: string | null;
  closeSource: string | null;
  marketId: string;
}

export function readMarketCloseMs(
  marketId: string | null | undefined,
  deps?: Record<string, unknown>,
): { readable: boolean; endMs: number | null; endIso: string | null; source: string | null };

export function resolveMarketWindow(a?: {
  endMs?: number | null;
  nowMs?: number;
  baseTtlSeconds?: number;
  baseRefreshMarginSeconds?: number | null;
  minMinutes?: number | null;
}): MarketWindow;

export function marketWindowFor(
  a: { marketId: string; nowMs?: number; baseTtlSeconds: number; baseRefreshMarginSeconds?: number | null; minMinutes?: number | null },
  deps?: Record<string, unknown>,
): MarketWindowResolved;

/** MAKER_MIN_MINUTES_TO_CLOSE, clamped up to the venue-derived floor. */
export function minMinutesToClose(env?: Record<string, string | undefined>): number;

export const GTD_FRACTION: number;
export const REFRESH_MARGIN_FRACTION: number;
export const MIN_REFRESH_MARGIN_SECONDS: number;
export const DEFAULT_MIN_MINUTES_TO_CLOSE: number;
export const MIN_SAFE_MINUTES: number;
export const BOARD_FILE: string;
