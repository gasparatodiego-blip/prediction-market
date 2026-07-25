'use strict';
// scripts/rewards-replay/lib/markout.js — MARKOUT (Phase 2).
// For each synthetic fill, the signed change in adjMid (never plainMid) from the fill instant to +1/+5/
// +30min, in cents and in dollars on the filled size. Signed so ADVERSE SELECTION is NEGATIVE:
//   • BUY  (we are long):  markout = (adjMid_later − adjMid_fill)   — negative if the mid then FELL.
//   • SELL (we are short): markout = (adjMid_fill − adjMid_later)   — negative if the mid then ROSE.
// A horizon with no journal sample within tolerance (e.g. it lies beyond the collected window) is
// EXCLUDED for that fill and counted — never interpolated. Sampling is ~45s, so +1min in particular is
// coarse (nearest sample within one interval); this is reported, not hidden.

const { rowNear } = require('./journal');

const HORIZONS = [
  { key: '1m', ms: 60_000 },
  { key: '5m', ms: 300_000 },
  { key: '30m', ms: 1_800_000 },
];
const TOLERANCE_MS = 40_000; // < one 45s interval — the nearest real sample, never an interpolation

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Markout for ONE fill across the horizons. Returns per-horizon {cents, usd, sampleAgeSec} or null. */
function markoutForFill(fill, marketRows) {
  const out = { side: fill.side, marketId: fill.marketId, ts: fill.ts, sizeShares: fill.sizeShares, inBand: fill.inBand, src: fill.src, horizons: {} };
  if (!fin(fill.adjMidFill)) { out.excludedAll = 'fill adjMid null'; return out; }
  for (const h of HORIZONS) {
    const target = fill.tsMs + h.ms;
    const row = rowNear(marketRows, target, TOLERANCE_MS);
    if (!row || !fin(row.adjMid)) { out.horizons[h.key] = null; continue; } // excluded (beyond window / null)
    const signed = fill.side === 'buy' ? (row.adjMid - fill.adjMidFill) : (fill.adjMidFill - row.adjMid);
    out.horizons[h.key] = {
      cents: signed * 100,
      usd: signed * fill.sizeShares,
      sampleAgeSec: Math.round((row.tsMs - target) / 1000), // signed: how far the used sample is from the exact horizon
    };
  }
  return out;
}

/** Markout for all fills. Needs byMarket to look up horizon samples. */
function markoutAll(fills, byMarket) {
  return fills.map((f) => markoutForFill(f, byMarket.get(f.marketId) || []));
}

// Distribution of a numeric array: n, mean, median, p25, p75, and the tails p05/p95 (adverse selection
// lives in the tail). Returns nulls for an empty set — never a fabricated 0.
function distribution(xs) {
  const a = xs.filter((x) => fin(x)).sort((p, q) => p - q);
  if (!a.length) return { n: 0, mean: null, median: null, p25: null, p75: null, p05: null, p95: null, min: null, max: null, sum: 0 };
  const q = (p) => a[Math.max(0, Math.min(a.length - 1, Math.floor(p * (a.length - 1))))];
  const sum = a.reduce((s, x) => s + x, 0);
  return { n: a.length, mean: sum / a.length, median: q(0.5), p25: q(0.25), p75: q(0.75), p05: q(0.05), p95: q(0.95), min: a[0], max: a[a.length - 1], sum };
}

/** Per-side, per-horizon markout distributions (cents + usd), from an array of markoutForFill results. */
function summarize(markouts) {
  const sides = ['buy', 'sell', 'all'];
  const res = {};
  for (const side of sides) {
    res[side] = {};
    const set = side === 'all' ? markouts : markouts.filter((m) => m.side === side);
    for (const h of HORIZONS) {
      const cents = set.map((m) => m.horizons[h.key] && m.horizons[h.key].cents);
      const usd = set.map((m) => m.horizons[h.key] && m.horizons[h.key].usd);
      res[side][h.key] = { cents: distribution(cents), usd: distribution(usd) };
    }
    res[side].fills = set.length;
  }
  return res;
}

module.exports = { markoutForFill, markoutAll, summarize, distribution, HORIZONS, TOLERANCE_MS };
