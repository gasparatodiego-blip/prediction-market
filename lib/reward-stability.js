'use strict';
// lib/reward-stability.js — the STABILITY engine for the liquidity-rewards list.
//
// WHAT IT ANSWERS
//   "How rarely would resting two-sided liquidity here get run over?" — i.e. how still has this
//   market's price actually been, relative to the reward band a maker has to quote inside.
//
// TWO AXES, NEVER MIXED
//   Stability = how STILL the price has been (this file).
//   Expiry    = how LONG the market stays relevant (a SEPARATE column the list already shows).
//   Expiry is deliberately NOT folded into the score. A market 3 days from resolution and one 2
//   years out can both be equally still today; conflating them would hide which fact is which.
//   The caveat line in the UI tells the reader to read the two columns together.
//
// THE SCORE (band-relative, no invented scale)
//   A maker's tail risk is the price wandering OUT of its reward band, so we ask how much of the
//   band half-width one standard deviation of observed price movement consumes:
//     halfBandPrice = (maxSpreadCents) / 100
//     consumed      = stdev / halfBandPrice
//     score         = 100 · (1 − min(1, consumed))     100 = still vs band, 0 = stdev ≥ half-band
//
// WHY A 7-DAY WINDOW, NOT 24h (measured, 2026-07-24, 116 live Polymarket reward markets)
//   The previous signal read a 24h window at Polymarket `fidelity=120`. `fidelity` is in MINUTES,
//   so that window returned only THIRTEEN price points per market — a sample far too coarse to
//   call a market still. It declared 34 of 116 markets perfectly flat (score 100). Re-measured
//   over 7 days at fidelity=60 (169 points), 24 of those 34 demonstrably moved:
//     "Harry Kane 2026 Ballon d'Or"      24h→100   7d→0    (moved 30.2c, band 4.5c)
//     "Jerri Green 2026 TN Governor"     24h→100   7d→0    (moved 10.5c, band 4.5c)
//     "Mercedes 2026 F1 Constructors"    24h→100   7d→23   (moved  8.0c, band 4.5c)
//   A market that moves six times its whole reward band in a week is not "stable"; the 24h window
//   simply could not see it. 7d/fidelity=60 is one HTTP call, 102–169 points, same rate budget.
//
// THE FALSE POSITIVE THIS KILLS: ILLIQUIDITY IS NOT CALM
//   A price series that never moves because NOBODY TRADED is not evidence of stability — it is
//   absence of evidence. Such a market must read UNKNOWN ("—"), never a high score. Measured on
//   the same 116: 10 markets were still flat over the full 7 days, and they were exactly the ones
//   with no trade flow — 5 of them are markets for which Polymarket's Gamma feed OMITS the
//   `volume24hr` key entirely (e.g. "Republicans win the Oregon Senate race": $626 of book, key
//   absent, price unchanged for 7 days, and it scored a perfect 100 under the old signal).
//   NOTE the trap: an absent `volume24hr` is ABSENT, not zero. It must be read as missing evidence
//   (→ UNKNOWN), never coerced to 0 and never imputed.
//
// EVERY INPUT IS MEASURED. If any required one is missing the answer is UNKNOWN → score null →
// the cell renders "—". We never impute, never substitute a default, never guess a window.

const { depthFloorUsd } = require('./reward-depth-floor');

// Minimum price observations before a dispersion estimate means anything. At the shipped window
// (7d / fidelity=60) a fully-listed market yields 169; 48 is two days of hourly observations, so a
// recently-listed market can still qualify while a 13-point sample (the old signal) cannot.
const MIN_SAMPLES = 48;

// Label cut-points on the 0–100 band-relative score. Presentation only — the score is the number.
const LABEL_STILL_MIN  = 70;   // "fermo"    — one stdev consumes <30% of the half-band
const LABEL_MEDIUM_MIN = 35;   // "medio"    — 30–65%
                               // "si muove" — ≥65%

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function pos(x) { return fin(x) && x > 0 ? x : null; }

/** The active trade-flow floor: a market must trade at least this multiple of its own daily
 *  reward pool in 24h. Rationale: a market that pays makers more per day than it trades is not
 *  being priced by flow — its still price is reward-farming, not calm. Market-relative, so no
 *  absolute dollar constant is invented. Tunable via REWARD_STABILITY_FLOW_MULT. */
function flowMultiple() {
  const raw = process.env.REWARD_STABILITY_FLOW_MULT;
  const v = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

function unknown(reason, extra) {
  return Object.assign({
    known: false, score: null, label: null, reason,
    stdev: null, movedCents: null, consumedBandPct: null,
    nPts: null, nDistinct: null, windowHours: null,
    volume24hUsd: null, bookDepthUsd: null,
  }, extra || {});
}

/**
 * @param {object} a
 * @param {number|null} a.stdev          price-fraction stdev over the measured window (REAL)
 * @param {number|null} a.nPts           number of price observations in that window (REAL)
 * @param {number|null} a.nDistinct      distinct observed prices in that window (REAL, disclosed)
 * @param {number|null} a.windowHours    the window the stdev was measured over (REAL)
 * @param {number|null} a.maxSpreadCents the market's reward band width in cents (REAL)
 * @param {number|null} a.volume24hUsd   Gamma volume24hr — ABSENT means missing, never 0 (REAL)
 * @param {number|null} a.dailyPoolUsd   the market's daily reward pool (REAL)
 * @param {number|null} a.bookDepthUsd   in-band qualifying depth (REAL)
 */
function computeStability(a) {
  const {
    stdev, nPts, nDistinct, windowHours, maxSpreadCents,
    volume24hUsd, dailyPoolUsd, bookDepthUsd,
  } = a || {};

  const band = pos(maxSpreadCents);
  if (band == null) return unknown('no-band');

  // Dispersion must be a real measurement. A degenerate "0 because we had <2 samples" is NOT one.
  const sd = fin(stdev) && stdev >= 0 ? stdev : null;
  if (sd == null) return unknown('no-history');

  const n = fin(nPts) ? nPts : null;
  if (n == null || n < MIN_SAMPLES) return unknown('thin-sample', { nPts: n });

  // A price series with a SINGLE distinct value has stdev EXACTLY 0 — a degenerate measurement,
  // indistinguishable from a flat / forward-filled feed. That is absence of evidence of movement, NOT a
  // measured "still" market, so it must read UNKNOWN ("—"), never a perfect 100 — the same logic as the
  // no-trade guard below (a flat series is the price-axis twin of a no-flow series). nDistinct is the
  // disclosed distinct-price count; stdev === 0 ⟺ nDistinct ≤ 1, so guarding on EITHER catches the case
  // (and covers rows where nDistinct was not recorded). A market that moved even one tick has stdev > 0
  // and nDistinct ≥ 2, so a genuinely measured low-volatility market is never suppressed by this.
  if (sd === 0 || (fin(nDistinct) && nDistinct <= 1)) {
    return unknown('single-price', { nPts: n, nDistinct: fin(nDistinct) ? nDistinct : null });
  }

  // Liquidity confirmation — "no trades" must read UNKNOWN, not "calm".
  // Absent key ⇒ missing evidence. Never coerced to 0.
  if (!fin(volume24hUsd)) return unknown('no-trade-data', { nPts: n, bookDepthUsd: fin(bookDepthUsd) ? bookDepthUsd : null });
  const pool = fin(dailyPoolUsd) ? dailyPoolUsd : null;
  if (pool == null) return unknown('no-pool', { nPts: n, volume24hUsd });
  if (volume24hUsd < pool * flowMultiple()) {
    return unknown('no-flow', { nPts: n, volume24hUsd, bookDepthUsd: fin(bookDepthUsd) ? bookDepthUsd : null });
  }

  // Book confirmation — reuse the SHARED depth floor the rest of the page suppresses thin books
  // with, so stability can never call a book "stable" that the list itself treats as noise.
  const depth = fin(bookDepthUsd) ? bookDepthUsd : null;
  if (depth == null || depth < depthFloorUsd()) {
    return unknown('no-book', { nPts: n, volume24hUsd, bookDepthUsd: depth });
  }

  const halfBandPrice = (band / 2) / 100;
  const consumed = halfBandPrice > 0 ? sd / halfBandPrice : 1;
  const score = Math.round(100 * (1 - Math.min(1, consumed)));

  return {
    known: true,
    score,
    label: score >= LABEL_STILL_MIN ? 'fermo' : score >= LABEL_MEDIUM_MIN ? 'medio' : 'si muove',
    reason: null,
    stdev: sd,
    movedCents: Math.round(sd * 100 * 100) / 100,   // one stdev expressed in cents — the plain driver
    consumedBandPct: Math.min(100, Math.round(consumed * 100)),
    nPts: n,
    nDistinct: fin(nDistinct) ? nDistinct : null,
    windowHours: fin(windowHours) ? windowHours : null,
    volume24hUsd,
    bookDepthUsd: depth,
  };
}

/** Read the inputs straight off a normalized market row (lib/rewards-normalize shape). */
function stabilityOf(m) {
  if (!m) return unknown('no-band');
  const s = m.stability || {};
  return computeStability({
    stdev:          s.stdev,
    nPts:           s.nPts,
    nDistinct:      s.nDistinct,
    windowHours:    s.windowHours,
    maxSpreadCents: (m.rewardScore && m.rewardScore.maxSpreadCents) != null ? m.rewardScore.maxSpreadCents : m.maxSpread,
    volume24hUsd:   m.volume24hUsd,
    dailyPoolUsd:   m.dailyPool,
    bookDepthUsd:   m.bookDepthAtBand,
  });
}

module.exports = {
  computeStability, stabilityOf,
  MIN_SAMPLES, LABEL_STILL_MIN, LABEL_MEDIUM_MIN, flowMultiple,
};
