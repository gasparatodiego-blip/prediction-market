// lib/spread-types.ts — types + position sizing shared by the funding-arb
// dashboard (client component) and the landing page (server component).
//
// No `fs` or other Node-only imports here — this file gets bundled into the
// client. The actual file-reading computation lives in lib/spread-compute.ts.

export interface FuturesCoin {
  markPrice?:            number | null;
  fundingRate:           number;
  fundingIntervalHours?: number;
  nextFundingTime?:      number;
  openInterest?:         number | null;
  openInterestUsd?:      number | null;
  vol24hUsd?:            number | null;
}

export interface SlipPoint {
  size:          number;
  fillable:      boolean;
  slipBps:       number | null;
  slipUsd:       number | null;
  grossDayUsd:   number;
  netDayUsd:     number | null;
  slipOverGross: number | null;
  state:         'GREEN' | 'YELLOW' | 'RED';
}

export interface SpreadItem {
  coin:               string;
  shortExchange:      string;
  longExchange:       string;
  frShort:            number;
  frLong:             number;
  intervalHoursShort: number;
  intervalHoursLong:  number;
  // Real next-funding settlement timestamps (ms) captured from each venue's API,
  // when available — public timing data, never redacted. Absent for venues whose
  // fetcher carries no timestamp; the UI then falls back to a UTC-aligned boundary
  // computed from intervalHours. Display-only (drives the per-leg countdown).
  nextFundingTimeShort?: number;
  nextFundingTimeLong?:  number;
  shortIsDex:         boolean;
  longIsDex:          boolean;
  hasDexLeg:          boolean;
  // grossApy/netApy30d/totalFeesPct/breakevenDays: null on free tier
  // (server-side redaction, lib/paid-gating.ts). netApy30d in particular is a
  // reliable single proxy for "is this row's derived-edge data visible" —
  // frShort/frLong/markPrice stay real for everyone (public reference data).
  grossApy:           number | null;
  netApy30d:          number | null;
  totalFeesPct:       number | null;
  breakevenDays:      number | null;
  status:             'HARVEST' | 'CAUTION' | 'MARGINAL';
  liquidityTier:      string | null;
  capacityUsd:        number | null;          // = greenCapacityUsd when agent15 data fresh
  thinFlag:           boolean;                // OI-tier based (drives LiqChip ⚠, row dimming)
  depthThin:          boolean;                // true when greenCapacityUsd === 0
  depthNote:          string | null;
  oneLegUnverified:   boolean;                // true = ≥1 leg has no settled history
  slipCurve:          SlipPoint[] | null;      // null when not yet computed
  greenCapacityUsd:   number | null;           // largest GREEN size (0 if none)
  slipCurveMaxFillable: number | null;         // largest fillable size (slider clamp)
}

export interface SpreadsMeta {
  feePerLeg:    { cex: number; dex: number; gateio?: number; bitget?: number };
  legCount:     number;
  periodsPerYr: { cex: number; hl: number };
  note:         string;
}

export interface CryptoSpreadsData {
  ok:           boolean;
  generatedAt:  number | null;
  staleMinutes: number | null;
  futures:      Record<string, Record<string, FuturesCoin>>;
  spot:         Record<string, Record<string, { price: number; change24hPct?: number }>>;
  basisTrades:  unknown[];
  highFunding:  unknown[];
  cexArb:       unknown[];
  spreads:      SpreadItem[];
  meta:         SpreadsMeta | null;
}

// ── Position sizing ──────────────────────────────────────────────────────────
// Same formula the funding-arb dashboard uses to turn a SpreadItem's netApy30d
// into a dollar figure for a given capital/leverage. The landing page must call
// this rather than re-deriving $/day from fundingRate itself.
export type Leverage = 1 | 2 | 3 | 5;

// Returns null when the derived-edge fields are redacted (free tier) — never
// silently computes off a coerced-to-0 null. Callers gate their display on this.
export function calcSpreadSizing(s: SpreadItem, capital: number, leverage: Leverage): {
  N: number; feesUsd: number; net30dUsd: number; netYrUsd: number; dayUsd: number; roc: number;
} | null {
  if (s.totalFeesPct == null || s.grossApy == null || s.netApy30d == null) return null;
  const N         = capital * leverage / 2;
  const feesUsd   = N * s.totalFeesPct / 100;
  const net30dUsd = N * s.grossApy / 100 * 30 / 365 - feesUsd;
  const netYrUsd  = N * s.netApy30d / 100;
  const dayUsd    = netYrUsd / 365;
  const roc       = capital > 0 ? netYrUsd / capital * 100 : 0;
  return { N, feesUsd, net30dUsd, netYrUsd, dayUsd, roc };
}
