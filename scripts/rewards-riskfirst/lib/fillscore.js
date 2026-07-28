'use strict';
// scripts/rewards-riskfirst/lib/fillscore.js — CONSTRAINT 2: a fill-likelihood score built from STRUCTURAL
// reasoning, NOT fitted to the 11 observed fills (fitting to n=11 would be worthless while looking rigorous).
//
// REASONING (higher score ⇒ more likely to be filled, and more likely adverse):
//   • order/depth ratio HIGH  → our resting order is a large fraction of the book, so a taker that appears
//     is more likely to hit US, and the fill moves the price against us (the 117× row is the extreme).
//   • realised vol HIGH       → the mid crosses our resting order more often.
//   • spread NARROW           → the touch sits close to mid, so an order a fixed offset from mid is nearer
//     the touch and more exposed.
// The score is the equal-weight mean of the three PERCENTILE ranks — no coefficients are tuned, so nothing is
// fitted. A market missing any of the three features scores null (excluded and counted, never defaulted).

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// percentile rank of each finite value within the array (0..1); non-finite → null (excluded).
function percentiles(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => fin(v)).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(null);
  const denom = Math.max(1, idx.length - 1);
  idx.forEach(([, i], rank) => { out[i] = rank / denom; });
  return out;
}

/**
 * Add a structural fillScore ∈ [0,1] to each feature row. Higher ⇒ more fill-likely. Components use the
 * universe's percentile ranks so the score is scale-free and coefficient-free.
 */
function computeFillScores(features) {
  const pDepth = percentiles(features.map((f) => f.orderVsDepth));           // high = risky
  const pVol = percentiles(features.map((f) => f.volPerSample));             // high = risky
  const pNarrow = percentiles(features.map((f) => (fin(f.spreadTicks) && f.spreadTicks > 0 ? 1 / f.spreadTicks : null))); // narrow = risky
  return features.map((f, i) => {
    const parts = [pDepth[i], pVol[i], pNarrow[i]];
    const missing = parts.filter((p) => p == null).length;
    const score = missing ? null : (parts[0] + parts[1] + parts[2]) / 3; // any missing → "—", excluded+counted
    return { ...f, fillScore: score, scoreParts: { depth: pDepth[i], vol: pVol[i], narrow: pNarrow[i] } };
  });
}

/**
 * AUC of the score at separating FILLED from UNFILLED markets: P(a random filled market outranks a random
 * unfilled one), ties = 0.5. 0.5 = no discrimination. Only markets with a computable score are used.
 */
function auc(scoredFeatures, filledSet) {
  const withScore = scoredFeatures.filter((f) => fin(f.fillScore));
  const filled = withScore.filter((f) => filledSet.has(f.marketId));
  const unfilled = withScore.filter((f) => !filledSet.has(f.marketId));
  if (!filled.length || !unfilled.length) return { auc: null, se: null, ci95: null, nFilled: filled.length, nUnfilled: unfilled.length, pairs: 0 };
  let wins = 0;
  for (const a of filled) for (const b of unfilled) wins += a.fillScore > b.fillScore ? 1 : (a.fillScore === b.fillScore ? 0.5 : 0);
  const pairs = filled.length * unfilled.length;
  const A = wins / pairs;
  return { auc: A, ...aucSE(A, filled.length, unfilled.length), nFilled: filled.length, nUnfilled: unfilled.length, pairs };
}

/** Hanley–McNeil standard error of the AUC + a 95% normal interval. Honest confidence for the sample size. */
function aucSE(A, nF, nU) {
  if (!(nF > 0 && nU > 0)) return { se: null, ci95: null };
  const Q1 = A / (2 - A), Q2 = 2 * A * A / (1 + A);
  const varA = (A * (1 - A) + (nF - 1) * (Q1 - A * A) + (nU - 1) * (Q2 - A * A)) / (nF * nU);
  const se = Math.sqrt(Math.max(0, varA));
  return { se, ci95: [Math.max(0, A - 1.96 * se), Math.min(1, A + 1.96 * se)] };
}

module.exports = { computeFillScores, auc, aucSE, percentiles };
