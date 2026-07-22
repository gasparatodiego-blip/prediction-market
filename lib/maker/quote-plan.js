'use strict';
// lib/maker/quote-plan.js — PURE core (no I/O, no Date, no venue): turn the operator's per-leg config
// into the desired quote set for one market, against the ADJUSTED mid (never the plain mid).
//
// FOUR INDEPENDENT CHANNELS (Phase 3): YES-buy, YES-sell, NO-buy, NO-sell. Each leg is one price level
// on one {book}:{kind}; multiple levels per channel are supported (a ladder). Every leg is independently
// enabled/disabled and independently configured (offset, size, follow|pinned) — reusing the EXISTING
// RewardsLeg shape and the EXISTING legTarget/inBand math (lib/rewards-live-band.js), not a parallel one.
//
// HONEST-ENGINE INVARIANTS:
//   • Quote price is computed from the ADJUSTED mid (dust-filtered), the honest reward mid — never the
//     plain (bestBid+bestAsk)/2.
//   • Every computed target is SNAPPED to the market's real tick (fetched, never assumed) before it can
//     be posted. An off-tick price is rejected by the venue; we snap + record original vs snapped.
//   • A leg below min_incentive_size earns NOTHING. We flag it (belowMinSize) and mark postable=false —
//     it is never emitted as if it would earn. Say so rather than posting silently.
//   • One-sided penalty: if the enabled config is one-sided on the scored book while mid ∈ [0.10,0.90],
//     the score is ÷3 (c=3). We surface oneSidedPenalty BEFORE the operator arms. (Detection uses the
//     existing rewardScore SSOT's book-internal two-sidedness; the exact YES-vs-NO-book mapping is a
//     flagged-unverified reward-doc point — labelled, not silently assumed.)
//   • neverEarns (offset beyond the band radius) is carried through from legStatus — a quote outside the
//     band scores 0 and is marked postable=false.

const { legTarget, inBand, offsetExceedsBand } = require('../rewards-live-band');
const { scoreOrder } = require('../rewardScore');

// Snap a price to the market's tick and clamp to the postable range [tick, 1-tick]. Generic — works for
// any tick (0.1/0.01/0.001/0.0001/0.0025), NOT just powers of ten. Returns null if tick unknown.
function snapToTick(price, tick) {
  if (price == null || !(tick > 0)) return null;
  const dp = (String(tick).split('.')[1] || '').length;
  let snapped = Math.round(price / tick) * tick;
  snapped = Number(snapped.toFixed(dp)); // kill FP dust (0.30000000000000004)
  const lo = Number(tick.toFixed(dp));
  const hi = Number((1 - tick).toFixed(dp));
  if (snapped < lo) snapped = lo;
  if (snapped > hi) snapped = hi;
  return snapped;
}

/**
 * Build the desired quotes for a set of legs on one market.
 * @param {object} args
 *   legs      Array<RewardsLeg-shaped> { book:'yes'|'no', kind:'buy'|'sell', price, mode, offsetC, size?, enabled? }
 *   mid       adjusted mid (0..1) or null
 *   maxSpreadC band width in cents (radius = /2) or null
 *   minSize   min_incentive_size (shares) or null
 *   tick      market tick size or null
 *   tokenId / tokenIdNo  CLOB asset ids for the YES / NO book (null → that book not postable)
 *   defaultSizeShares  fallback size when a leg carries none
 * @returns { quotes:[...], market:{ twoSided, oneSidedPenalty, midInPenaltyRange, ... } }
 */
function planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId, tokenIdNo, defaultSizeShares = 0 }) {
  const bandRadiusC = maxSpreadC > 0 ? maxSpreadC / 2 : null;
  const v = bandRadiusC; // reward-band half-width in cents (existing SSOT convention)
  const quotes = [];

  for (const leg of legs || []) {
    if (leg.enabled === false) continue;
    const side = leg.kind === 'buy' ? 'BUY' : 'SELL';
    const token = leg.book === 'no' ? tokenIdNo : tokenId;
    const rawTarget = legTarget(leg, mid);                 // follow → mid+offsetC/100 ; pinned → literal
    const snapped = rawTarget != null ? snapToTick(rawTarget, tick) : null;
    const legSize = leg.sizeShares != null ? Number(leg.sizeShares) : Number(leg.size);
    const size = legSize > 0 ? legSize : defaultSizeShares;
    const belowMinSize = minSize != null ? size < minSize : null;
    const s_cents = (snapped != null && mid != null) ? Math.abs(snapped - mid) * 100 : null;
    const score = (v > 0 && s_cents != null) ? scoreOrder(s_cents, v) : null;   // S(v,s); 0 outside band
    const inBandNow = snapped != null ? inBand(snapped, mid, maxSpreadC) : null;
    const neverEarns = leg.mode === 'follow' ? offsetExceedsBand(leg.offsetC, maxSpreadC)
      : (snapped != null && maxSpreadC > 0 ? !inBand(snapped, mid, maxSpreadC) : null);
    // Postable ⇔ we have a token + a snapped price + a positive size AND (if known) size ≥ minSize AND
    // the quote is actually in-band (score > 0). Anything else is surfaced, not silently posted.
    const postable = !!token && snapped != null && size > 0 && belowMinSize !== true && (score == null || score > 0);
    quotes.push({
      id: leg.id ?? null, book: leg.book, kind: leg.kind, side, token,
      mode: leg.mode, offsetC: leg.offsetC,
      targetRaw: rawTarget, price: snapped, tickSnappedFrom: (rawTarget != null && snapped != null && Math.abs(rawTarget - snapped) > 1e-9) ? rawTarget : null,
      size, notionalUsd: snapped != null ? +(snapped * size).toFixed(4) : null,
      distanceC: s_cents != null ? +s_cents.toFixed(3) : null,
      score: score != null ? +score.toFixed(4) : null,
      inBandNow, neverEarns, belowMinSize, postable,
      reason: !token ? 'no token id for this book' : snapped == null ? 'no live mid / target' : size <= 0 ? 'size 0' : belowMinSize === true ? `below min_incentive_size (${size} < ${minSize}) — earns nothing` : (score === 0 ? 'outside reward band — scores 0' : 'ok'),
    });
  }

  // Two-sidedness on the SCORED (YES/reward) book: are there postable buy AND sell quotes?
  const yesBuys = quotes.some(q => q.book === 'yes' && q.kind === 'buy' && q.postable);
  const yesSells = quotes.some(q => q.book === 'yes' && q.kind === 'sell' && q.postable);
  const anyPostable = quotes.some(q => q.postable);
  const twoSided = yesBuys && yesSells;
  const midInPenaltyRange = mid != null && mid >= 0.10 && mid <= 0.90;
  // One-sided penalty applies when the scored book is one-sided AND mid ∈ [0.10,0.90] (÷3). Outside that
  // band one-sided earns ZERO (must be two-sided) — a strictly worse case, also surfaced.
  const oneSidedPenalty = anyPostable && !twoSided && midInPenaltyRange;
  const oneSidedZero = anyPostable && !twoSided && mid != null && !midInPenaltyRange;

  return {
    quotes,
    market: {
      mid: mid ?? null, bandRadiusC, minSize: minSize ?? null, tick: tick ?? null,
      twoSided, midInPenaltyRange, oneSidedPenalty, oneSidedZero,
      penaltyNote: oneSidedPenalty ? 'configuration is one-sided on the scored book while mid ∈ [0.10,0.90] → score ÷3 (c=3)'
        : oneSidedZero ? 'configuration is one-sided and mid is in the tails (<0.10 or >0.90) → one-sided earns ZERO (must be two-sided)'
        : null,
      postableCount: quotes.filter(q => q.postable).length,
    },
  };
}

module.exports = { planQuotes, snapToTick };
