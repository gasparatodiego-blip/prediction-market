'use strict';
// scripts/rewards-replay/lib/net.js — NET = gross reward while resting − adverse-selection cost (Phase 3).
//
// GROSS reward reuses the ceiling's scoring READ-ONLY (scripts/rewards-ceiling/lib/curve.shareForCapital):
// our pool share = ourSize/(ourSize + competitorQ), our own order in the denominator, capacity bounded by
// the competition. The competition here is the JOURNAL's OBSERVED in-band qualifying depth (the limiting
// side, in shares) — the journal carries the depth-in-band SIZE, not the S-weighted Qmin the live-book
// scoreBook produced, so this gross is a size-pro-rata using real observed depth (stated, not hidden).
// The pot is the REAL published pot (Gamma, via scripts/rewards-ceiling/lib/gamma), matched by conditionId.
//
// COST is the realised adverse selection: the sum of the (signed, negative = loss) markout dollars of the
// fills that resting produced, at each horizon. NET = gross + Σmarkout (so a negative markout REDUCES net).
// Everything is a WINDOW total; annualising is the caller's decision and is REFUSED under 48h.

const { shareForCapital } = require('../../rewards-ceiling/lib/curve');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function median(xs) {
  const a = xs.filter(fin).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor((a.length - 1) / 2);
  return a.length % 2 ? a[m] : (a[m] + a[m + 1]) / 2;
}

/**
 * Per-market gross/cost/net over the window.
 * @param {Map} byMarket    journal rows per market
 * @param {Array} markouts  markoutForFill results (Phase 2)
 * @param {Map} potByCond   conditionId → published daily pot ($)
 * @param {object} cfg       { sizeUsd, windowHours, wsOnly }
 * @returns { rows:[...], aggregate:{...}, excluded:{noPot,noDepth} }
 */
function computeNet(byMarket, markouts, potByCond, cfg) {
  const { sizeUsd, windowHours, wsOnly } = cfg;
  const capitalTotal = 2 * sizeUsd; // both sides
  const windowFrac = windowHours / 24;
  const moByMarket = new Map();
  for (const m of markouts) {
    if (!moByMarket.has(m.marketId)) moByMarket.set(m.marketId, []);
    moByMarket.get(m.marketId).push(m);
  }
  const rows = [];
  const excluded = { noPot: 0, noDepth: 0 };
  for (const [marketId, jrows] of byMarket.entries()) {
    const src = wsOnly ? jrows.filter((r) => r.src === 'ws') : jrows;
    const pot = potByCond.get(marketId);
    if (!fin(pot)) { excluded.noPot++; continue; } // pot unknown → exclude, never default
    // limiting observed in-band depth (shares) = min(bid,ask) per sample, median over the window.
    const limDepth = median(src.map((r) => (fin(r.bidDepthInBand) && fin(r.askDepthInBand)) ? Math.min(r.bidDepthInBand, r.askDepthInBand) : null));
    const mid = median(src.map((r) => r.adjMid));
    if (!fin(limDepth) || !fin(mid)) { excluded.noDepth++; continue; }
    const share = shareForCapital(limDepth, mid, capitalTotal); // ceiling scoring; our size in denominator
    const grossPerDay = pot * share;
    const grossWindow = grossPerDay * windowFrac;
    const mos = moByMarket.get(marketId) || [];
    const costAt = {};
    const netAt = {};
    for (const h of ['1m', '5m', '30m']) {
      const sumMarkout = mos.reduce((s, m) => s + (m.horizons[h] ? m.horizons[h].usd : 0), 0);
      costAt[h] = -sumMarkout;           // positive when the fills lost money
      netAt[h] = grossWindow + sumMarkout; // net over the window
    }
    rows.push({ marketId, pot, share, limDepthShares: limDepth, mid, grossPerDay, grossWindow, fills: mos.length, costWindow: costAt, netWindow: netAt });
  }
  // aggregate
  const agg = { grossWindow: 0, fills: 0, costWindow: { '1m': 0, '5m': 0, '30m': 0 }, netWindow: { '1m': 0, '5m': 0, '30m': 0 }, markets: rows.length };
  for (const r of rows) {
    agg.grossWindow += r.grossWindow; agg.fills += r.fills;
    for (const h of ['1m', '5m', '30m']) { agg.costWindow[h] += r.costWindow[h]; agg.netWindow[h] += r.netWindow[h]; }
  }
  return { rows, aggregate: agg, excluded };
}

module.exports = { computeNet, median };
