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
  cex: 0.04,   // Binance / Bybit / OKX typical taker
  dex: 0.025,  // Hyperliquid taker (maker 0%)
};

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
  roundTripFee,
  netApy30d,
  breakevenDays,
  spreadStatus,
};
