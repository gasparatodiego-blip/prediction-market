'use strict';
// lib/reward-stability.js — a PROVISIONAL, band-relative stability score for the rewards list.
//
// STRUCTURE-ONLY IN THIS TASK. The real stability engine is a separate later task; this reserves the
// column and wires the "Stabilità minima" filter + the stability sort to a REAL field that already
// exists — agent24's measured 24h price-move stdev (volatilityStdev) — rather than a fabricated number.
//
// HONEST DERIVATION (no invented scale): stability is expressed relative to the SAME reward band the
// rest of the page uses. A maker's tail risk is the price wandering OUT of its reward band, so we ask:
// how much of the band half-width does one 24h stdev of price movement consume?
//   halfBandPrice = (maxSpreadCents / 2) / 100           (band half-width, in price units)
//   consumed      = volatilityStdev / halfBandPrice       (fraction of the half-band one stdev covers)
//   score         = 100 · (1 − min(1, consumed))          (100 = flat vs band, 0 = stdev ≥ half-band)
// Both inputs are REAL measured fields. When either is missing (no 24h history, or the free tier has
// them redacted) the score is UNKNOWN → null; the caller renders "—" and a neutral bar, and the
// "Stabilità minima" filter does NOT exclude the row (a not-yet-measured market is never hidden by a
// metric the real engine will later replace). Never a fabricated value.

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * @param {{ volatilityStdev?:number|null, maxSpreadCents?:number|null }} args
 *   volatilityStdev  price-fraction stdev over 24h (agent24 measure24hVolatility) — REAL or null
 *   maxSpreadCents   the market's reward band width in cents — REAL or null
 * @returns {{ known:boolean, score:number|null, stdev:number|null, consumedBandPct:number|null }}
 */
function computeStability({ volatilityStdev, maxSpreadCents } = {}) {
  const stdev = fin(volatilityStdev) && volatilityStdev >= 0 ? volatilityStdev : null;
  const band = fin(maxSpreadCents) && maxSpreadCents > 0 ? maxSpreadCents : null;
  if (stdev == null || band == null) {
    return { known: false, score: null, stdev: stdev, consumedBandPct: null };
  }
  const halfBandPrice = (band / 2) / 100;
  const consumed = halfBandPrice > 0 ? stdev / halfBandPrice : 1;
  const score = Math.round(100 * (1 - Math.min(1, consumed)));
  return { known: true, score, stdev, consumedBandPct: Math.min(100, Math.round(consumed * 100)) };
}

// Convenience: read the two fields straight off a normalized market row.
function stabilityOf(m) {
  return computeStability({
    volatilityStdev: m ? m.volatilityStdev : null,
    maxSpreadCents: m && m.rewardScore ? m.rewardScore.maxSpreadCents : (m ? m.maxSpread : null),
  });
}

module.exports = { computeStability, stabilityOf };
