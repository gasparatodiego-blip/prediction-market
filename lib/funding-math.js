'use strict';

/**
 * Shared funding-rate math utilities.
 *
 * Imported by:
 *   agents/agent10-binance.js       (require '../lib/funding-math')
 *   agents/agent15-funding-writer.js (require '../lib/funding-math')
 *   app/api/crypto/route.ts          (import '@/lib/funding-math')
 *
 * DO NOT add a venue-specific annualization multiplier anywhere else.
 * annualize() is the single source of truth.
 */

const HOURS_PER_YEAR = 8760; // 24 * 365

/**
 * Annualize a per-interval funding rate to %/yr.
 *   annualize(0.001, 8)  → 1.095 %/yr  (CEX: 8h interval)
 *   annualize(0.001, 1)  → 8.76  %/yr  (HL:  1h interval)
 */
function annualize(ratePerInterval, intervalHours) {
  return ratePerInterval * (HOURS_PER_YEAR / intervalHours);
}

/** Taker fee per leg by venue type. */
const VENUE_FEE_PCT = {
  cex:    0.04,   // Binance / Bybit / OKX typical taker
  gateio: 0.05,   // Gate.io USDT futures taker
  bitget: 0.06,   // Bitget USDT-M futures taker
  dex:    0.025,  // Hyperliquid taker (maker 0%)
  dydx:   0.05,   // dYdX v4 taker (standard tier)
  // Aster USDT-Perp taker (maker 0%). Not exposed on the public unauthenticated
  // API — sourced from Aster's official docs on 2026-07-04
  // (docs.asterdex.com/trading/perpetuals/fees-and-specs/fees): USDT-Perp taker 0.04%.
  aster:  0.04,
  // Paradex perp taker (maker 0%). Fee IS exposed on the public API — read live from
  // /markets fee_config.taker_fee = 0.0002 on 2026-07-04; matches docs.paradex.trade
  // (taker 0.02% / maker 0%). Conservative taker assumption — maker fills not guaranteed.
  paradex: 0.02,
  // edgeX perp taker (maker 0.018%). Fee IS exposed on the public API — read live from
  // getMetaData contract.defaultTakerFeeRate = 0.00038 on 2026-07-04; matches
  // docs.edgex.exchange (taker 0.038% / maker 0.018%). Conservative taker assumption —
  // maker fills not guaranteed.
  edgex:  0.038,
  // Grvt perp taker (maker -0.0001% rebate). NOT exposed on the public market-data API
  // (instrument metadata carries no fee fields) — sourced from Grvt's fee docs on
  // 2026-07-04 (help.grvt.io/9614699 + grvt.gitbook.io/grvt/trading/fees): base-tier
  // (Level 1) perp taker 0.045% / maker -0.0001%. Conservative base-tier taker.
  grvt:   0.045,
  // Lighter (zkLighter) perp taker (maker 0%). Fee IS exposed on the public API — read
  // live from /api/v1/orderBooks taker_fee=0.0000 / maker_fee=0.0000 on 2026-07-04
  // (Lighter is currently fee-free; apidocs.lighter.xyz). Genuinely 0, confirmed from
  // source — an honest zero, not a blind default.
  lighter: 0.0,
  // Extended (extended.exchange) perp taker (maker 0%). NOT exposed on the public market
  // data API — sourced from Extended's fee docs on 2026-07-04 (docs.extended.exchange/
  // extended-resources/trading/trading-fees-and-rebates): flat perp taker 0.025% / maker
  // 0.000%. Conservative taker assumption — maker fills not guaranteed.
  extended: 0.025,
  // Pacifica (pacifica.fi) perp taker (maker 0.015%). NOT exposed on the public market data
  // API — sourced from Pacifica's fee docs on 2026-07-05 (docs.pacifica.fi/trading-on-
  // pacifica/trading-fees): Tier-1 (0 volume) taker 0.04% / maker 0.015%. Conservative
  // base-tier taker — maker fills not guaranteed.
  pacifica: 0.04,
  // ApeX Omni (apex.exchange) perp taker (maker 0.02%). NOT exposed on the public market
  // data API — sourced from ApeX's fee docs on 2026-07-05 (apex.exchange/blog fee-structure
  // updates): standard taker 0.05% / maker 0.02% (base-tier ≤500k 30d vol: 0.025% taker /
  // 0% maker). Conservative standard taker — maker fills not guaranteed.
  apex: 0.05,
};

/**
 * Per-venue SPOT taker fee in % per leg (published base-tier / VIP0 rates, NO
 * fee-token discount — deliberately conservative so net/day is never overstated).
 * The perp-spot carry trade buys spot on a major, so we need the SPOT schedule,
 * which is DIFFERENT from the perp (VENUE_FEE_PCT) schedule — do NOT reuse
 * venueFeePct() for the spot leg. All rates verified 2026-07-07:
 *   binance 0.10% — binance.com/en/fee/schedule (Regular / VIP0 spot taker 0.1000%)
 *   okx     0.10% — okx.com/fees (Lv1 spot taker 0.10%)
 *   bybit   0.10% — bybit.com/en/help-center trading-fee (non-VIP spot taker 0.10%)
 *   gateio  0.20% — gate.io/fee (base-tier spot taker 0.20%; conservative upper bound)
 * Fallback for any other suggested venue is the most conservative (highest) of these.
 */
const SPOT_FEE_PCT = {
  binance: 0.10,
  okx:     0.10,
  bybit:   0.10,
  gateio:  0.20,
};

/** Per-venue SPOT taker fee in % per leg. Conservative fallback = 0.20%. */
function spotVenueFeePct(exchange) {
  const key = String(exchange || '').toLowerCase();
  if (key in SPOT_FEE_PCT) return SPOT_FEE_PCT[key];
  return 0.20;
}

/**
 * USDC-MARGINED (USDC-M) perpetual taker fee in % per leg. These are the SEPARATE
 * USDC-settled contracts (Binance *USDC, Bybit/Bitget *PERP) — a DIFFERENT fee
 * schedule from the USDT-M perps, so we do NOT reuse VENUE_FEE_PCT.cex (0.04%).
 * Each rate is the REAL published/live base-tier taker, sourced + dated below.
 * Deliberately conservative: where a venue runs a pair-specific ZERO-fee promo
 * (Binance has repeatedly done this for BTCUSDC/ETHUSDC), we do NOT assume it —
 * we quote the standard rate, which can only UNDERstate net, never overstate it.
 *
 *   binance-usdc 0.05% — standard USDⓈ-M Futures VIP0 taker (maker 0.02%). The
 *     USDC-margined pairs sit on the same USDⓈ-M schedule as USDT-M. Binance runs
 *     recurring 0-fee promos on select USDC pairs (e.g. BTCUSDC/ETHUSDC) — NOT
 *     assumed here. Sourced: binance.com/en/fee/futureFee + zero-fee promo
 *     announcements (binance.com/en/support/announcement) reviewed 2026-07-08.
 *   bybit-usdc   0.055% — USDC Perpetual non-VIP taker (maker 0.02%). Sourced:
 *     bybit.com/en/help-center/article/USDC-Contract-FAQ + Trading-Fee-Structure,
 *     reviewed 2026-07-08.
 *   bitget-usdc  0.06% — read LIVE from Bitget's public API on 2026-07-08:
 *     api.bitget.com/api/v2/mix/market/contracts?productType=USDC-FUTURES
 *     → BTCPERP takerFeeRate 0.0006 (maker 0.0002). Not reused from USDT-M — it
 *     happens to match, but is independently sourced from the USDC-M endpoint.
 */
const USDC_M_FEE_PCT = {
  'binance-usdc': 0.05,
  'bybit-usdc':   0.055,
  'bitget-usdc':  0.06,
};

/**
 * Per-venue USDC-M perp taker fee in % per leg. Returns null for an unknown/unsourced
 * USDC venue so callers can EXCLUDE it from auto-selection rather than assume a
 * favorable number (honest-engine: never guess a fee).
 */
function usdcVenueFeePct(venue) {
  const key = String(venue || '').toLowerCase();
  return key in USDC_M_FEE_PCT ? USDC_M_FEE_PCT[key] : null;
}

/** Per-venue taker fee in % per leg. */
function venueFeePct(exchange) {
  // USDC-margined perps carry their own sourced schedule (never the USDT 0.04%).
  const usdc = usdcVenueFeePct(exchange);
  if (usdc != null) return usdc;
  if (exchange === 'hyperliquid') return VENUE_FEE_PCT.dex;
  if (exchange === 'dydx')        return VENUE_FEE_PCT.dydx;
  if (exchange === 'aster')       return VENUE_FEE_PCT.aster;
  if (exchange === 'lighter')     return VENUE_FEE_PCT.lighter;
  if (exchange === 'extended')    return VENUE_FEE_PCT.extended;
  if (exchange === 'pacifica')    return VENUE_FEE_PCT.pacifica;
  if (exchange === 'apex')        return VENUE_FEE_PCT.apex;
  if (exchange === 'paradex')     return VENUE_FEE_PCT.paradex;
  if (exchange === 'edgex')       return VENUE_FEE_PCT.edgex;
  if (exchange === 'grvt')        return VENUE_FEE_PCT.grvt;
  if (exchange === 'gateio')      return VENUE_FEE_PCT.gateio;
  if (exchange === 'bitget')      return VENUE_FEE_PCT.bitget;
  return VENUE_FEE_PCT.cex;
}

/**
 * Round-trip fee by exchange name (preferred over roundTripFee for multi-DEX support).
 * Handles HL (0.025%/leg) and dYdX (0.05%/leg) correctly.
 */
function roundTripFeeByVenue(shortVenue, longVenue) {
  return (venueFeePct(shortVenue) + venueFeePct(longVenue)) * 2;
}

/**
 * Total round-trip fee for a 2-leg trade (open + close both sides).
 * @param {boolean} shortIsDex
 * @param {boolean} longIsDex
 */
function roundTripFee(shortIsDex, longIsDex) {
  const feeShort = shortIsDex ? VENUE_FEE_PCT.dex : VENUE_FEE_PCT.cex;
  const feeLong  = longIsDex  ? VENUE_FEE_PCT.dex : VENUE_FEE_PCT.cex;
  return (feeShort + feeLong) * 2; // open + close each side
}

/**
 * Net APY if position is held for 30 days.
 * grossApy and totalFeesPct both in % (same unit).
 */
function netApy30d(grossApy, totalFeesPct) {
  return +(grossApy - totalFeesPct * (365 / 30)).toFixed(2);
}

/**
 * Days until fees are recovered at the current annualized rate.
 * Returns Infinity when grossApy === 0.
 */
function breakevenDays(grossApy, totalFeesPct) {
  if (grossApy <= 0) return Infinity;
  return +(totalFeesPct * 365 / grossApy).toFixed(1);
}

/**
 * Status label based on breakeven days.
 * MARGINAL: >10 d to recover fees — rate is likely to shift first
 * CAUTION:  >5 d
 * HARVEST:  ≤5 d — meaningful edge at current rate
 */
function spreadStatus(beDays) {
  if (!isFinite(beDays) || beDays > 10) return 'MARGINAL';
  if (beDays > 5)                        return 'CAUTION';
  return 'HARVEST';
}

// ── Perp-vs-Spot (delta-neutral) carry estimator ─────────────────────────────
// The trade: BUY spot + SHORT the perp on the best venue, collecting the FULL
// absolute funding rate every settlement (shorts collect when funding is positive).
// This is NOT a perp-vs-perp spread — there is exactly one funding leg (the short
// perp), plus a delta-neutral spot hedge that pays no funding.
//
// Annual cap is a RUN-RATE, not a promise: funding is current, not guaranteed, and
// can flip negative (then you PAY). Net $/day is the primary honest figure; the
// annualized number is capped and demoted downstream.
const PERP_SPOT_ANNUAL_CAP = 200;   // %/yr display cap ("run-rate, not guaranteed")

/**
 * roundTripPerpSpotPct — one-time fee (%) to OPEN then CLOSE both legs of the
 * perp-spot trade, as a percent of one leg's notional (capitalPerLeg).
 *
 * NOTE on roundTripFeeByVenue(short, long): that helper is for a TWO-PERP-LEG
 * spread — it returns (venueFeePct(short) + venueFeePct(long)) × 2, reading the
 * PERP fee table for BOTH venues. It is the WRONG primitive here: our second leg
 * is a SPOT position with its own (different) fee schedule, so we compose the two
 * round trips explicitly — perp fee ×2 (open+close) + spot fee ×2 (open+close).
 */
function roundTripPerpSpotPct(shortVenue, spotVenue) {
  const perpRT = venueFeePct(shortVenue) * 2;      // open + close the short perp
  const spotRT = spotVenueFeePct(spotVenue) * 2;   // buy + sell the spot hedge
  return perpRT + spotRT;
}

/**
 * estimatePerpSpot({ capitalPerLeg, fundingPct8h, shortVenue, spotVenue,
 *                    trailingPositiveSettlements })
 *
 * @param {number} capitalPerLeg  USD deployed per leg (spot value == perp notional).
 * @param {number} fundingPct8h   Current funding NORMALIZED to %/8h, stored ×100 (a
 *                                 PERCENT — e.g. 0.011 means 0.011%, NOT 1.1%). The
 *                                 ×100 trap: divide by 100 before using as a fraction.
 * @param {string} shortVenue     Perp venue we short on (fee via venueFeePct).
 * @param {string} spotVenue      Spot venue we buy on (fee via spotVenueFeePct).
 * @param {number} [trailingPositiveSettlements] Real consecutive-positive count.
 * @returns {object} honest per-trade math (all $ scale linearly with capitalPerLeg).
 */
function estimatePerpSpot(input) {
  const capitalPerLeg = Number(input && input.capitalPerLeg) || 0;
  const fundingPct8h  = Number(input && input.fundingPct8h)  || 0;
  const shortVenue    = input && input.shortVenue;
  const spotVenue     = input && input.spotVenue;
  const trailing      = Number(input && input.trailingPositiveSettlements) || 0;

  // ×100 trap: fundingPct8h is a PERCENT → /100 for the fraction. Three 8h periods/day.
  const fundingFractionPerDay = (fundingPct8h / 100) * 3;
  const grossPctPerDayNotional = fundingFractionPerDay * 100;          // %/day on notional
  const grossPerDay = capitalPerLeg * fundingFractionPerDay;           // $ collected/day

  const perpFeePct = venueFeePct(shortVenue);                          // per-leg %
  const spotFeePct = spotVenueFeePct(spotVenue);                       // per-leg %
  const feesOneTimePct = roundTripPerpSpotPct(shortVenue, spotVenue);  // % of capitalPerLeg
  const feesOneTime    = capitalPerLeg * feesOneTimePct / 100;         // $ (both legs, round trip)

  const breakevenDaysVal = grossPerDay > 0 ? feesOneTime / grossPerDay : Infinity;

  // Amortize the one-time fee over a 30-day hold (stated in the UI): shorter holds
  // recover less of the fee, longer holds more. Fees are paid ONCE; funding accrues
  // every settlement.
  const netPerDayAmortized30 = grossPerDay - feesOneTime / 30;

  // Annualized RUN-RATE on notional (capped, demoted downstream, "not guaranteed").
  const annualizedRunRateRaw = grossPctPerDayNotional * 365;
  const annualizedCapped     = annualizedRunRateRaw > PERP_SPOT_ANNUAL_CAP;
  const annualizedRunRatePct = Math.min(annualizedRunRateRaw, PERP_SPOT_ANNUAL_CAP);

  // Conservative 1× — the spot leg needs full capital; the perp margin COULD be less
  // with leverage, but we quote 1× (full margin) so capitalNeeded is honest, not rosy.
  const capitalNeeded = 2 * capitalPerLeg;

  // Honest ROI on TOTAL capital actually deployed (both legs), net of amortized fees.
  const netAnnualizedOnCapitalPct = capitalNeeded > 0
    ? (netPerDayAmortized30 * 365) / capitalNeeded * 100
    : 0;

  return {
    capitalPerLeg,
    capitalNeeded,
    fundingFractionPerDay,
    grossPctPerDayNotional:  +grossPctPerDayNotional.toFixed(6),
    grossPerDay:             +grossPerDay.toFixed(4),
    perpFeePct,
    spotFeePct,
    feesOneTimePct:          +feesOneTimePct.toFixed(4),
    feesOneTime:             +feesOneTime.toFixed(4),
    breakevenDays:           isFinite(breakevenDaysVal) ? +breakevenDaysVal.toFixed(1) : Infinity,
    netPerDayAmortized30:    +netPerDayAmortized30.toFixed(4),
    annualizedRunRatePct:    +annualizedRunRatePct.toFixed(2),
    annualizedCapped,
    netAnnualizedOnCapitalPct: +netAnnualizedOnCapitalPct.toFixed(2),
    trailingPositiveSettlements: trailing,
    // few settlements of positive history → higher chance the sign flips soon.
    flipRisk: trailing < 3,
  };
}

module.exports = {
  HOURS_PER_YEAR,
  VENUE_FEE_PCT,
  SPOT_FEE_PCT,
  USDC_M_FEE_PCT,
  PERP_SPOT_ANNUAL_CAP,
  annualize,
  venueFeePct,
  spotVenueFeePct,
  usdcVenueFeePct,
  roundTripFee,
  roundTripFeeByVenue,
  roundTripPerpSpotPct,
  estimatePerpSpot,
  netApy30d,
  breakevenDays,
  spreadStatus,
};
