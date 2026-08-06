// Types for lib/maker/offset-config.js — the TARGET DISTANCE FROM THE MID, per market and per side.
//
// `source` is load-bearing and must not be collapsed into the value: 'configured' means the operator set
// it, 'remembered' means it was adopted from the first distance ever seen on that (market, book), and
// 'observed' means it is being seeded right now. The panel shows which, because "3¢ because you asked"
// and "3¢ because that is where the order happened to land" are different facts.

export type Book = 'yes' | 'no';
export type OffsetSource = 'configured' | 'remembered' | 'observed' | 'unknown';

export interface OffsetDeps {
  offsetConfigFile?: string;
  offsetAuditFile?: string;
  now?: () => number;
  fs?: unknown;
  readFileSync?: unknown;
  writeFileSync?: unknown;
  renameSync?: unknown;
  mkdirSync?: unknown;
}

export interface OffsetMarketRecord {
  targetOffsetCents: { yes?: number | null; no?: number | null };
  minMoveCents?: number;
  /** N — profondità richiesta davanti, in multipli della propria size. Assente/0 ⇒ protezione spenta. */
  depthMultiple?: number;
  at: number;
  atIso: string;
  by: string | null;
  reason: string | null;
}

export interface OffsetConfigState {
  readable: boolean;
  error: string | null;
  markets: Record<string, OffsetMarketRecord>;
  /** First distance ever seen per "<marketId>:<book>" — the "stay where you were placed" default. */
  observed: Record<string, number>;
  configFile: string;
}

export interface ResolvedOffset {
  targetOffsetCents: number | null;
  minMoveCents: number;
  /** N risolto per questo mercato. 0 ⇒ protezione di profondità spenta. */
  depthMultiple: number;
  source: OffsetSource;
  record: OffsetMarketRecord | null;
}

export function readOffsetConfig(deps?: OffsetDeps): OffsetConfigState;
export function resolveOffsetFor(
  arg: { marketId?: string | null; book?: Book | string; observedOffsetCents?: number | null; tick?: number | null },
  deps?: OffsetDeps,
): ResolvedOffset;
export function rememberObserved(
  arg: { marketId?: string | null; book?: Book | string; offsetCents: number },
  deps?: OffsetDeps,
): { ok: boolean; already?: boolean; offsetCents?: number; reason?: string };
export function validateOffset(arg: {
  targetOffsetCents?: number | null;
  minMoveCents?: number | null;
  depthMultiple?: number | null;
  bandRadiusCents?: number | null;
  tick?: number | null;
}): { valid: boolean; errors: Array<{ field: string; detail: string }> };
export function setMarketOffset(
  arg: { marketId: string; targetOffsetCents?: number; minMoveCents?: number; depthMultiple?: number; book?: Book | null; by?: string | null; reason?: string | null },
  deps?: OffsetDeps,
): { ok: boolean; error?: string; marketId?: string; record?: OffsetMarketRecord };
export function defaultMinMoveCents(tick: number | null | undefined): number;

export const CONFIG_FILE: string;
export const AUDIT_FILE: string;
/** Below this the re-price recomputes the SAME price after tick-snapping — churn with no benefit. */
export const MIN_MOVE_FLOOR_CENTS: number;
export const FALLBACK_MIN_MOVE_CENTS: number;
/** Oltre questo N la soglia non è raggiungibile in banda su nessun book reale osservato. */
export const DEPTH_MULTIPLE_MAX: number;
