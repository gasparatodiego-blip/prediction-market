// Type surface for lib/maker/fill-strategy-config.js — same shape and discipline as
// auto-close-config.d.ts. There is deliberately NO type here that would let a caller write a position
// ceiling: the ceiling is derived (see allocated-capital.d.ts), and the patch type is a closed set.

export interface FillStrategyRecord {
  enabled?: boolean;
  takeProfitCents?: number;
  stopLossPct?: number;
  maxSlippagePct?: number;
  at?: number;
  atIso?: string;
  by?: string | null;
  reason?: string | null;
}

export interface FillStrategyConfigState {
  readable: boolean;
  error: string | null;
  globalEnabled: boolean;
  globalRecord?: FillStrategyRecord | null;
  markets: Record<string, FillStrategyRecord>;
  optedInMarketIds: string[];
  enabledMarketIds: string[];
  configFile: string;
}

export interface FillStrategyEnabled {
  enabled: boolean;
  readable: boolean;
  globalEnabled: boolean;
  marketEnabled: boolean;
  error: string | null;
  record: FillStrategyRecord | null;
  reason: string;
}

export interface FillStrategyParams {
  takeProfitCents: number;
  takeProfitIsDefault: boolean;
  takeProfitMirrorsEntry: boolean;
  stopLossPct: number;
  stopLossIsDefault: boolean;
  maxSlippagePct: number;
  maxSlippageIsDefault: boolean;
}

/** The ONLY writable keys. A ceiling is not among them, and the runtime refuses any other key. */
export interface FillStrategyPatch {
  takeProfitCents?: number;
  stopLossPct?: number;
  maxSlippagePct?: number;
}

export interface SetFillStrategyResult {
  ok: boolean;
  scope?: string;
  marketId?: string | null;
  enabled?: boolean;
  record?: FillStrategyRecord;
  error?: string;
}

export interface Range { min: number; max: number }

export function readFillStrategyConfig(deps?: Record<string, unknown>): FillStrategyConfigState;
export function isFillStrategyEnabled(marketId: string, deps?: Record<string, unknown>): FillStrategyEnabled;
export function paramsFor(marketId: string, deps?: Record<string, unknown>): FillStrategyParams;
export function setFillStrategy(
  args: {
    scope?: 'global' | 'market';
    marketId?: string | null;
    enabled?: boolean | null;
    patch?: FillStrategyPatch | null;
    by?: string | null;
    reason?: string | null;
  },
  deps?: Record<string, unknown>,
): SetFillStrategyResult;

export const CONFIG_FILE: string;
export const AUDIT_FILE: string;
export const FILL_STRATEGY_SOURCE: string;
export const DEFAULT_TAKE_PROFIT_CENTS: number;
export const DEFAULT_STOP_LOSS_PCT: number;
export const DEFAULT_MAX_SLIPPAGE_PCT: number;
export const TAKE_PROFIT_RANGE: Range;
export const STOP_LOSS_RANGE: Range;
export const SLIPPAGE_RANGE: Range;
