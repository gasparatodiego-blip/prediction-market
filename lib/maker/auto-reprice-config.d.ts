// Types for lib/maker/auto-reprice-config.js — the ON/OFF control for AUTOMATIC BAND-EXIT RE-PRICING,
// plus the watcher's own runtime state.
//
// The types keep three facts separate on purpose, because collapsing any pair of them produces a
// misleading UI: `globalEnabled` (the master switch), `marketEnabled` (this market's opt-in) and
// `enabled` (the effective answer — both of the above). A market that is opted in while the master is
// off must read as "opted in, master off", never as a bare OFF. Likewise `readable:false` is not the
// same as "disabled": it means the switch could not be read, and the automatism is inert as a result.

export interface AutoRepriceDeps {
  configFile?: string;
  autoStateFile?: string;
  autoAuditFile?: string;
  now?: () => number;
  fs?: unknown;
  readFileSync?: unknown;
  writeFileSync?: unknown;
  renameSync?: unknown;
  mkdirSync?: unknown;
}

export interface AutoRepriceRecord {
  enabled: boolean;
  at: number;
  atIso: string;
  by: string | null;
  reason: string | null;
}

export interface AutoRepriceConfigState {
  readable: boolean;
  error: string | null;
  /** The MASTER switch. False ⇒ nothing is watched, whatever the per-market opt-ins say. */
  globalEnabled: boolean;
  globalRecord?: AutoRepriceRecord | null;
  markets: Record<string, AutoRepriceRecord>;
  /** Markets opted in AND covered by the master switch — i.e. what the watcher will actually touch. */
  enabledMarketIds: string[];
  /** Markets opted in, regardless of the master switch. */
  optedInMarketIds?: string[];
  configFile: string;
  record?: AutoRepriceRecord | null;
}

export interface AutoRepriceVerdict {
  /** The effective answer: master switch AND this market's opt-in. */
  enabled: boolean;
  readable: boolean;
  globalEnabled: boolean;
  marketEnabled: boolean;
  error: string | null;
  record: AutoRepriceRecord | null;
  reason: string;
}

export interface SetAutoRepriceResult {
  ok: boolean;
  error?: string;
  scope: 'global' | 'market';
  marketId: string | null;
  enabled: boolean;
  record?: AutoRepriceRecord;
}

export interface AutoRepriceMarketState {
  lastRepriceAt: number;
  lastRepriceIso: string;
  lastOrderId: string | null;
  lastFromPrice: number | null;
  lastToPrice: number | null;
  lastOk: boolean;
  lastSent: boolean;
  lastGate: string | null;
  lastReason: string | null;
  count: number;
  /** Rolling-hour timestamps — the input to the per-market runaway ceiling. */
  recentAt: number[];
}

export interface AutoRepriceRuntimeState {
  readable: boolean;
  error?: string | null;
  markets: Record<string, AutoRepriceMarketState>;
  heartbeatAt: number | null;
  /** null = the watcher has NEVER been seen running. Not the same as "it is fine". */
  heartbeatAgeSec: number | null;
  cycles: number;
  lastCycleAt?: number | null;
  stateFile?: string;
}

export interface AutoRepriceTuning {
  pollMs: number;
  confirmSamples: number;
  hysteresisTicks: number;
  minIntervalMs: number;
  maxPerHour: number;
  maxMidAgeSec: number;
  requireLiveBook: boolean;
  strategy: 'band-edge' | 'nearest-mid';
}

export function readAutoRepriceConfig(deps?: AutoRepriceDeps): AutoRepriceConfigState;
export function isAutoRepriceEnabled(marketId: string | null | undefined, deps?: AutoRepriceDeps): AutoRepriceVerdict;
export function setAutoReprice(
  arg: { scope?: 'global' | 'market'; marketId?: string | null; enabled: boolean; by?: string | null; reason?: string | null },
  deps?: AutoRepriceDeps,
): SetAutoRepriceResult;

export function readAutoRepriceState(deps?: AutoRepriceDeps): AutoRepriceRuntimeState;
export function recordAutoRepriceState(
  arg: {
    marketId?: string | null;
    reprice?: { orderId?: string | null; fromPrice?: number; toPrice?: number; ok?: boolean; sent?: boolean; gate?: string | null; reason?: string | null } | null;
    heartbeat?: boolean;
  },
  deps?: AutoRepriceDeps,
): { ok: boolean; error?: string; at: number };
export function repricesInLastHour(marketId: string, deps?: AutoRepriceDeps, now?: number): number;

export function loadAutoRepriceTuning(env?: Record<string, string | undefined>): AutoRepriceTuning;

export const CONFIG_FILE: string;
export const STATE_FILE: string;
export const AUDIT_FILE: string;
/** The audit `source` stamped on every automatic move — never 'manual-ui', never 'agent35'. */
export const AUTO_REPRICE_SOURCE: 'auto-reprice-band-exit';
export const DEFAULTS: AutoRepriceTuning;
export const STRATEGIES: readonly ['band-edge', 'nearest-mid'];
