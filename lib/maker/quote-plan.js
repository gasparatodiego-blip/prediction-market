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
// The ONE canonical description of a resting order (BUY NO @ q ≡ SELL YES @ 1−q). Two-sidedness and the
// collapse report are computed from THIS, never from the raw leg list.
const { canonicalize, toCanonical, canonicalLabel } = require('./canonical-position');

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
    // EVERY LEG IS PRICED AND JUDGED IN ITS OWN BOOK'S SPACE. A NO-token order at q is a YES order at
    // 1 − q, so the NO book's mid is 1 − mid. Measuring a NO leg's distance against the YES mid put it
    // ~2·mid cents away from where it actually sits: a NO buy one cent off the mid read as 13¢ off,
    // scored 0, and the engine refused to post the operator's ask. The mirror preserves distance, so
    // |price − bookMid| IS the canonical |yesPrice − mid| — same number, computed where it belongs.
    const bookMid = (mid != null && leg.book === 'no') ? +(1 - mid).toFixed(6) : mid;
    const rawTarget = legTarget(leg, bookMid);             // follow → bookMid+offsetC/100 ; pinned → literal
    const snapped = rawTarget != null ? snapToTick(rawTarget, tick) : null;
    const legSize = leg.sizeShares != null ? Number(leg.sizeShares) : Number(leg.size);
    const size = legSize > 0 ? legSize : defaultSizeShares;
    const belowMinSize = minSize != null ? size < minSize : null;
    const s_cents = (snapped != null && bookMid != null) ? Math.abs(snapped - bookMid) * 100 : null;
    const score = (v > 0 && s_cents != null) ? scoreOrder(s_cents, v) : null;   // S(v,s); 0 outside band
    const inBandNow = snapped != null ? inBand(snapped, bookMid, maxSpreadC) : null;
    const neverEarns = leg.mode === 'follow' ? offsetExceedsBand(leg.offsetC, maxSpreadC)
      : (snapped != null && maxSpreadC > 0 ? !inBand(snapped, bookMid, maxSpreadC) : null);
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

  // ── TWO-SIDEDNESS IS A PROPERTY OF THE CANONICAL SET, NOT OF THE RAW LEG LIST ──────────────────────
  // A binary market has ONE book: buying NO at q is selling YES at 1 − q, the same resting order on the
  // same side. Judged on raw legs, the operator's "BUY YES + BUY NO" — a real bid and a real ask — read
  // as one-sided (neither leg is a YES sell) and wrongly took the ÷3 penalty flag. We score the canonical
  // positions instead, and report where two configured legs are in fact one position (never dropping
  // either — the operator configured them and gets to see them).
  const postableQuotes = quotes.filter((q) => q.postable);
  const canon = canonicalize(postableQuotes.map((q) => ({ book: q.book, kind: q.kind, price: q.price, size: q.size, id: q.id })));
  // Stamp each quote with its canonical identity so the UI can name the collapse inline.
  for (const q of quotes) {
    const c = toCanonical({ book: q.book, kind: q.kind, price: q.price });
    q.canonical = c ? { side: c.side, yesPrice: c.yesPrice, key: c.key, label: canonicalLabel(c) } : null;
    q.collapsedWith = c ? (canon.collapsed.find((g) => g.key === c.key) || null) : null;
  }
  const anyPostable = postableQuotes.length > 0;
  const twoSided = canon.twoSided;
  const midInPenaltyRange = mid != null && mid >= 0.10 && mid <= 0.90;
  // One-sided penalty applies when the scored book is one-sided AND mid ∈ [0.10,0.90] (÷3). Outside that
  // band one-sided earns ZERO (must be two-sided) — a strictly worse case, also surfaced.
  const oneSidedPenalty = anyPostable && !twoSided && midInPenaltyRange;
  const oneSidedZero = anyPostable && !twoSided && mid != null && !midInPenaltyRange;

  return {
    quotes,
    market: {
      mid: mid ?? null, bandRadiusC, minSize: minSize ?? null, tick: tick ?? null,
      // The canonical position set the book actually holds, and the groups where more than one
      // configured leg is ONE resting position. Reported, never silently deduplicated away.
      canonicalPositions: canon.positions,
      collapsedGroups: canon.collapsed,
      collapsedNote: canon.collapsed.length
        ? `${canon.collapsed.length} posizione/i risulta/no configurata/e due volte: ${canon.collapsed.map((g) => `${g.label} (${g.legCount} righe)`).join('; ')}. Comprare NO a q è vendere YES a 1−q — è lo stesso ordine sullo stesso lato del book, quindi conta una volta sola nel punteggio ma impegna il capitale di entrambe le righe.`
        : null,
      twoSided, midInPenaltyRange, oneSidedPenalty, oneSidedZero,
      penaltyNote: oneSidedPenalty ? 'configuration is one-sided on the scored book while mid ∈ [0.10,0.90] → score ÷3 (c=3)'
        : oneSidedZero ? 'configuration is one-sided and mid is in the tails (<0.10 or >0.90) → one-sided earns ZERO (must be two-sided)'
        : null,
      postableCount: quotes.filter(q => q.postable).length,
    },
  };
}

module.exports = { planQuotes, snapToTick };
