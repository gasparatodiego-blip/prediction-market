// Types for lib/maker/market-caps-store.js — the durable per-market collateral ceiling.
export interface MarketCapRead {
  capUsd: number | null;
  source: 'per-market' | 'fallback' | 'unset' | 'unreadable';
  updatedAt: string | null;
  updatedBy: string | null;
  error: string | null;
}

export function getMarketCap(
  marketId: string,
  opts?: { fallbackUsd?: number | null; capsFile?: string; now?: () => number },
): MarketCapRead;

export function setMarketCap(
  marketId: string,
  capUsd: number,
  updatedBy?: string,
  deps?: { capsFile?: string; now?: () => number },
): { ok: boolean; error?: string; marketId?: string; capUsd?: number; updatedAt?: string; updatedBy?: string };

export function clearMarketCap(
  marketId: string,
  deps?: { capsFile?: string },
): { ok: boolean; cleared?: boolean; error?: string };

export function readCaps(deps?: { capsFile?: string }): { ok: boolean; caps: Record<string, { capUsd: number; updatedAt: string; updatedBy: string }>; error?: string; existed?: boolean };

export const CAPS_FILE: string;
export const MAX_CAP_USD: number;
