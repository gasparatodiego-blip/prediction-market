'use strict';
// scripts/rewards-replay/lib/markout-by-market.js — MARKOUT distribution BY PERCENTILE and BY MARKET.
//
// The base replay reports one blended markout distribution (buy/sell/all, quartiles + p05/p95). A mean of
// −0.31c with a median of +0.00c means the cost lives in a TAIL, not spread evenly — so this module adds:
//   • the WORST DECILE (mean of the most-adverse 10% of fills), bid-side and ask-side separately, and
//   • a PER-MARKET join of markout cost against the gross reward that market earns, so we can answer the
//     REWARDS-CEILING question: are the markets with the worst markout the SAME markets carrying the most
//     gross reward? and
//   • the FILL CONCENTRATION across markets (HHI + how many markets carry 80% of the 395 fills), so a
//     result driven by a handful of markets is labelled as such.
// Pure/deterministic; reuses distribution() from markout.js. Nulls excluded and counted, never defaulted.

const { distribution } = require('./markout');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Mean of the most-adverse (lowest) ceil(10%) of the values, and the decile threshold. null if empty. */
function worstDecile(xs) {
  const a = xs.filter(fin).sort((p, q) => p - q);
  if (!a.length) return null;
  const k = Math.max(1, Math.ceil(a.length * 0.10));
  const bottom = a.slice(0, k);
  return { n: k, mean: bottom.reduce((s, x) => s + x, 0) / k, threshold: a[k - 1] };
}

/** Per-side (buy/sell/all) distribution at one horizon, in cents and usd, WITH the worst decile. */
function sideDistributions(markouts, horizonKey = '5m') {
  const out = {};
  for (const side of ['buy', 'sell', 'all']) {
    const set = side === 'all' ? markouts : markouts.filter((m) => m.side === side);
    const cents = set.map((m) => (m.horizons[horizonKey] ? m.horizons[horizonKey].cents : null));
    const usd = set.map((m) => (m.horizons[horizonKey] ? m.horizons[horizonKey].usd : null));
    out[side] = {
      fills: set.length,
      cents: { ...distribution(cents), worstDecile: worstDecile(cents) },
      usd: { ...distribution(usd), worstDecile: worstDecile(usd) },
    };
  }
  return out;
}

/**
 * Per-market join of markout (cost) against gross reward. `netRows` is computeNet().rows (has grossWindow,
 * netWindow). Returns one row per market that had fills, sorted worst-markout-first by default.
 */
function byMarketMarkout(markouts, netRows, horizonKey = '5m') {
  const grossByMkt = new Map((netRows || []).map((r) => [r.marketId, r]));
  const moByMkt = new Map();
  for (const m of markouts) { if (!moByMkt.has(m.marketId)) moByMkt.set(m.marketId, []); moByMkt.get(m.marketId).push(m); }
  const rows = [];
  for (const [marketId, mos] of moByMkt.entries()) {
    const cents = mos.map((m) => (m.horizons[horizonKey] ? m.horizons[horizonKey].cents : null)).filter(fin);
    const usd = mos.map((m) => (m.horizons[horizonKey] ? m.horizons[horizonKey].usd : null)).filter(fin);
    const nr = grossByMkt.get(marketId);
    const sumUsd = usd.reduce((s, x) => s + x, 0); // negative = adverse
    rows.push({
      marketId,
      fills: mos.length,
      buyFills: mos.filter((m) => m.side === 'buy').length,
      sellFills: mos.filter((m) => m.side === 'sell').length,
      meanCents: cents.length ? cents.reduce((s, x) => s + x, 0) / cents.length : null,
      worstDecileCents: worstDecile(cents),
      costUsd: -sumUsd,                         // positive when the fills lost money
      gross: nr ? nr.grossWindow : null,        // gross reward this market earns over the window
      net5m: nr ? nr.netWindow[horizonKey] : null,
    });
  }
  rows.sort((a, b) => (a.meanCents == null ? 1 : b.meanCents == null ? -1 : a.meanCents - b.meanCents));
  return rows;
}

/**
 * Rank-correlation-ish answer to "worst markout == most gross?": Spearman rank correlation between
 * markout-cost rank and gross rank across markets. +1 => the worst-markout markets are exactly the
 * biggest-gross markets (the REWARDS-CEILING failure mode); ~0 => unrelated; −1 => inverse.
 */
function costGrossRankCorr(rows) {
  const withBoth = rows.filter((r) => fin(r.costUsd) && fin(r.gross));
  const n = withBoth.length;
  if (n < 3) return null;
  const rank = (key) => {
    const idx = withBoth.map((r, i) => [r[key], i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[idx[i][1]] = i + 1;
    return ranks;
  };
  const rc = rank('costUsd'), rg = rank('gross');
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rc[i] - rg[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/** Fill concentration across markets: HHI, top-5 share, and how many markets carry 80% of all fills. */
function fillConcentration(rows) {
  const counts = rows.map((r) => r.fills).filter((x) => x > 0).sort((a, b) => b - a);
  const total = counts.reduce((s, x) => s + x, 0);
  if (!total) return { totalFills: 0, marketsWithFills: 0, hhi: 0, top1Share: 0, top5Share: 0, marketsFor80pct: 0 };
  const hhi = counts.reduce((s, x) => s + (x / total) ** 2, 0);
  let cum = 0, k = 0; for (const c of counts) { cum += c; k++; if (cum >= 0.8 * total) break; }
  return {
    totalFills: total,
    marketsWithFills: counts.length,
    hhi,
    top1Share: counts[0] / total,
    top5Share: counts.slice(0, 5).reduce((s, x) => s + x, 0) / total,
    marketsFor80pct: k,
  };
}

module.exports = { worstDecile, sideDistributions, byMarketMarkout, costGrossRankCorr, fillConcentration };
