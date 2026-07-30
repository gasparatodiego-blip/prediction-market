// Types for lib/maker/operator-board.js — the read-only aggregation behind the operator console.
//
// Every "verdict" field is nullable ON PURPOSE: null means "could not be judged" (unreadable venue
// rules, unknown token, no live mid) and is never collapsed into false. A caller that treats null as
// "in band" or as "zero" is reintroducing exactly the lie these types exist to prevent.

import type { RestingOrder } from './manual-order';

export interface SpreadClass {
  /** Book spread in cents, or null when the feed did not carry one. */
  spreadCents: number | null;
  level: 'basso' | 'medio' | 'alto' | null;
  label: string | null;
  note: string;
}

export interface StabilityBadge {
  known: boolean;
  label: 'fermo' | 'medio' | 'si muove' | null;
  score: number | null;
  reason: string | null;
  movedCents: number | null;
  consumedBandPct: number | null;
}

export interface BoardMarket {
  marketId: string;
  title: string | null;
  groupItemTitle: string | null;
  slug: string | null;
  marketSlug: string | null;
  category: string | null;
  /** True when the SHARED universe resolver puts this market in the bot's quoting set; null = the
   *  stored selection was unreadable, which is "we don't know", not "no". */
  inBotUniverse: boolean | null;

  mid: number | null;
  midSource: 'live-book' | 'board-row' | null;
  midAgeSec: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  tick: number | null;
  minSize: number | null;
  maxSpreadCents: number | null;
  bandRadiusCents: number | null;
  bandLo: number | null;
  bandHi: number | null;
  rulesReadable: boolean;
  rulesMissing: string[];
  tokenId: string | null;
  tokenIdNo: string | null;

  dailyPoolUsd: number | null;
  bookDepthAtBandUsd: number | null;
  /** NO per-market $/day is published: it depends on the capital it is priced for, and only the console
   *  knows the operator's real balance. These two fields plus rewardScore are the inputs it prices with
   *  through the shared estimateAtCapital, so the page can never show two contradictory estimates. */
  volume24hUsd: number | null;
  hoursToResolution: number | null;

  /** The feed's own scored block, passed through unchanged (never recomputed here). */
  rewardScore: { poolDay?: number | null; refShare?: number | null; refCapital?: number | null; mid?: number | null } | null;

  spread: SpreadClass;
  stability: StabilityBadge;
}

export interface BoardSummary {
  committedUsd: number | null;
  committedInBandUsd: number | null;
  unjudgeableCapitalUsd: number | null;
  /** null ⇒ a market holding in-band capital could not be scored; a total would understate. */
  estGrossUsdPerDay: number | null;
  estPerMarket: Array<{ marketId: string | null; title: string | null; inBandCapitalUsd: number | null; estUsdPerDay: number | null }>;
  outOfBandCount: number;
  inBandCount: number;
  unknownBandCount: number;
  unpricedOrders: number;
  marketsWithOrders: Array<{
    marketId: string | null; title: string | null; committedUsd: number | null;
    outOfBandCount: number; unknownBandCount: number; orderCount: number;
  }>;
}

export interface JudgedOrder extends RestingOrder {
  /** Resolved from the token id against the market's two token ids — never guessed. */
  book: 'yes' | 'no' | null;
  scoringMid: number | null;
  bandRadiusCents: number | null;
  distanceCents: number | null;
  signedDistanceCents: number | null;
  inBand: boolean | null;
  /** null = could not be judged. Never folded into either bucket. */
  outOfBand: boolean | null;
  valid: boolean | null;
  reasons: Array<{ code: string; detail: string }>;
  /** Tick-snapped price that would sit at the scoring mid. A suggestion for the form, not an action. */
  suggestedPrice: number | null;
  restingSize: number | null;
  restingNotionalUsd: number | null;
  marketTitle: string | null;
  rulesReadable: boolean;
}

export interface OrderBoard {
  ok: boolean;
  error: string | null;
  /** True ⇒ the venue was NOT reached. An empty list is not "no orders". */
  simulated: boolean;
  at: string;
  count: number;
  orders: JudgedOrder[];
  byMarket: Array<{
    marketId: string | null;
    title: string | null;
    orders: JudgedOrder[];
    committedUsd: number | null;
    outOfBandCount: number;
    unknownBandCount: number;
  }>;
  totals: {
    committedUsd: number | null;
    unpricedOrders: number;
    outOfBandCount: number;
    inBandCount: number;
    unknownBandCount: number;
  };
}

export interface PositionLeg {
  asset: string;
  side: 'yes' | 'no' | null;
  outcome: string | null;
  size: number | null;
  avgPrice: number | null;
  curPrice: number | null;
  currentValueUsd: number | null;
  initialValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  sideKnown: boolean;
}

export interface PositionMarket {
  marketId: string | null;
  title: string | null;
  slug: string | null;
  legs: PositionLeg[];
  yesShares: number | null;
  noShares: number | null;
  netShares: number | null;
  netDirection: 'yes' | 'no' | 'flat';
  currentValueUsd: number | null;
  initialValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  valueUnknown: boolean;
}

export interface PositionsResult {
  ok: boolean;
  wallet: string | null;
  error: string | null;
  source: string;
  at: string;
  markets: PositionMarket[];
  totals: {
    marketCount: number;
    legCount: number;
    currentValueUsd: number | null;
    unrealizedPnlUsd: number | null;
    valueUnknown: boolean;
  } | null;
  observed?: number | null;
  scanCapped?: boolean;
}

export interface MarketBoard {
  markets: BoardMarket[];
  selection: unknown;
  selectionReadable: boolean;
  generatedAt: string | null;
  polyGeneratedAt: string | null;
}

export function buildMarketBoard(
  deps?: { books?: unknown; norm?: unknown; selection?: unknown; prisma?: unknown },
): Promise<MarketBoard>;
export function buildOrderBoard(deps?: { books?: unknown; norm?: unknown }): Promise<OrderBoard>;
export function buildPositions(deps?: { wallet?: string; getJson?: (url: string) => Promise<unknown[]>; norm?: unknown }): Promise<PositionsResult>;
export function buildSummary(markets: BoardMarket[], orderBoard: OrderBoard | null): BoardSummary;
/** Re-exported from lib/reward-operator-estimate so server callers need one import. Same function. */
export { estimateAtCapital } from '../reward-operator-estimate';
export function judgeOrder(order: RestingOrder, rules: unknown): JudgedOrder;
export function classifySpread(bookSpread: number | null, maxSpreadCents: number | null): SpreadClass;
export const VENUE: string;
