// Types for lib/maker/manual-order.js — the server-side core of the MANUAL ORDERS panel.
//
// Every result type here keeps "refused" distinguishable from "failed" and from "did not reach the
// venue". `gate` names WHICH belt refused; `simulated` means no credentials so nothing was sent;
// `sent` is only ever true when a POST was genuinely attempted. A caller cannot accidentally read an
// empty order list as "you have no orders" or a dry-run as "placed".

import type { ManualMarketVerdict, ManualModeDeps, ManualRecord } from './manual-mode';
import type { AutoRepriceDeps, AutoRepriceRecord, AutoRepriceMarketState } from './auto-reprice-config';
import type { MarketWindowResolved } from './market-clock';
import type { MarketCatalogDeps, CatalogRecord } from './market-catalog';

export type Book = 'yes' | 'no';
export type Placement = 'dry-run' | 'send';
/** WHO acted. 'agent35' is stamped by the engine and never appears on this path. */
export type ManualSource = 'manual-ui' | 'auto-reprice-band-exit' | 'mm-tracking';

export interface ManualDeps extends ManualModeDeps, MarketCatalogDeps {
  /** Injected fixtures for the selfcheck; production passes nothing and reads the real files. */
  books?: unknown;
  norm?: unknown;
  /** Hand-added market metadata (fallback when the reward board has never seen this market). */
  catalogRecord?: CatalogRecord | null;
  /** Market-clock injection: an explicit close time, or fixtures for the files it reads. */
  marketClockDeps?: Record<string, unknown>;
  endMs?: number;
  board?: unknown;
  boardFile?: string;
  normFile?: string;
  env?: Record<string, string | undefined>;
  manualDeps?: ManualModeDeps;
  limitDeps?: { configFile?: string };
  killDeps?: { stateFile?: string; auditFile?: string };
  autoRepriceDeps?: AutoRepriceDeps;
  configFile?: string;
  autoStateFile?: string;
  autoAuditFile?: string;
}

/**
 * HOW LONG A HAND ORDER RESTS. GTD 180s when auto-reprice is off (and when its config is unreadable —
 * the fail-closed answer is always the SHORTER unattended window). When auto-reprice owns the market:
 * GTD RESTING_GTD_SECONDS, renewed proactively by the watcher with refreshMarginSeconds of life
 * still on it. Time never kills a healthy order; the expiry is the exchange-held DEAD-MAN'S SWITCH that
 * retires the order by itself if this host stops.
 */
export interface ManualExpiry {
  ttlSeconds: number;
  orderType: 'GTC' | 'GTD';
  autoReprice: boolean;
  /** How much life is left on the order when the watcher renews it proactively. null when not managed. */
  refreshMarginSeconds: number | null;
  /** `+market-clock` is appended when the market's remaining life shortened the window. */
  source: string;
  reason: string;
  /** The market's own clock. null only when no market was named. */
  window?: MarketWindowResolved | null;
  /** true ⇒ inside the no-new-orders threshold: the caller MUST refuse (see `gate`). */
  tooClose?: boolean;
  gate?: string | null;
}

export interface EngineState {
  fresh: boolean;
  ageSec: number | null;
  mode: string | null;
  canWrite: boolean | null;
  enginePlacement: string | null;
  pinnedMarketId: string | null;
  liveMinCapUsd: number | null;
  manualMarketIds: string[];
  unknownReason: string | null;
}

export interface MarketRules {
  readable: boolean;
  missing: string[];
  marketId: string;
  title: string;
  mid: number | null;
  tick: number | null;
  maxSpreadCents: number | null;
  minSize: number | null;
  tokenId: string | null;
  tokenIdNo: string | null;
  negRisk: boolean | null;
  bandRadiusCents: number | null;
  feedLive: boolean;
  feedAgeSec: number | null;
  /** Where the scoring mid came from — a board-row or catalog mid may be minutes old, and the panel says so. */
  midSource: 'live-book' | 'board-row' | 'manual-catalog' | null;
  midAgeSec: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  books: { yes: { tokenId: string | null; scoringMid: number | null }; no: { tokenId: string | null; scoringMid: number | null } };
  /**
   * Which source answered for this market. 'manual-catalog' = hand-added, not on the reward board.
   * 'live-book+manual-catalog' = hand-added AND now subscribed by agent34: the price is live, the venue
   * rules (tick / tokens / negRisk) still come from the catalog written when it was added.
   */
  rulesSource?: 'live-book' | 'board-row' | 'manual-catalog' | 'live-book+manual-catalog' | null;
  /** 'none' = the venue publishes no reward programme here. NOT a permission: the band guard still refuses. */
  rewardProgramme?: 'active' | 'none' | null;
  rewardsDailyRate?: number | null;
}

export interface Caps {
  readable: boolean;
  error: string | null;
  source: string;
  maxOrderNotionalUsd: number | null;
  maxOpenNotionalUsd: number | null;
  maxOrdersPerWindow: number | null;
  windowMs?: number | null;
  maxDailyLossUsd: number | null;
  venues: string[];
  venueAllowed?: boolean;
  missing?: string[];
  liveMinCapUsd: number | null;
  /** The MINIMUM of the safety-layer cap and the adapter's live-min cap. Never one alone. */
  effectiveOrderCapUsd: number | null;
  clampEvents: Array<{ field: string; storedValue: number; clampedTo: number; userId: string | null }>;
  hardCeilings: Record<string, number>;
}

export interface KillView {
  readable: boolean;
  killed: boolean;
  scope: string | null;
  reason: string | null;
  by: string | null;
  at: number | null;
}

export interface IsolationView {
  marketId: string;
  manual: boolean;
  readable: boolean;
  reason: string;
  record: ManualRecord | null;
  /** The ENGINE's own acknowledgement, read back from its published state. null = its state is stale. */
  engineAcknowledged: boolean | null;
}

/**
 * The band-exit automatism as the PANEL sees it. `watcher.alive === null` means the watcher has never
 * been seen running — which the UI must render differently from `false` (seen, but its heartbeat is
 * old) and from `true`. A stale heartbeat does not endanger the orders (the venue-side GTD retires them
 * on its own); it means they are about to lapse rather than be renewed, which the operator should see.
 */
export interface AutoRepriceView {
  readable: boolean;
  error: string | null;
  globalEnabled: boolean;
  optedInMarketIds: string[];
  enabledMarketIds: string[];
  market: {
    marketId: string | null;
    enabled: boolean;
    marketEnabled: boolean;
    readable: boolean;
    reason: string;
    record: AutoRepriceRecord | null;
  } | null;
  /** The lifetime a NEW hand order on this market would get right now, bounded by the market's own clock. */
  expiry: {
    orderType: 'GTC' | 'GTD'; ttlSeconds: number; refreshMarginSeconds: number | null; source: string; reason: string;
    /** true ⇒ a new order here would be REFUSED: the market is inside its final minutes. */
    tooClose?: boolean;
    window?: {
      closeKnown: boolean; endIso: string | null; closeSource: string | null;
      minutesToClose: number | null; minMinutes: number; shortened: boolean;
    } | null;
  } | null;
  watcher: {
    readable: boolean;
    heartbeatAt: number | null;
    heartbeatAgeSec: number | null;
    cycles: number;
    alive: boolean | null;
    process: string;
  };
  last: {
    at: number | null;
    atIso: string | null;
    orderId: string | null;
    fromPrice: number | null;
    toPrice: number | null;
    ok: boolean;
    sent: boolean;
    gate: string | null;
    reason: string | null;
    count: number;
    inLastHour: number;
  } | null;
}

export interface ManualContext {
  at: string;
  kill: KillView;
  placement: { mode: Placement; key: string; sends: boolean; note: string };
  engine: EngineState;
  /** WHICH markets live-min may touch right now: the operator's enabled list plus the env pin. */
  liveMinAllowlist: {
    pinnedMarketId: string | null;
    enabledMarketIds: string[];
    count: number;
    targetAllowed: boolean | null;
    note: string;
  };
  isolation: IsolationView | null;
  autoReprice: AutoRepriceView;
  caps: Caps;
  market: MarketRules | null;
  operatorUser: string;
}

export interface GateVerdict {
  allow: boolean;
  gate: string | null;
  reason: string | null;
  manual?: ManualMarketVerdict;
}

export interface PlaceResult {
  ok: boolean;
  /** True ONLY when a POST to the venue was genuinely attempted. */
  sent: boolean | null;
  dryRun?: boolean;
  ambiguous?: boolean;
  placement?: Placement;
  gate: string | null;
  reason: string | null;
  orderId?: string | null;
  wouldSend?: Record<string, unknown> | null;
  validateOrder?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  reasons?: Array<{ code: string; detail: string }>;
  marketId?: string | null;
  book?: Book;
  side?: 'BUY';
  price?: number;
  size?: number;
  notionalUsd?: number | null;
  /** The lifetime this order actually got, read back from the placement — GTC or GTD, and why. */
  expiry?: ManualExpiry;
  source?: ManualSource;
  /** Declassa il SOLO codice OUT_OF_BAND da bloccante a dichiarato (lib/maker/venue-rules.splitVerdict).
   *  La route del pannello lo accende quando l'operatore ha visto l'avviso «non matura reward»
   *  (`acknowledgeOutOfBand`); il motore di tracking lo accende per l'offset che ha dichiarato. */
  allowOutOfBand?: boolean;
  venueRules?: Record<string, unknown>;
  caps?: Caps;
}

export interface RestingOrder {
  orderId: string | null;
  marketId: string | null;
  tokenId: string | null;
  side: string | null;
  price: number | null;
  size: number | null;
  sizeMatched: number | null;
  sizeRemaining: number | null;
  status: string;
  createdMs: number | null;
  ageSec: number | null;
  source: 'manual-ui' | 'agent35' | 'unknown';
  notionalUsd: number | null;
  /** VENUE TRUTH about this order's lifetime, read from its own `expiration` field.
   *  'GTC' + secondsToExpiry:null means nothing will ever retire it except a fill, the operator, or the
   *  watcher. For GTD the seconds are corrected for the 60s the exchange retires orders EARLY, so they
   *  say when the order actually dies — not the timestamp printed on it. */
  orderType: 'GTC' | 'GTD';
  expirationUnix: number;
  expiresAtMs: number | null;
  expiresAtIso: string | null;
  /** Absolute margin: how long this order survives if the server stopped right now. */
  secondsToExpiry: number | null;
  /** When the watcher would renew it — REFRESH_MARGIN_SECONDS before the real death time. */
  secondsToRefresh: number | null;
  venueOrderType: string | null;
}

export interface OrdersResult {
  ok: boolean;
  error: string | null;
  /** True = we did NOT reach the venue (no credentials). An empty list here is not "no orders". */
  simulated: boolean;
  count: number;
  orders: RestingOrder[];
  at: string;
}

export interface CancelResult {
  ok: boolean;
  orderId: string;
  /** True only when the VENUE listed this id as cancelled. */
  cancelled?: boolean;
  alreadyGone?: boolean;
  venueRefusal?: string | null;
  noop?: boolean;
  simulated?: boolean;
  sent?: boolean;
  gate?: string;
  reason: string | null;
  at?: string;
}

export interface ReplaceResult {
  ok: boolean;
  replaced?: boolean;
  /** The load-bearing field: true + ok:false means nothing is resting for this leg right now. */
  oldCancelled?: boolean;
  oldOrderId?: string;
  cancel?: CancelResult;
  place?: PlaceResult;
  source?: ManualSource;
  expiry?: ManualExpiry | null;
  gate: string | null;
  reason: string | null;
  reasons?: Array<{ code: string; detail: string }>;
  note?: string;
  at?: string;
}

export function manualContext(arg?: { marketId?: string | null; userId?: string }, deps?: ManualDeps): ManualContext;
export function resolveMarketRules(marketId: string, deps?: ManualDeps): MarketRules;
export function resolveCaps(arg?: { userId?: string; engine?: EngineState | null }, deps?: { configFile?: string }): Caps;
export function manualPlacement(env?: Record<string, string | undefined>): Placement;
export function readEngineState(now?: number): EngineState;

/** GATE 1 — a hand order requires the market to be in manual mode (agent35 provably standing off). */
export function evaluateManualGate(arg: { marketId: string }, deps?: ManualModeDeps): GateVerdict;
export function evaluateManualCapGate(arg: { notionalUsd: number; caps: Caps }): GateVerdict;

/**
 * Resolve the lifetime a hand order on this market should carry. An explicit ttlSeconds always wins
 * (0 ⇒ GTC); otherwise the market's auto-reprice switch decides, and an unreadable switch falls back to
 * the fixed GTD — so a config that cannot be read can never produce an order with no expiry.
 */
export function resolveManualTtlSeconds(
  arg: { marketId?: string | null; ttlSeconds?: number | null; nowMs?: number },
  deps?: ManualDeps,
): ManualExpiry;

export function placeManualOrder(
  spec: {
    marketId?: string; book: Book; price: number; size: number; ttlSeconds?: number; note?: string;
    userId?: string; source?: ManualSource; side?: 'BUY' | 'SELL';
    /** La promessa di freschezza: il gate `stale-book` verifica che il mid venga davvero dal book live
     *  e sia piu' giovane di questi millisecondi. Assente ⇒ nessun requisito. */
    requireFreshBookMs?: number;
    /** Declassa il SOLO codice OUT_OF_BAND da bloccante a dichiarato (vedi ManualOrderSpec). */
    allowOutOfBand?: boolean;
  },
  deps?: ManualDeps,
): Promise<PlaceResult>;

export function listManualOrders(arg?: { marketId?: string | null }): Promise<OrdersResult>;

export function cancelManualOrder(
  arg: { orderId: string; marketId?: string | null; userId?: string },
  source?: ManualSource,
): Promise<CancelResult>;

export function replaceManualOrder(
  spec: { orderId: string; marketId?: string; book: Book; price: number; size: number; ttlSeconds?: number; note?: string; userId?: string; source?: ManualSource },
  deps?: ManualDeps,
): Promise<ReplaceResult>;

export const VENUE: string;
export const OPERATOR_USER: string;
export const FALLBACK_LIVE_MIN_CAP_USD: number;
export const MANUAL_SOURCES: readonly ManualSource[];
/** The panel's historical fixed expiry — still the behaviour whenever auto-reprice is off. */
export const DEFAULT_MANUAL_TTL_SECONDS: number;
