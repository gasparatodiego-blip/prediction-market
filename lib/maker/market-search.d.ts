// Types for lib/maker/market-search.js — Polymarket market search with NO reward filter.
//
// `rewardsDailyRate: null` means the venue publishes NO reward programme for the market. It is a different
// fact from 0 (a programme with an empty pot) and from a market that was never read — the UI must label it
// ("NESSUN REWARD — solo trading direzionale"), never drop it and never round it to zero.

export interface MarketRow {
  marketId: string | null;
  question: string | null;
  slug: string | null;
  category: string | null;
  endDate: string | null;
  /** Signed: negative means the stated close time is already in the past. */
  minutesToClose: number | null;
  /** Published $/day pot. null ⇒ no reward programme at all. */
  rewardsDailyRate: number | null;
  hasRewards: boolean;
  /** Current book spread, in cents. */
  spreadCents: number | null;
  /** Venue minimum price increment. null when unread — never a guess. */
  tick: number | null;
  rewardsMaxSpreadCents: number | null;
  rewardsMinSize: number | null;
  negRisk: boolean | null;
  tokenIdYes: string | null;
  tokenIdNo: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  fetchedAt: number;
}

export interface SearchResult {
  ok: boolean;
  error: string | null;
  query: string;
  count: number;
  markets: MarketRow[];
  withRewards: number;
  withoutRewards: number;
  fetchedAt: number;
}

export function searchMarkets(opts?: {
  q?: string; limit?: number; includeClosed?: boolean; nowMs?: number; timeoutMs?: number;
}): Promise<SearchResult>;

export function fetchMarketByConditionId(
  conditionId: string,
  opts?: { nowMs?: number; timeoutMs?: number },
): Promise<{ ok: boolean; error: string | null; market: MarketRow | null }>;

export function fetchMarketsByConditionIds(
  ids: string[],
  opts?: { nowMs?: number; timeoutMs?: number },
): Promise<{ ok: boolean; error: string | null; markets: MarketRow[] }>;

export function normalizeMarket(m: Record<string, unknown>, nowMs?: number): MarketRow;
export function isConditionId(s: unknown): boolean;
/** The one label for reward status. `NESSUN REWARD — solo trading direzionale` when there is no pot. */
export function rewardLabelFor(m: Pick<MarketRow, 'hasRewards' | 'rewardsDailyRate'> | null): string;
export const NO_REWARD_LABEL: string;
export function rewardRateOf(m: Record<string, unknown>): number | null;
export const MAX_RESULTS: number;
