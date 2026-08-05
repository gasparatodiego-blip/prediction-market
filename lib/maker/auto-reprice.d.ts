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
import type { ScadenzaSenzaRinnovo } from './scadenze-senza-rinnovo';

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
  /** Lo stesso fatto come ISTANTE (epoch ms), letto dal campo `expiration` del venue e già corretto per i
   *  60s di ritiro anticipato. Serve a rispondere «è morto per scadenza?» su un ordine che non si vede
   *  più: un conto alla rovescia letto un ciclo prima non lo può dire, un istante sì. */
  expiresAtMs?: number | null;
  sizeMatched?: number | null;
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
  /** True quando questo RINNOVO di scadenza procede a tetto orario raggiunto. Il tetto ferma i riprezzi
   *  discrezionali; fermare un rinnovo non evita una mossa, garantisce una scadenza. La condizione è
   *  strutturale (`expiring`, cioè il TTL pubblicato dal venue dentro il margine) e non dichiarabile dal
   *  chiamante, quindi un riprezzo non può travestirsi da rinnovo. */
  capExemptRenewal?: boolean;
  repricesThisHour?: number;
  maxPerHour?: number | null;
  /** Quale rail aveva fermato l'inseguimento nello stesso ciclo, quando il rinnovo lo scavalca. */
  railInseguimento?: string | null;
  /** Solo su gate 'inseguimento-contro-mai-primo': l'inseguimento del mid chiedeva di allontanarsi da una
   *  posizione che «mai primi sul libro» rende MIGLIORE (più vicina al mid, quindi più premiante), e le due
   *  regole si annullavano a vicenda a ogni ciclo. Vince «mai primi»; l'inseguimento viene ignorato finché
   *  il book non cambia. I quattro numeri sotto sono quelli su cui la soppressione è stata decisa. */
  soppresso?: boolean;
  inseguimentoPrezzo?: number | null;
  inseguimentoDistanzaC?: number | null;
  maiPrimoPrezzo?: number | null;
  maiPrimoDistanzaC?: number | null;
  maiPrimoMode?: string | null;
  bestOther?: number | null;
  targetOffsetCents?: number | null;
  minMoveCents?: number | null;
  currentOffsetCents?: number | null;
  offsetSource?: string;
  bandClamped?: boolean;
  feedRegime?: string | null;
  maxMidAgeSecApplicato?: number | null;
}

export function decideReprice(
  args: {
    order: RestingLeg | { orderId?: string; price: number; size: number; book?: Book };
    rules: MarketRules;
    config?: AutoRepriceTuning;
    lastRepriceAt?: number | null;
    consecutiveBreaches?: number;
    repricesThisHour?: number;
    now?: number;
    /** TUTTI i nostri ordini a riposo su quel libro. «Sono il primo del book?» si risponde togliendo dal
     *  libro tutta la nostra presenza; e per PREVEDERE dove atterrerebbe un rimpiazzo si usa lo stesso
     *  insieme che il percorso di piazzamento passa a `prezzoInCoda`, al netto dell'ordine sostituito. */
    ownOrders?: Array<{ orderId?: string; price: number; size?: number; sizeRemaining?: number; book?: Book }> | null;
  },
  deps?: {
    resolveOffset?: (arg: Record<string, unknown>) => { targetOffsetCents: number | null; minMoveCents: number; source: string };
    offsetDeps?: Record<string, unknown>;
    /** I livelli del book. Senza questa, né il trigger «sono diventato il primo» né il rilevamento del
     *  conflitto inseguimento/mai-primo possono rispondere: si torna al comportamento precedente, che è
     *  diverso da fallire in silenzio. */
    resolveDepth?: (marketId: string) => unknown;
  },
): RepriceDecision;

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
  action: 'reprice' | 'skip' | 'error' | 'reconnect-cancel' | 'cancel' | 'cancel-failed' | 'end-of-life-cancel' | 'end-of-scale-cancel';
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
  /** True quando questo rinnovo è passato in esenzione dal tetto orario, coi numeri su cui è stato deciso. */
  capExemptRenewal?: boolean;
  repricesThisHour?: number | null;
  maxPerHour?: number | null;
}

export interface CycleResult {
  at: string;
  /** False when a gate stopped the whole pass (disabled, killed, config unreadable). */
  ran: boolean;
  gate: string | null;
  reason: string | null;
  markets: CycleMarketReport[];
  actions: CycleAction[];
  /** Fatti che valgono un avviso, emessi UNA VOLTA per ordine e non a ogni giro: il residuo che muore
   *  sotto la soglia minima, e l'ordine gestito che la scadenza GTD ha spento senza rinnovo. */
  events: Array<ResiduoSottoSoglia | ScadenzaSenzaRinnovo>;
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
  /** Gli ordini per cui il conflitto inseguimento/mai-primo è già stato dichiarato. Nel registro durevole
   *  vanno le TRANSIZIONI: la soppressione è uno stato che dura finché il book non cambia, e una riga ogni
   *  cinque secondi sarebbe lo stesso rumore da cui questo lavoro è nato. */
  conflittiSoppressi?: Set<string>;
  /** Ciò che sappiamo di ogni ordine visto a riposo, per poter rispondere «è morto per scadenza, e perché
   *  nessuno l'ha rinnovato?» su un ordine che non c'è più. Chiave: orderId. */
  ordiniVisti?: Map<string, Record<string, unknown>>;
  /** I livelli del book, per il trigger «sono diventato il primo» e per il rilevamento del conflitto. */
  resolveDepth?: (marketId: string) => unknown;
  trackedMarketIds?: () => string[];
  marketWindow?: (marketId: string) => { tooClose?: boolean; gate?: string; reason?: string; minutesToClose?: number | null } | null;
  disableMarket?: (arg: { marketId: string; reason: string }) => Promise<{ ok: boolean; error?: string }>;
  resolveOffset?: (arg: Record<string, unknown>) => { targetOffsetCents: number | null; minMoveCents: number; source: string };
  offsetDeps?: Record<string, unknown>;
  rememberObserved?: (arg: Record<string, unknown>, deps?: Record<string, unknown>) => void;
  /** The connection-blackout clock, also carried between cycles. A fresh process starts with none:
   *  "we have been blind since T" is a claim about a continuous observation it did not make. */
  link?: { downSince: number | null; consecutiveFailures: number };
  now?: () => number;
}): Promise<CycleResult>;

export const AUTO_REPRICE_SOURCE: 'auto-reprice-band-exit';
