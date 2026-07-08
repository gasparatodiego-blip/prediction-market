// lib/spread-types.ts — types + position sizing shared by the funding-arb
// dashboard (client component) and the landing page (server component).
//
// No `fs` or other Node-only imports here — this file gets bundled into the
// client. The actual file-reading computation lives in lib/spread-compute.ts.

export type AssetClass = 'crypto' | 'commodity' | 'stock' | 'index' | 'fx';

export interface FuturesCoin {
  markPrice?:            number | null;
  fundingRate:           number;
  fundingIntervalHours?: number;
  nextFundingTime?:      number;
  openInterest?:         number | null;
  openInterestUsd?:      number | null;
  vol24hUsd?:            number | null;
  assetClass?:           AssetClass;   // absent ⇒ 'crypto' (only RWA rows set this)
}

// RWA commodities (beta) — OBSERVATION only. Per-leg funding + REAL book depth, NEVER a
// cashable net/day (RWA funding is flat/near-zero on oracle-tracking perps). Separate lane
// from SpreadItem so crypto cards/list/table are untouched.
export interface RwaObservation {
  underlying:   string;                // canonical key, e.g. 'XAU_GOLD'
  label:        string;                // 'Gold' / 'Silver' / 'WTI Crude' / 'Brent Crude'
  assetClass:   'commodity';
  legs: {
    venue:         string;
    platform:      string;             // display label, e.g. 'Aster (DEX)'
    fundingRate:   number;             // native %/interval (instantaneous / between-settlement)
    intervalHours: number;
    rate8h:        number;             // instantaneous %/8h (often 0 on Aster between settlements)
    settledRate8h: number;             // REAL settled (trailing) %/8h — the honest headline
    trailingRate:  number;             // native settled avg %/interval
    spike?:        boolean;            // instantaneous rate deviates from the settled trend
    confirmed?:    boolean;            // real settled history verifies this leg
  }[];
  // Two-legged trailing funding divergence (beta, observation-only — NEVER cashable).
  // grossApy is a public teaser (capped at 200%/yr, honest-engine); netApy is the derived
  // fee-adjusted edge (paid-gated, null unless a sane confirmed non-spike spread exists).
  divergence: {
    shortVenue:      string;           // leg to short (higher settled funding)
    longVenue:       string;           // leg to long (lower settled funding)
    grossApy:        number;           // |Δ annualized settled|, capped 200%/yr
    grossApyOverCap: boolean;          // raw exceeded the 200%/yr cap
    totalFeesPct:    number;           // round-trip fees %/yr
    netApy:          number | null;    // fee-adjusted; null when FLAT/NOISE/UNCONFIRMED
    bothConfirmed:   boolean;
    spike:           boolean;
    verdict:         string;           // 'BETA · variable' | 'FLAT · no edge' | 'NOISE · rate unstable' | 'UNCONFIRMED · still settling'
  } | null;
  bookDepthUsd: number | null;         // real 20bps two-legged executable depth, limiting leg (min of Aster/Extended) — OBSERVATION, never "capacity"
  depthThin:    boolean;               // true when the limiting-leg 20bps depth is below MIN_LIQ_USD
  // True when only ONE leg carries a real settled funding signal (the other trails a flat 0,
  // e.g. Aster Brent): the row is single-leg observation and shows NO two-sided divergence.
  monolegOnly:  boolean;
  note:         string;                // 'beta · signal-only · …'
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

// Spread-persistence: a PAST track record of how long this pair's net funding spread
// has stayed profitable, computed from agent15's real 48h history ring buffer. Non-monetary
// context — stays visible on free tier. `spark` is a NORMALIZED unitless shape (0..1) and
// `bar` is sign-only (1 profitable / 0 not), so the absolute %/yr edge is NEVER exposed here
// (that stays a premium reveal via grossApy/netApy30d). null = not enough real aligned
// history yet ("in raccolta dati" — never a fabricated number). Window grows organically as
// the buffer fills, so windowHours reflects the TRUE available span (short today, longer later).
export interface Persistence {
  hours:       number;                    // contiguous profitable hours back from the newest sample
  windowHours: number;                    // true span of aligned history available right now
  stability:   'stabile' | 'variabile';   // coeff-of-variation read of net-spread wobble
  cv:          number;                     // coefficient of variation (transparency; 0 = flat)
  spark:       number[];                   // normalized net-spread shape [0..1], oldest→newest
  bar:         number[];                   // per-point profitable flag 1|0, oldest→newest
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
  // Why an otherwise-HARVEST (short-payback) pair was demoted to CAUTION at the
  // classification step. null = genuine CAUTION (payback-based) or not demoted.
  // Display-only transparency signal — never changes net/day, capacity, or fees.
  downgradeReason:    'thin-book' | 'one-sided' | null;
  liquidityTier:      string | null;
  capacityUsd:        number | null;          // = greenCapacityUsd when agent15 data fresh
  thinFlag:           boolean;                // OI-tier based (drives LiqChip ⚠, row dimming)
  depthThin:          boolean;                // true when greenCapacityUsd === 0
  depthNote:          string | null;
  oneLegUnverified:   boolean;                // true = ≥1 leg has no settled history
  slipCurve:          SlipPoint[] | null;      // null when not yet computed
  greenCapacityUsd:   number | null;           // largest GREEN size (0 if none)
  slipCurveMaxFillable: number | null;         // largest fillable size (slider clamp)
  persistence:        Persistence | null;      // past track record; null = still collecting real history
}

export interface SpreadsMeta {
  feePerLeg:    { cex: number; dex: number; gateio?: number; bitget?: number };
  legCount:     number;
  periodsPerYr: { cex: number; hl: number };
  note:         string;
}

// ── Perp-vs-Spot (delta-neutral carry) ───────────────────────────────────────
// One coin's best venue to SHORT the perp while holding SPOT, capturing the FULL
// absolute funding rate. Raw inputs are public teaser; the derived `edge` (dollar
// math) is redacted for the free tier — the page gates on edge.netPerDay1k == null.
export interface PerpSpotEdge {
  // All $ figures are quoted PER $1,000 per-leg; the client scales linearly to the
  // user's chosen capital. Redactable (→ null on free tier).
  grossPerDay1k:             number | null;
  feesOneTime1k:             number | null;
  netPerDay1k:               number | null;   // 30-day-amortized
  breakevenDays:             number | null;   // capital-invariant; null when never (≤0 funding)
  annualizedRunRatePct:      number | null;   // capped run-rate, demoted
  netAnnualizedOnCapitalPct: number | null;   // honest ROI on total (2×) capital
  // Public context (not redacted): the fee schedule that produced the figures.
  annualizedCapped:          boolean;
  perpFeePct:                number;
  spotFeePct:                number;
}

export interface PerpSpotRow {
  coin:                        string;
  shortVenue:                  string;
  spotVenueSuggested:          string;
  spotVenueVerified:           boolean;
  fundingRateNative:           number;   // native %/interval (teaser)
  intervalH:                   number;
  fundingPct8h:                number;   // normalized %/8h (teaser)
  trailingPositiveSettlements: number;   // real consecutive-positive count
  markPrice:                   number | null;
  vol24hUsd:                   number | null;
  edge:                        PerpSpotEdge;
}

// Funding-regime context computed live from real rates — never a hardcoded mood.
export interface PerpSpotRegime {
  state:                    'HOT' | 'CALM';
  medianTopQuartilePct8h:   number;   // median of the top-quartile |funding| across venues (%/8h)
  feeBreakevenPct8h:        number;   // %/8h needed to clear a typical round-trip fee over a 30d hold
  sampleCount:              number;   // venue×coin observations behind the median
  positiveCount:            number;   // how many are positive
  aboveBreakevenCount:      number;   // how many positive rates clear the fee hurdle
}

// ── USDC-margined funding-divergence arb (majors only) ───────────────────────
// SEPARATE lane from the main USDT crypto spreads. Each row shorts the higher-funding
// leg / longs the lower-funding leg of the SAME coin, where ≥1 leg is a USDC-settled
// perp. net $/day is primary; annualized is capped. De-peg risk is intrinsic and
// disclosed in the UI. $ fields are per $1,000 per leg and redacted on the free tier.
export interface UsdcArbEdge {
  grossPerDay1k:        number | null;
  feesOneTime1k:        number | null;
  netPerDay1k:          number | null;   // 30-day-amortized, per $1k/leg
  breakevenDays:        number | null;
  netApy30dPct:         number | null;
  annualizedRunRatePct: number | null;   // capped ±200%/yr, demoted
  annualizedCapped:     boolean;
  shortFeePct:          number;          // sourced USDC-M / USDT-M taker per leg
  longFeePct:           number;
}
export interface UsdcArbRow {
  coin:         string;
  shortVenue:   string;
  shortMargin:  'USDC' | 'USDT';
  longVenue:    string;
  longMargin:   'USDC' | 'USDT';
  frShortPct8h: number;   // real funding, normalized %/8h (public teaser)
  frLongPct8h:  number;
  intervalH:    number;
  grossApyPct:  number;   // annualized funding divergence (public)
  sameVenue:    boolean;  // (a) same-venue cross-quote vs (b) cross-venue
  comboLabel:   string;   // 'USDC↔USDT' | 'USDC↔USDC'
  markShort:    number | null;
  markLong:     number | null;
  liqTierShort: string | null;
  liqTierLong:  string | null;
  thin:         boolean;
  edge:         UsdcArbEdge;
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
  rwa:          RwaObservation[];   // commodities beta — observation-only, never cashable
  commoditiesHasEdge: boolean;      // derived gate: ≥1 confirmed two-legged RWA net ≥ COMMODITY_EDGE_MIN_NET_APY → reveal the Commodities lane
  perpSpot:     PerpSpotRow[];      // delta-neutral carry: best short-perp + spot hedge per coin
  perpSpotStale: boolean;           // source feed older than freshness window
  perpSpotRegime: PerpSpotRegime | null;  // live funding-regime banner context
  usdcArb:      UsdcArbRow[];       // USDC-margined funding-divergence lane (majors, thin, de-peg risk)
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
