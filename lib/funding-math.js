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

/** Per-venue taker fee in % per leg. */
function venueFeePct(exchange) {
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
