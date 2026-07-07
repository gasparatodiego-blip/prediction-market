'use strict';

/**
 * Lightweight self-tests for the perp-spot carry estimator (and the fee helpers it
 * relies on). No framework — run with:  node lib/funding-math.check.js
 * Exits non-zero on the first failed assertion.
 */

const assert = require('assert');
const {
  venueFeePct,
  spotVenueFeePct,
  roundTripFeeByVenue,
  roundTripPerpSpotPct,
  estimatePerpSpot,
  PERP_SPOT_ANNUAL_CAP,
} = require('./funding-math');

const approx = (got, want, eps, label) => {
  assert.ok(Math.abs(got - want) < eps, `${label}: got ${got}, want ≈${want}`);
};

// ── roundTripFeeByVenue real signature (the ×100 / double-count trap) ──────────
// It is a COMBINED two-PERP-leg round trip returning a PERCENT: (fee+fee)×2.
assert.strictEqual(venueFeePct('dydx'), 0.05, 'dydx perp per-leg fee');
assert.strictEqual(venueFeePct('binance'), 0.04, 'binance perp per-leg fee (cex)');
approx(roundTripFeeByVenue('dydx', 'binance'), (0.05 + 0.04) * 2, 1e-9, 'roundTripFeeByVenue = (short+long)×2 percent');
// Using it for a SINGLE perp leg would DOUBLE-count → proving why perp-spot must not.
approx(roundTripFeeByVenue('dydx', 'dydx'), 0.05 * 4, 1e-9, 'roundTripFeeByVenue(v,v) = 4×fee (two legs) — wrong for one leg');

// ── spot fee schedule is distinct from the perp schedule ──────────────────────
assert.strictEqual(spotVenueFeePct('binance'), 0.10, 'binance SPOT taker 0.10% (not perp 0.04%)');
assert.strictEqual(spotVenueFeePct('gateio'), 0.20, 'gateio SPOT taker 0.20%');
assert.strictEqual(spotVenueFeePct('unknown-venue'), 0.20, 'unknown spot venue → conservative 0.20% fallback');

// ── roundTripPerpSpotPct = perp RT + spot RT (NOT roundTripFeeByVenue) ─────────
// short dydx perp (0.05/leg → 0.10 RT) + binance spot (0.10/leg → 0.20 RT) = 0.30%.
approx(roundTripPerpSpotPct('dydx', 'binance'), 0.05 * 2 + 0.10 * 2, 1e-9, 'perp-spot round trip = 0.30%');

// ── estimatePerpSpot: rate-unit normalization (×100 trap), breakeven, net/day ──
// fundingPct8h = 0.011052 means 0.011052 % per 8h (stored ×100), NOT 1.1%.
const r = estimatePerpSpot({
  capitalPerLeg: 1000,
  fundingPct8h: 0.011052,
  shortVenue: 'dydx',
  spotVenue: 'binance',
  trailingPositiveSettlements: 5,
});
// fraction/day = (0.011052/100) × 3 = 0.00033156 → $0.33156/day on $1000 notional.
approx(r.fundingFractionPerDay, 0.00033156, 1e-9, 'fundingFractionPerDay (×100 trap: /100 then ×3)');
approx(r.grossPerDay, 0.33156, 1e-4, 'grossPerDay on $1000');
// If the ×100 trap were mishandled (treated 0.011052 as a fraction), grossPerDay
// would be ~$33/day — assert we are NOT in that regime.
assert.ok(r.grossPerDay < 1, 'grossPerDay is cents/day, not dollars — ×100 handled');
// fees one-time = 1000 × 0.30% = $3.00.
approx(r.feesOneTime, 3.0, 1e-6, 'feesOneTime = $3.00 (0.30% of $1000)');
// breakeven = 3.00 / 0.33156 ≈ 9.0 days.
approx(r.breakevenDays, 9.0, 0.1, 'breakevenDays ≈ 9.0');
// net/day amortized over 30d = 0.33156 − 3/30 = 0.23156.
approx(r.netPerDayAmortized30, 0.23156, 1e-4, 'netPerDayAmortized30');
// capital needed = 2 × 1000 (conservative 1×).
assert.strictEqual(r.capitalNeeded, 2000, 'capitalNeeded = 2 × capitalPerLeg');
assert.strictEqual(r.flipRisk, false, 'flipRisk false at 5 settlements');

// ── linear scaling: every $ figure scales with capital; ratios are invariant ──
const r10 = estimatePerpSpot({ capitalPerLeg: 10000, fundingPct8h: 0.011052, shortVenue: 'dydx', spotVenue: 'binance', trailingPositiveSettlements: 5 });
// eps 1e-2 absorbs the 4-decimal display rounding on the reference figures.
approx(r10.grossPerDay, r.grossPerDay * 10, 1e-2, 'grossPerDay scales linearly');
approx(r10.feesOneTime, r.feesOneTime * 10, 1e-2, 'feesOneTime scales linearly');
approx(r10.breakevenDays, r.breakevenDays, 1e-6, 'breakevenDays is capital-invariant');
approx(r10.annualizedRunRatePct, r.annualizedRunRatePct, 1e-6, 'annualized is capital-invariant');

// ── flipRisk flag from real trailing count ────────────────────────────────────
assert.strictEqual(estimatePerpSpot({ capitalPerLeg: 1000, fundingPct8h: 0.01, shortVenue: 'dydx', spotVenue: 'binance', trailingPositiveSettlements: 1 }).flipRisk, true, 'flipRisk true at 1 settlement');

// ── 200%/yr run-rate cap ──────────────────────────────────────────────────────
// A wildly high (0.3 %/8h) rate → 0.9%/day × 365 ≈ 328%/yr → capped at 200.
const hot = estimatePerpSpot({ capitalPerLeg: 1000, fundingPct8h: 0.3, shortVenue: 'binance', spotVenue: 'binance', trailingPositiveSettlements: 8 });
assert.strictEqual(hot.annualizedRunRatePct, PERP_SPOT_ANNUAL_CAP, 'annualized capped at 200');
assert.strictEqual(hot.annualizedCapped, true, 'annualizedCapped flag set when clamped');

// ── zero / negative funding is handled calmly (no NaN/Infinity leaks in $) ─────
const zero = estimatePerpSpot({ capitalPerLeg: 1000, fundingPct8h: 0, shortVenue: 'dydx', spotVenue: 'binance', trailingPositiveSettlements: 0 });
assert.strictEqual(zero.grossPerDay, 0, 'zero funding → zero gross/day');
assert.strictEqual(zero.breakevenDays, Infinity, 'zero funding → never breaks even (Infinity)');
assert.ok(zero.netPerDayAmortized30 < 0, 'zero funding → negative net/day (you only pay fees) — shown calmly');

console.log('funding-math.check.js: ALL PASS');
