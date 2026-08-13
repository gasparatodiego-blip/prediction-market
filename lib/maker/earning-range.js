'use strict';
// lib/maker/earning-range.js — PURE core for the EARNING-RANGE ADVISORY (Phase 4). Answers the
// operator's question: "where must I stand to earn, and roughly how much?"
//
// It computes NO new reward math — it reuses lib/rewardScore.js (scoreBook / scoreOrder / qMin /
// quadraticUserShare) as the SSOT. What it adds is presentation of the earning envelope from the
// market's REAL band config and the REAL competing depth measured off the live book:
//
//   MEASURED (labelled measured):
//     • band radius v = maxSpread (cents)               — existing SSOT convention (see note below)
//     • min_incentive_size (shares)                       — the market's real config
//     • the offset beyond which a quote earns ~0 = v      — quadratic hits 0 at s ≥ v
//     • competing resting size & its distances from mid   — the live book RIGHT NOW (Q_competitors)
//   ESTIMATED (labelled estimated):
//     • the operator's pool SHARE at candidate offsets    — userQ/(userQ+Q_competitors)
//     • expected $/day at candidate offsets               — share × rewardsDailyRate (first-order)
//
// Anything not computable from data we hold is "—", never invented (e.g. no live book → competing depth
// and share are null, not zero).
//
// NOTE (flagged, not silently assumed): the current reward docs phrase v as "max spread from midpoint
// (in cents)". This project's SSOT (lib/rewardScore.js, extensively formula-verified) uses v =
// maxSpread. We DO NOT change the reward math here (explicit constraint); we compute against the SSOT
// and label v so the discrepancy is visible for empirical verification before any live-min quoting.

const { scoreBook, scoreOrder, quadraticUserShare, qMin } = require('../rewardScore');
const { raggioBandaCents } = require('../banda-premiante');

// Q_competitors from the live book: the ACTUAL resting size × proximity score of everyone else. In
// paper the operator has nothing resting, so the whole book is competition (honest upper bound on
// competition, lower bound on the operator's share). Returns null when the book can't be scored.
function competitorQFromBook(book, maxSpreadC, minSize, fallbackMid) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
  const r = scoreBook({ bids: book.bids, asks: book.asks }, maxSpreadC, minSize, fallbackMid);
  return { Qmin: r.Qmin, Qbids: r.Qbids, Qasks: r.Qasks, mid: r.mid };
}

// Measured competing resting size within the band (shares) + count, per side. Descriptive, not scored.
function measuredCompetingDepth(book, mid, maxSpreadC, minSize) {
  const v = maxSpreadC > 0 ? raggioBandaCents(maxSpreadC) : null;
  const within = (arr) => {
    let size = 0, levels = 0;
    for (const o of arr || []) {
      const price = parseFloat(o.price ?? o.p), sz = parseFloat(o.size ?? o.s);
      if (!(price > 0) || !(sz > 0)) continue;
      if (minSize != null && sz < minSize) continue;
      if (v != null && mid != null && Math.abs(price - mid) * 100 > v) continue;
      size += sz; levels++;
    }
    return { size: +size.toFixed(2), levels };
  };
  return { bidSideInBand: within(book && book.bids), askSideInBand: within(book && book.asks) };
}

/**
 * The earning-range advisory for one market.
 * @param {object} args
 *   book       { bids:[{price,size}], asks:[...] } live book (adjusted-mid source of competition) or null
 *   mid        adjusted mid (0..1)
 *   maxSpreadC band width (cents); radius v = /2
 *   minSize    min_incentive_size (shares)
 *   rewardsDailyRate  the market's daily reward pool ($/day) or null
 *   capitalUsd operator's capital for the $/day headline (per side)
 *   candidateOffsetsC  distances-from-mid to evaluate (defaults span the band)
 * @returns advisory object with measured vs estimated parts and a recommended offset RANGE.
 */
function earningRange({ book, mid, maxSpreadC, minSize, rewardsDailyRate, capitalUsd = 1000, candidateOffsetsC }) {
  const v = maxSpreadC > 0 ? raggioBandaCents(maxSpreadC) : null;
  const comp = competitorQFromBook(book, maxSpreadC, minSize, mid);
  const Qcomp = comp ? comp.Qmin : null;
  const effMid = comp && comp.mid != null ? comp.mid : mid;
  const price = effMid != null ? Math.max(0.01, Math.min(0.99, effMid)) : null;
  const sizeShares = (price != null && capitalUsd > 0) ? capitalUsd / price : null;
  const aboveMin = (sizeShares != null && minSize != null) ? sizeShares >= minSize : null;

  // Candidate offsets across the band: near-mid, quarter, half, three-quarter, edge — plus the caller's.
  const offs = (candidateOffsetsC && candidateOffsetsC.length)
    ? candidateOffsetsC.slice()
    : (v > 0 ? [v * 0.05, v * 0.25, v * 0.5, v * 0.75, v * 0.95, v].map(x => +x.toFixed(3)) : []);

  const points = offs.map(sC => {
    const score = v > 0 ? scoreOrder(sC, v) : null;                 // MEASURED decay S(v,s)
    // ESTIMATED share from the measured competitor Q + the operator's own userQ at this offset.
    const share = (Qcomp != null && sizeShares != null)
      ? quadraticUserShare(Qcomp, effMid, maxSpreadC, minSize, capitalUsd, sC)
      : null;
    const estDailyUsd = (share != null && rewardsDailyRate != null) ? +(share * rewardsDailyRate).toFixed(4) : null;
    return {
      offsetC: +sC.toFixed(3),
      scoreS: score != null ? +score.toFixed(4) : null,            // measured
      estShare: share != null ? +share.toFixed(6) : null,          // estimated
      estDailyUsd,                                                 // estimated
      earnsEffectivelyZero: score != null ? score < 0.02 : null,   // < 2% of ceiling ≈ not worth it
    };
  });

  // Recommended offset RANGE (measured numbers behind it, not a magic number): the widest band [lo,hi]
  // where the estimated $/day is ≥ 60% of the best candidate's — i.e. "you can stand anywhere in here
  // and still capture most of the reward; tighter fills more, wider fills less; beyond hi earns ~0".
  const withUsd = points.filter(p => p.estDailyUsd != null);
  let recommended = null;
  if (withUsd.length) {
    const best = Math.max(...withUsd.map(p => p.estDailyUsd));
    const good = withUsd.filter(p => p.estDailyUsd >= best * 0.6).map(p => p.offsetC);
    recommended = best > 0 && good.length ? { loOffsetC: Math.min(...good), hiOffsetC: Math.max(...good), basis: '≥60% of best-candidate estimated $/day; beyond hi the quadratic decay makes it not worth the fill risk' } : null;
  }

  return {
    measured: {
      bandRadiusC: v != null ? +v.toFixed(3) : null,
      maxSpreadC: maxSpreadC ?? null,
      vLabel: 'v = raggioBandaCents(maxSpread) (project SSOT; docs phrase v as "max spread from midpoint" — verify empirically before live)',
      minSize: minSize ?? null,
      offsetEarnsZeroAtC: v != null ? +v.toFixed(3) : null,        // s ≥ v → S = 0
      competingDepth: measuredCompetingDepth(book, effMid, maxSpreadC, minSize),
      competitorQmin: Qcomp != null ? +Qcomp.toFixed(3) : null,
      mid: effMid ?? null,
    },
    estimated: {
      capitalUsd, sizeShares: sizeShares != null ? +sizeShares.toFixed(2) : null, aboveMin,
      rewardsDailyRate: rewardsDailyRate ?? null,
      byOffset: points,
      recommendedOffsetRange: recommended,
      note: 'share & $/day are ESTIMATES: pool is shared and competitors re-quote continuously; measured parts are band radius, min size and competing depth',
    },
  };
}

module.exports = { earningRange, competitorQFromBook, measuredCompetingDepth };
