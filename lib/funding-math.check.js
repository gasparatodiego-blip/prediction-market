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
  perpSpotLeverage,
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

// ── perpSpotLeverage: HONEST leverage math (perp-margin only, ROE ceiling ~2×) ────
// Baseline row: $4/day net on $1,000/leg (low enough that even max-leverage ROE stays under
// the 200%/yr cap, so the ~2× bound is observable), venue cap 50×, maintenance 0.5%.
const NET = 4, CAP = 1000;
const lev1  = perpSpotLeverage({ netPerDay: NET, capitalPerLeg: CAP, leverage: 1,   maxLeverage: 50, maintenanceMarginPct: 0.5 });
const lev50 = perpSpotLeverage({ netPerDay: NET, capitalPerLeg: CAP, leverage: 50,  maxLeverage: 50, maintenanceMarginPct: 0.5 });
const lev125= perpSpotLeverage({ netPerDay: NET, capitalPerLeg: CAP, leverage: 125, maxLeverage: 50, maintenanceMarginPct: 0.5 });

// net $/day is ABSOLUTE — identical at 1× and max×, never scaled by leverage.
assert.strictEqual(lev1.netPerDay, NET, 'net/day unchanged at 1×');
assert.strictEqual(lev50.netPerDay, NET, 'net/day unchanged at 50× — NOT ×50');
// equity: 1× → spot + full margin = 2·cap; 50× → spot + cap/50.
approx(lev1.equity, 2000, 1e-6, 'equity at 1× = 2·capitalPerLeg');
approx(lev50.equity, 1000 + 1000 / 50, 1e-6, 'equity at 50× = cap + cap/50');
approx(lev1.perpMargin, 1000, 1e-6, 'perp margin at 1× = full notional');
approx(lev50.perpMargin, 20, 1e-6, 'perp margin at 50× = cap/50');
// ROE ceiling: max/1× ratio is bounded ~2× (equity halves from 2·cap to ~cap), NOT ×50.
const roeRatio = lev50.returnOnEquityPctPerYr / lev1.returnOnEquityPctPerYr;
assert.ok(roeRatio > 1.9 && roeRatio < 2.01, `ROE ratio 50×/1× bounded ~2× (got ${roeRatio}) — NOT the leverage factor`);
assert.ok(lev50.returnOnEquityPctPerYr <= (NET * 365) / CAP * 100 + 1e-6, 'ROE never exceeds the equity=spotNotional ceiling');
// effective leverage clamps to the real venue cap; request above cap → capped flag.
assert.strictEqual(lev125.effectiveLeverage, 50, 'effective leverage clamps to venue cap (50×)');
assert.strictEqual(lev125.capped, true, 'capped flag set when request > venue max');
assert.strictEqual(lev50.capped, false, 'not capped at exactly the venue max');
// liquidation buffer = 100/effLev − maintenance; null at 1×.
approx(lev50.adverseMovePct, 100 / 50 - 0.5, 1e-6, 'adverse move = 100/effLev − maint');
assert.strictEqual(lev1.adverseMovePct, null, 'no liquidation buffer at 1× (perp cannot liquidate)');

// null maxLeverage → non-leverageable: forced 1×, no buffer, honest.
const noLev = perpSpotLeverage({ netPerDay: NET, capitalPerLeg: CAP, leverage: 25, maxLeverage: null, maintenanceMarginPct: null });
assert.strictEqual(noLev.leverageable, false, 'null cap → not leverageable');
assert.strictEqual(noLev.effectiveLeverage, 1, 'null cap → forced effective 1×');
assert.strictEqual(noLev.adverseMovePct, null, 'null cap → no liquidation buffer');
approx(noLev.equity, 2000, 1e-6, 'null cap → equity stays 2·cap (1× model)');

// ROE ceiling is enforced BY CONSTRUCTION: equity(e) = spotNotional + perpNotional/e ≥
// spotNotional for every e, so ROE = net·365/equity ≤ net·365/spotNotional. Verify the
// invariant across the whole leverage range — ROE is monotonic in e and never exceeds the
// equity=spotNotional ceiling (the netPerDay×L bug would violate this and trip the impl guard).
const ceiling = (NET * 365) / CAP * 100;
let prevRoe = -1;
for (const L of [1, 2, 5, 10, 25, 50]) {
  const r = perpSpotLeverage({ netPerDay: NET, capitalPerLeg: CAP, leverage: L, maxLeverage: 50, maintenanceMarginPct: 0.5 });
  assert.ok(r.returnOnEquityPctPerYr <= ceiling + 1e-6, `ROE at ${L}× within equity-floor ceiling`);
  assert.ok(r.returnOnEquityPctPerYr >= prevRoe - 1e-9, `ROE monotonic non-decreasing in leverage at ${L}×`);
  assert.strictEqual(r.netPerDay, NET, `net/day leverage-invariant at ${L}×`);
  prevRoe = r.returnOnEquityPctPerYr;
}

// 200%/yr ROE cap (demoted run-rate) — a very high net/day at high leverage.
const hotLev = perpSpotLeverage({ netPerDay: 50, capitalPerLeg: 1000, leverage: 50, maxLeverage: 50, maintenanceMarginPct: 0.5 });
assert.ok(hotLev.returnOnEquityPctPerYr <= PERP_SPOT_ANNUAL_CAP, 'ROE capped at 200%/yr');
assert.strictEqual(hotLev.annualizedCapped, true, 'annualizedCapped flag set when ROE clamped');

console.log('funding-math.check.js: ALL PASS');
