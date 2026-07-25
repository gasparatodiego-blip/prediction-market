'use strict';
// scripts/rewards-ceiling/lib/curve.js — the capital-to-share curve, built ON the shipped reward maths.
// We IMPORT lib/rewardScore.js READ-ONLY (scoreBook / adjustedMid / quadraticUserShare) — the same
// published Polymarket quadratic S(v,s)=((v−s)/v)², Qmin two-sided, that agent24 and the board use — so
// this analysis can never diverge from the lane's own scoring. Nothing here is modified in lib/.
//
// CEILING PLACEMENT: to bound the return from ABOVE we assume the most favourable legal placement — an
// order resting AT the mid, s=0 ⇒ S=1 (the maximum score per share). A real order cannot sit exactly at
// mid, so any real placement scores LESS and needs MORE capital for the same share ⇒ our capital is a
// lower bound and our return an upper bound. That is the whole point of a ceiling.

const path = require('path');
const REWARD = require(path.join(__dirname, '..', '..', '..', 'lib', 'rewardScore'));
const { scoreBook, adjustedMid, parseOrders, quadraticUserShare } = REWARD;

function clampPrice(mid) { return Math.max(0.01, Math.min(0.99, mid)); }

/**
 * TOTAL capital (both sides deployed) that must rest in-band to hold share X of a market's pot, at S=1.
 * Derivation (published quadratic, at s=0 ⇒ S=1): your per-side score Qu = size = capital_perSide/price;
 * share = Qu/(Qu+competitorQ). Solve for capital_perSide at target X: price·competitorQ·X/(1−X). A maker
 * must quote BOTH sides to score, so total = 2× that. competitorQ is the live-book Qmin from scoreBook.
 */
function capitalForShare(competitorQ, mid, X) {
  if (!(competitorQ >= 0) || !(mid > 0) || !(X >= 0) || X >= 1) return null;
  const price = clampPrice(mid);
  const perSide = price * competitorQ * (X / (1 - X));
  return 2 * perSide;
}

/** Inverse: the share a TOTAL capital buys at S=1. size = (capital/2)/price; share = size/(size+cQ). */
function shareForCapital(competitorQ, mid, capitalTotal) {
  if (!(competitorQ >= 0) || !(mid > 0) || !(capitalTotal >= 0)) return null;
  const price = clampPrice(mid);
  const size = (capitalTotal / 2) / price;
  const denom = size + competitorQ;
  return denom > 0 ? size / denom : 0;
}

/**
 * Measure a market from its live YES CLOB book: the size-cutoff-adjusted mid, the competitor Qmin (the
 * quadratic denominator — same scoreBook the pipeline uses), and the observed in-band $ depth per side
 * (Σ price×size of qualifying ≥minSize orders within the band). Returns null fields + a reason when the
 * book cannot be scored, so the caller EXCLUDES it (never defaults).
 */
function measureFromBook(book, rewardsMaxSpread, minSize) {
  if (!book || (!Array.isArray(book.bids) && !Array.isArray(book.asks))) return { ok: false, reason: 'no book' };
  const bids = parseOrders(book.bids, true);
  const asks = parseOrders(book.asks, false);
  if (!bids.length && !asks.length) return { ok: false, reason: 'empty book' };
  if (!(rewardsMaxSpread > 0)) return { ok: false, reason: 'no reward band' };
  const mid = adjustedMid(bids, asks, minSize, null);
  if (mid == null) return { ok: false, reason: 'mid unscoreable (no ≥minSize touch)' };
  const qs = scoreBook({ bids, asks }, rewardsMaxSpread, minSize, mid); // { Qbids, Qasks, Qmin, mid }
  const r = (rewardsMaxSpread / 2) / 100;
  const inbandUsd = (arr) => arr.filter((o) => o.size >= minSize && o.price >= mid - r - 1e-12 && o.price <= mid + r + 1e-12)
    .reduce((a, o) => a + o.price * o.size, 0);
  return {
    ok: true,
    mid,
    competitorQ: qs.Qmin,
    qBids: qs.Qbids,
    qAsks: qs.Qasks,
    inbandBidUsd: inbandUsd(bids),
    inbandAskUsd: inbandUsd(asks),
    inbandDepthUsd: inbandUsd(bids) + inbandUsd(asks), // observed qualifying in-band depth, both sides ($)
  };
}

module.exports = { capitalForShare, shareForCapital, measureFromBook, quadraticUserShare, clampPrice };
