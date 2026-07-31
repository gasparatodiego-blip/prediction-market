// Types for lib/maker/auto-reprice.js — AUTOMATIC BAND-EXIT RE-PRICING for hand-placed orders.
//
// The three actions are deliberately distinct, and two of them mean "do not touch the order":
//   'hold'    the order is still inside the band — the steady state the whole feature exists to produce;
//   'skip'    something is not trustworthy or not permitted right now (stale mid, rate limit, …) — also
//             leaves the order alone, but for a reason the operator should be able to read;
//   'reprice' the mid has moved enough to push the order out of the band, confirmed and rails-cleared.
// A caller that collapses 'hold' and 'skip' loses the difference between "nothing needed doing" and
// "we declined to act on something we saw", which is exactly the distinction an audit trail needs.

import type { AutoRepriceDeps, AutoRepriceTuning } from './auto-reprice-config';
import type { MarketRules, ReplaceResult, OrdersResult, Book } from './manual-order';
import type { ManualMarketVerdict } from './manual-mode';

export interface RestingLeg {
  orderId: string;
  price: number;
  size: number;
  book: Book;
  tokenId?: string | null;
  marketId?: string | null;
  status?: string;
}

export interface RepriceDecision {
  action: 'hold' | 'reprice' | 'skip';
  /** Names WHICH rail or read produced this answer. null on a plain in-band hold and on a reprice. */
  gate: string | null;
  reason: string;
  /** The price to move to — already proven valid by the shared venue-rules guard. */
  targetPrice: number | null;
  distanceC: number | null;
  bandRadiusC: number | null;
  scoringMid: number | null;
  breachConfirmed: boolean;
}

export function decideReprice(args: {
  order: { orderId?: string; price: number; size: number; book?: Book };
  rules: MarketRules;
  config?: AutoRepriceTuning;
  lastRepriceAt?: number | null;
  consecutiveBreaches?: number;
  repricesThisHour?: number;
  now?: number;
}): RepriceDecision;

/** ONLY the orders the manual panel PROVABLY placed. agent35's and unattributable orders are excluded. */
export function selectOwnedOrders(
  orders: OrdersResult['orders'],
  arg: { marketId: string; rules: MarketRules },
): RestingLeg[];

export interface CycleMarketReport {
  marketId: string;
  gate: string | null;
  reason: string | null;
  considered: number;
  held: number;
  skipped: number;
  repriced: number;
}

export interface CycleAction {
  marketId: string;
  orderId: string;
  action: 'reprice' | 'skip' | 'error';
  ok?: boolean;
  gate?: string | null;
  reason?: string | null;
  fromPrice?: number;
  toPrice?: number | null;
  price?: number;
  size?: number;
  book?: Book;
  sent?: boolean;
  oldCancelled?: boolean;
  newOrderId?: string | null;
  distanceC?: number | null;
  bandRadiusC?: number | null;
}

export interface CycleResult {
  at: string;
  /** False when a gate stopped the whole pass (disabled, killed, config unreadable). */
  ran: boolean;
  gate: string | null;
  reason: string | null;
  markets: CycleMarketReport[];
  actions: CycleAction[];
  latencyMs?: number;
}

export function runAutoRepriceCycle(deps?: {
  killStatus?: () => { effectivelyKilled?: boolean; readable?: boolean };
  isManual?: (marketId: string) => ManualMarketVerdict;
  listOrders?: (arg: { marketId: string }) => Promise<OrdersResult>;
  resolveRules?: (marketId: string) => MarketRules;
  replaceOrder?: (spec: Record<string, unknown>) => Promise<ReplaceResult>;
  audit?: (rec: Record<string, unknown>) => void;
  config?: AutoRepriceTuning;
  configDeps?: AutoRepriceDeps;
  /** Carried BETWEEN cycles by the caller — "consecutive" must mean consecutive. */
  breaches?: Map<string, number>;
  now?: () => number;
}): Promise<CycleResult>;

export const AUTO_REPRICE_SOURCE: 'auto-reprice-band-exit';
