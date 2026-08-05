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
import type { ResiduoSottoSoglia } from './residui-sotto-soglia';

export interface RestingLeg {
  orderId: string;
  price: number;
  size: number;
  book: Book;
  tokenId?: string | null;
  marketId?: string | null;
  status?: string;
  /** Venue-side life remaining, already corrected for the 60s the exchange retires GTD orders early.
   *  null ⇒ GTC, so the proactive-refresh trigger never fires for this order. */
  secondsToExpiry?: number | null;
  orderType?: 'GTC' | 'GTD' | null;
}

export interface RepriceDecision {
  action: 'hold' | 'reprice' | 'skip';
  /** Names WHICH rail or read produced this answer, and on a reprice WHICH TRIGGER fired:
   *  null = plain band exit, 'expiry-refresh' = the venue clock was running out at a price still in
   *  band, 'band-exit-and-expiry' = both at once (one move settles both). */
  gate: string | null;
  reason: string;
  /** The price to move to — already proven valid by the shared venue-rules guard. */
  targetPrice: number | null;
  distanceC: number | null;
  bandRadiusC: number | null;
  scoringMid: number | null;
  breachConfirmed: boolean;
  secondsToExpiry?: number | null;
  refreshMarginSeconds?: number;
  expiring?: boolean;
  /** Solo su gate 'refresh-invalid': i codici del guard condiviso che hanno rifiutato il rinnovo. */
  refreshInvalidCodes?: string[];
  /** True SOLO quando fra quei codici c'è BELOW_MIN_SIZE — cioè quando il residuo lasciato da un fill
   *  non arriva più a `min_incentive_size` e l'ordine è condannato a scadere. Gli altri motivi di
   *  refresh-invalid (fuori tick, fuori dai limiti di prezzo) NON lo accendono: un avviso «capitale in
   *  attesa di riallocazione» su quelli sarebbe un falso allarme. */
  belowMinSize?: boolean;
  minSize?: number;
  sizeRemaining?: number;
  price?: number;
  book?: Book;
  side?: 'BUY' | 'SELL';
  /** price × sizeRemaining: il capitale fermo su quel residuo. */
  notionalUsd?: number;
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
  action: 'reprice' | 'skip' | 'error' | 'reconnect-cancel';
  trigger?: 'band-exit' | 'expiry-refresh' | 'band-exit-and-expiry';
  secondsToExpiry?: number | null;
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
  /** Fatti che valgono un avviso, emessi UNA VOLTA per ordine e non a ogni giro. Oggi ce n'è uno solo:
   *  il residuo che muore sotto la soglia minima. */
  events: ResiduoSottoSoglia[];
  latencyMs?: number;
}

export function runAutoRepriceCycle(deps?: {
  killStatus?: () => { effectivelyKilled?: boolean; readable?: boolean };
  isManual?: (marketId: string) => ManualMarketVerdict;
  listOrders?: (arg: { marketId: string }) => Promise<OrdersResult>;
  resolveRules?: (marketId: string) => MarketRules;
  replaceOrder?: (spec: Record<string, unknown>) => Promise<ReplaceResult>;
  /** Used ONLY by the reconnect-after-blackout path — cancel-only, it can never start an order. */
  cancelOrder?: (spec: { orderId: string; marketId: string }) => Promise<{ ok: boolean; reason?: string | null }>;
  audit?: (rec: Record<string, unknown>) => void;
  config?: AutoRepriceTuning;
  configDeps?: AutoRepriceDeps;
  /** Carried BETWEEN cycles by the caller — "consecutive" must mean consecutive. */
  breaches?: Map<string, number>;
  /** Gli ordini per cui l'avviso «residuo sotto soglia» è già uscito. Portato fra i cicli dal chiamante
   *  come `breaches`: senza, l'avviso si ripeterebbe a ogni giro finché l'ordine non scade — che è
   *  esattamente il rumore da cui questo avviso è nato. Si pota quando l'ordine sparisce dal libro. */
  residuiSegnalati?: Set<string>;
  /** The connection-blackout clock, also carried between cycles. A fresh process starts with none:
   *  "we have been blind since T" is a claim about a continuous observation it did not make. */
  link?: { downSince: number | null; consecutiveFailures: number };
  now?: () => number;
}): Promise<CycleResult>;

export const AUTO_REPRICE_SOURCE: 'auto-reprice-band-exit';
