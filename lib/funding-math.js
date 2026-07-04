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
};

/** Per-venue taker fee in % per leg. */
function venueFeePct(exchange) {
  if (exchange === 'hyperliquid') return VENUE_FEE_PCT.dex;
  if (exchange === 'dydx')        return VENUE_FEE_PCT.dydx;
  if (exchange === 'aster')       return VENUE_FEE_PCT.aster;
  if (exchange === 'paradex')     return VENUE_FEE_PCT.paradex;
  if (exchange === 'edgex')       return VENUE_FEE_PCT.edgex;
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

module.exports = {
  HOURS_PER_YEAR,
  VENUE_FEE_PCT,
  annualize,
  venueFeePct,
  roundTripFee,
  roundTripFeeByVenue,
  netApy30d,
  breakevenDays,
  spreadStatus,
};
