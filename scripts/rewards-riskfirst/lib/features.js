'use strict';
// scripts/rewards-riskfirst/lib/features.js — PHASE 1: per-market risk features computed from data
// observable BEFORE any fill. Pure. Reuses marketMeta (mid/depth/tick/span) read-only. Replay, not P&L.
// Volatility of adjMid, its stability (quiet-then-jumpy), spread, time-to-resolution, order/depth multiple.

const { marketMeta } = require('../../../lib/rewards/allocator');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function stdev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
function median(a) { const s = a.filter(fin).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; }

// Realised volatility of adjMid: stdev of per-sample changes (~45s), and STABILITY = 2nd-half vol / 1st-half
// vol (>1 ⇒ quiet-then-jumpy, the dangerous shape). Also the max single-sample jump.
function realisedVol(rows) {
  const mids = rows.map((r) => r.adjMid).filter(fin);
  if (mids.length < 4) return { perSample: null, stability: null, maxJump: null };
  const ch = []; for (let i = 1; i < mids.length; i++) ch.push(mids[i] - mids[i - 1]);
  const half = Math.floor(ch.length / 2);
  const sd1 = stdev(ch.slice(0, half)), sd2 = stdev(ch.slice(half));
  return {
    perSample: stdev(ch),
    stability: (fin(sd1) && sd1 > 0 && fin(sd2)) ? sd2 / sd1 : null,
    maxJump: ch.reduce((m, x) => Math.max(m, Math.abs(x)), 0),
  };
}

function spreadStats(rows) {
  const sp = rows.map((r) => (fin(r.bestAsk) && fin(r.bestBid)) ? r.bestAsk - r.bestBid : null).filter(fin);
  return { medianAbs: median(sp), stdevAbs: sp.length >= 2 ? stdev(sp) : null };
}

/**
 * Full pre-fill feature vector for one market. `refSizeUsd` sizes the order/depth multiple (the single most
 * direct fill proxy). A missing input renders null → the caller EXCLUDES + COUNTS the market, never defaults.
 */
function marketFeatures(marketId, rows, meta, nowMs, refSizeUsd = 250) {
  const mm = marketMeta(rows);
  const vol = realisedVol(rows);
  const sp = spreadStats(rows);
  const price = fin(mm.mid) ? clampPrice(mm.mid) : null;
  const orderShares = price ? refSizeUsd / price : null;
  const endMs = meta && meta.endDate ? Date.parse(meta.endDate) : null;
  return {
    marketId, mid: mm.mid, depthShares: mm.depthShares, tick: mm.tick, spanHours: mm.spanHours,
    volPerSample: vol.perSample, volStability: vol.stability, maxJump: vol.maxJump,
    ttrDays: fin(endMs) ? (endMs - nowMs) / 86_400_000 : null,
    spreadCents: fin(sp.medianAbs) ? sp.medianAbs * 100 : null,
    spreadTicks: (fin(sp.medianAbs) && fin(mm.tick) && mm.tick > 0) ? sp.medianAbs / mm.tick : null,
    spreadStdevCents: fin(sp.stdevAbs) ? sp.stdevAbs * 100 : null,
    orderShares, orderVsDepth: (fin(orderShares) && fin(mm.depthShares) && mm.depthShares > 0) ? orderShares / mm.depthShares : null,
    category: meta ? meta.category ?? null : null,
    pot: meta ? meta.pot ?? null : null,
    maxSpreadCents: meta ? meta.maxSpread ?? null : null,
  };
}

// Time-to-resolution buckets across a set of feature rows: <15d, 15–90d, >90d, and unknown (counted).
function ttrBuckets(features) {
  const b = { under15: 0, from15to90: 0, over90: 0, unknown: 0 };
  for (const f of features) {
    if (!fin(f.ttrDays)) { b.unknown++; continue; }
    if (f.ttrDays < 15) b.under15++; else if (f.ttrDays <= 90) b.from15to90++; else b.over90++;
  }
  return b;
}

// Distribution (min/p25/median/p75/max + null count) of one numeric feature across rows.
function distribution(features, key) {
  const xs = features.map((f) => f[key]).filter(fin).sort((p, q) => p - q);
  const nulls = features.length - xs.length;
  const q = (p) => (xs.length ? xs[Math.max(0, Math.min(xs.length - 1, Math.floor(p * (xs.length - 1))))] : null);
  return { n: xs.length, nulls, min: xs[0] ?? null, p25: q(0.25), median: q(0.5), p75: q(0.75), max: xs[xs.length - 1] ?? null };
}

module.exports = { marketFeatures, ttrBuckets, distribution, realisedVol, spreadStats, stdev, median };
