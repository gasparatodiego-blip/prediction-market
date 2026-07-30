// Types for lib/maker/manual-mode.js — the PER-MARKET "the operator holds this by hand" flag.
//
// Fail-closed in BOTH directions: an unreadable state answers manual:true (agent35 stands off) AND
// readable:false (the manual panel refuses). The types keep those two facts separate on purpose — a
// caller that only checks `manual` and ignores `readable` cannot tell "claimed by the operator" from
// "ownership unknown", and those must lead to different messages even though both refuse.

export interface ManualRecord {
  manual: boolean;
  at: number;
  atIso: string;
  by: string | null;
  reason: string | null;
}

export interface ManualModeDeps {
  stateFile?: string;
  auditFile?: string;
  now?: () => number;
  fs?: unknown;
  readFileSync?: unknown;
  writeFileSync?: unknown;
  renameSync?: unknown;
  mkdirSync?: unknown;
}

export interface ManualModeState {
  readable: boolean;
  error: string | null;
  markets: Record<string, ManualRecord>;
  /** Only the markets currently held by hand. */
  marketIds: string[];
  stateFile: string;
}

export interface ManualMarketVerdict {
  manual: boolean;
  readable: boolean;
  error: string | null;
  record: ManualRecord | null;
  reason: string;
}

export interface SetManualResult {
  ok: boolean;
  error?: string;
  marketId: string;
  manual: boolean;
  record?: ManualRecord;
}

export interface CancelTargets {
  allowed: string[];
  skipped: string[];
  readable: boolean;
}

export function readManualMode(deps?: ManualModeDeps): ManualModeState;
export function isManualMarket(marketId: string | null | undefined, deps?: ManualModeDeps): ManualMarketVerdict;
export function setManualMode(
  arg: { marketId: string; manual: boolean; by?: string | null; reason?: string | null },
  deps?: ManualModeDeps,
): SetManualResult;
/** agent35's per-market placement gate: the block reason, or null to proceed. */
export function placementBlockReason(marketId: string, deps?: ManualModeDeps): string | null;
/** agent35's ROUTINE cancel-sweep filter. The KILL path deliberately does not use this. */
export function filterCancelTargets(marketIds: string[], deps?: ManualModeDeps): CancelTargets;

export const STATE_FILE: string;
export const AUDIT_FILE: string;
