// Types for lib/maker/auto-close-config.js — the ON/OFF control for AUTOMATIC POSITION CLOSING.
//
// Same three-fact separation as the auto-reprice switch, and for the same reason: `globalEnabled` (the
// master), `marketEnabled` (this market's opt-in) and `enabled` (both). A market opted in while the
// master is off must read as "opted in, master off", never as a bare OFF.

export interface AutoCloseDeps {
  closeConfigFile?: string;
  closeAuditFile?: string;
  now?: () => number;
  fs?: unknown;
  readFileSync?: unknown;
  writeFileSync?: unknown;
  renameSync?: unknown;
  mkdirSync?: unknown;
}

export interface AutoCloseRecord {
  enabled: boolean;
  at: number;
  atIso: string;
  by: string | null;
  reason: string | null;
}

export interface AutoCloseConfigState {
  readable: boolean;
  error: string | null;
  globalEnabled: boolean;
  globalRecord?: AutoCloseRecord | null;
  markets: Record<string, AutoCloseRecord>;
  /** Opted in AND covered by the master switch — what the closer will actually act on. */
  enabledMarketIds: string[];
  /** Opted in, regardless of the master switch. */
  optedInMarketIds: string[];
  configFile: string;
}

export interface AutoCloseVerdict {
  enabled: boolean;
  readable: boolean;
  globalEnabled: boolean;
  marketEnabled: boolean;
  error: string | null;
  record: AutoCloseRecord | null;
  reason: string;
}

export interface SetAutoCloseResult {
  ok: boolean;
  error?: string;
  scope: 'global' | 'market';
  marketId: string | null;
  enabled: boolean;
  record?: AutoCloseRecord;
}

export function readAutoCloseConfig(deps?: AutoCloseDeps): AutoCloseConfigState;
export function isAutoCloseEnabled(marketId: string | null | undefined, deps?: AutoCloseDeps): AutoCloseVerdict;
export function setAutoClose(
  arg: { scope?: 'global' | 'market'; marketId?: string | null; enabled: boolean; by?: string | null; reason?: string | null },
  deps?: AutoCloseDeps,
): SetAutoCloseResult;

export const CONFIG_FILE: string;
export const AUDIT_FILE: string;
/** Stamped on every automatic close — never 'manual-ui', 'agent35' or 'auto-reprice-band-exit'. */
export const AUTO_CLOSE_SOURCE: 'auto-close-on-fill';
/** The profit target in CENTS. Economic intent; the tick differs per market and the price snaps UP to it. */
export const CLOSE_PROFIT_CENTS: number;
/** A resting close SELL is never re-priced below entry + this, whatever the band does. */
export const MIN_PROFIT_CENTS: number;
