// Types for lib/maker/manual-order.js — the server-side core of the MANUAL ORDERS panel.
//
// Every result type here keeps "refused" distinguishable from "failed" and from "did not reach the
// venue". `gate` names WHICH belt refused; `simulated` means no credentials so nothing was sent;
// `sent` is only ever true when a POST was genuinely attempted. A caller cannot accidentally read an
// empty order list as "you have no orders" or a dry-run as "placed".

import type { ManualMarketVerdict, ManualModeDeps, ManualRecord } from './manual-mode';

export type Book = 'yes' | 'no';
export type Placement = 'dry-run' | 'send';

export interface ManualDeps extends ManualModeDeps {
  /** Injected fixtures for the selfcheck; production passes nothing and reads the real files. */
  books?: unknown;
  norm?: unknown;
  env?: Record<string, string | undefined>;
  manualDeps?: ManualModeDeps;
  limitDeps?: { configFile?: string };
  killDeps?: { stateFile?: string; auditFile?: string };
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
  /** Where the scoring mid came from — a board-row mid may be minutes old, and the panel says so. */
  midSource: 'live-book' | 'board-row' | null;
  midAgeSec: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  books: { yes: { tokenId: string | null; scoringMid: number | null }; no: { tokenId: string | null; scoringMid: number | null } };
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

export interface ManualContext {
  at: string;
  kill: KillView;
  placement: { mode: Placement; key: string; sends: boolean; note: string };
  engine: EngineState;
  isolation: IsolationView | null;
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

export function placeManualOrder(
  spec: { marketId?: string; book: Book; price: number; size: number; ttlSeconds?: number; note?: string; userId?: string },
  deps?: ManualDeps,
): Promise<PlaceResult>;

export function listManualOrders(arg?: { marketId?: string | null }): Promise<OrdersResult>;

export function cancelManualOrder(
  arg: { orderId: string; marketId?: string | null; userId?: string },
): Promise<CancelResult>;

export function replaceManualOrder(
  spec: { orderId: string; marketId?: string; book: Book; price: number; size: number; ttlSeconds?: number; note?: string; userId?: string },
  deps?: ManualDeps,
): Promise<ReplaceResult>;

export const VENUE: string;
export const OPERATOR_USER: string;
export const FALLBACK_LIVE_MIN_CAP_USD: number;
