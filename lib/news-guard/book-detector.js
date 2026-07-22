'use strict';
// lib/news-guard/book-detector.js — PRIMARY, zero-cost, market-move detector.
//
// Fires on MEASURED order-book dynamics of the very market a maker is quoting. Every threshold is
// derived from the market's OWN recent history (a rolling window), never a hardcoded guess — a
// tight-spread political market and a wide sports market get different baselines automatically.
//
// This module is PURE: it takes the current book sample + the market's rolling history and returns
// a structured result. It reads no files, makes no network calls, and stamps no clock (the caller
// passes `now`). That is what makes it replayable against recorded history with identical logic.
//
// HONEST-ENGINE:
//   • Book alone can reach at most 'medium' (see signal.js severity policy). A single-source book
//     move is "elevated, watch", not "withdraw now" — that escalation needs news corroboration.
//   • Insufficient history → { severity:'low', fired:false, reason:'insufficient-history' }. We do
//     NOT fire on a market we cannot baseline, and we never invent a baseline.
//   • Every trigger carries the measured numbers it fired on (now, baseline, ratio/σ) so the UI and
//     the shadow log can show real evidence, never a bare label.

// A book sample — the fields the rolling history stores per market, per scan. All optional/nullable;
// a missing field simply can't contribute a trigger (never fabricated).
//   mid        — executable mid (0..1 fraction)
//   spread     — best ask − best bid (fraction)
//   depthMin   — the THINNER side's qualifying depth (USD) — one-sided collapse shows here
//   bandDepth  — total depth inside the reward band (USD) — the user's eligible band emptying

// ── Tunables (multipliers on the market's own rolling baseline, + absolute noise floors) ────────
const MIN_SAMPLES   = 6;      // need ≥6 prior samples to trust a baseline; else don't fire
const SPREAD_MULT   = 3.0;    // spread now ≥ 3× rolling-median spread → widening
const SPREAD_SIGMA  = 3.0;    // …or ≥ median + 3σ, whichever is the higher bar
const SPREAD_FLOOR  = 0.01;   // AND at least 1¢ wider than baseline — kills tick-noise on tight books
const MID_SIGMA     = 3.0;    // |mid jump| ≥ 3 rolling σ of mid → jump
const MID_FLOOR     = 0.01;   // AND at least a 1¢ move — kills sub-tick noise when σ≈0
const MID_STD_FLOOR = 0.005;  // floor the rolling σ at ½¢ so a flat-then-1¢-tick market can't read as ∞σ
const SPREAD_STD_FLOOR = 0.002; // same idea for spread σ (reporting only; the ×median bar dominates)
const DEPTH_COLLAPSE_FRAC = 0.25;  // thinner side ≤ 25% of its rolling-median depth → one-sided collapse
const BAND_EMPTY_FRAC     = 0.20;  // band depth ≤ 20% of its rolling-median → eligible band emptied

// ── small stats helpers (no deps) ───────────────────────────────────────────────
function median(xs) {
  const a = xs.filter(x => typeof x === 'number' && isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function stdev(xs) {
  const a = xs.filter(x => typeof x === 'number' && isFinite(x));
  if (a.length < 2) return null;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}
const round = (x, d = 4) => (typeof x === 'number' && isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/**
 * Detect a book-driven market move.
 *
 * @param {object}   current  the latest sample: { mid, spread, depthMin, bandDepth }
 * @param {object[]} history  prior samples (oldest→newest), each { t, mid, spread, depthMin, bandDepth }.
 *                            The CURRENT sample must NOT be included — history is the baseline.
 * @returns {{ severity:'low'|'medium', fired:boolean, reason?:string,
 *             triggers:Array, window:{samples:number, spanMs:number|null} }}
 */
function detectBookMove(current, history) {
  const hist = Array.isArray(history) ? history : [];
  const spanMs = hist.length >= 2 ? (hist[hist.length - 1].t - hist[0].t) : null;
  const window = { samples: hist.length, spanMs };

  if (hist.length < MIN_SAMPLES) {
    return { severity: 'low', fired: false, reason: 'insufficient-history', triggers: [], window };
  }

  const triggers = [];

  // ── spread widening beyond the rolling baseline ───────────────────────────────
  if (typeof current.spread === 'number' && isFinite(current.spread)) {
    const hs = hist.map(h => h.spread);
    const med = median(hs);
    const sd  = stdev(hs);
    if (med != null) {
      const effSd = Math.max(sd != null ? sd : 0, SPREAD_STD_FLOOR);
      const bar = Math.max(med * SPREAD_MULT, med + SPREAD_SIGMA * effSd);
      if (current.spread >= bar && current.spread - med >= SPREAD_FLOOR) {
        triggers.push({
          type: 'spread-widening',
          spreadNow: round(current.spread), baselineSpread: round(med),
          ratio: med > 0 ? round(current.spread / med, 2) : null,
          sigmas: round((current.spread - med) / effSd, 2),
        });
      }
    }
  }

  // ── mid jump beyond N rolling standard deviations ─────────────────────────────
  if (typeof current.mid === 'number' && isFinite(current.mid)) {
    const hm = hist.map(h => h.mid);
    const last = hm[hm.length - 1];
    const sd = stdev(hm);
    if (typeof last === 'number' && isFinite(last) && sd != null) {
      const delta = Math.abs(current.mid - last);
      const effSd = Math.max(sd, MID_STD_FLOOR);   // ½¢ noise floor → σ stays meaningful on flat books
      if (delta >= MID_SIGMA * effSd && delta >= MID_FLOOR) {
        triggers.push({
          type: 'mid-jump',
          midNow: round(current.mid), midPrev: round(last),
          deltaMid: round(delta), rollingStd: round(sd), sigmas: round(delta / effSd, 2),
        });
      }
    }
  }

  // ── one-sided depth collapse (thinner side falls off vs its own baseline) ──────
  if (typeof current.depthMin === 'number' && isFinite(current.depthMin)) {
    const hd = hist.map(h => h.depthMin);
    const med = median(hd);
    if (med != null && med > 0 && current.depthMin <= med * DEPTH_COLLAPSE_FRAC) {
      triggers.push({
        type: 'one-sided-depth-collapse',
        depthMinNow: round(current.depthMin, 0), baselineDepthMin: round(med, 0),
        fracOfBaseline: round(current.depthMin / med, 3),
      });
    }
  }

  // ── the maker's eligible band emptying out ────────────────────────────────────
  if (typeof current.bandDepth === 'number' && isFinite(current.bandDepth)) {
    const hb = hist.map(h => h.bandDepth);
    const med = median(hb);
    if (med != null && med > 0 && current.bandDepth <= med * BAND_EMPTY_FRAC) {
      triggers.push({
        type: 'band-emptied',
        bandDepthNow: round(current.bandDepth, 0), baselineBandDepth: round(med, 0),
        fracOfBaseline: round(current.bandDepth / med, 3),
      });
    }
  }

  // Book alone caps at 'medium' by policy (signal.js does the cross-source escalation to high).
  const fired = triggers.length > 0;
  return { severity: fired ? 'medium' : 'low', fired, triggers, window };
}

module.exports = {
  detectBookMove,
  // exported so the replay tool and tests use the SAME thresholds this fires on
  THRESHOLDS: {
    MIN_SAMPLES, SPREAD_MULT, SPREAD_SIGMA, SPREAD_FLOOR, SPREAD_STD_FLOOR,
    MID_SIGMA, MID_FLOOR, MID_STD_FLOOR, DEPTH_COLLAPSE_FRAC, BAND_EMPTY_FRAC,
  },
  _internal: { median, stdev },
};
