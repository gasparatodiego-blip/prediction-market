'use strict';

// Single source of truth for prediction-market arb ROI math.
// Both the discovery matcher (matcher-v2.js) and the live re-pricer (agent23)
// import from here so their numbers can never diverge.
//
// FEE MODEL — CLOB v2, honest-engine (see lib/polymarket-fees.js for the ground truth):
//   Both arb legs are TAKER (buy YES at ask on one venue, buy NO at bid on the other), so BOTH pay a
//   TAKER fee. The fee is an ABSOLUTE cost per leg, price-scaled — NOT a flat fraction of winnings:
//       fee_per_$1_payout = feeRate · p · (1 − p)      (p = that leg's execution price)
//   Kalshi's published taker coefficient is 0.07. Polymarket's is per-market and LIVE: base_fee/20000
//   (the caller passes it as `polyFeeRate` from the SSOT; null → the net is UNKNOWN → render "—").
//   The old model — a flat `polymarket: 0.02` "winnings" fee applied as grossROI·(1−feeA−feeB) — was
//   BOTH the wrong figure (no 2% winnings fee exists under v2) AND the wrong shape (fee on winnings, not
//   on the taker trade). Removed entirely: inventing a cost is as dishonest as inventing a gain.

// Kalshi published taker-fee coefficient (fee = 0.07·p·(1−p) per contract). Public, price-scaled.
const KALSHI_FEE_RATE = 0.07;

// Legacy flat table — kept ONLY for non-executable platforms that matcher-v2 still references for
// coarse ranking. The executable venues (kalshi, polymarket) are NO LONGER fee'd from here: their real
// taker fee is applied per-leg in computeArbROI. polymarket's fabricated 0.02 was removed.
const PLATFORM_FEES = {
  kalshi:     0.07,   // reference only; real Kalshi fee is applied price-scaled in computeArbROI
  // DEPRECATED (no caller): as of the fee-SSOT residual cleanup, no code reads PLATFORM_FEES.polymarket —
  // both the discovery matcher (matcher-v2) and the re-pricer (agent23) now net the REAL price-scaled
  // Polymarket taker fee via computeArbROI + lib/polymarket-fees.js (the SSOT). Kept (not deleted) so the
  // table stays complete for any reference/display reader; NEVER use this 0 as a Polymarket fee.
  polymarket: 0.00,
  predictit:  0.15,   // 10% win + 5% withdrawal (non-executable → signal only)
  manifold:   0.00,
  futuur:     0.05,
};

// Per-leg taker feeRate for the price-scaled formula. Kalshi is a known constant; Polymarket is the
// live per-market value the caller injects (base_fee/20000). Returns null when it must be known but
// isn't (a Polymarket leg with no live base_fee) → the caller renders "—", never a guessed number.
function legFeeRate(platform, polyFeeRate) {
  const p = String(platform || '').toLowerCase();
  if (p === 'kalshi') return KALSHI_FEE_RATE;
  if (p === 'polymarket') return polyFeeRate == null ? null : Number(polyFeeRate);
  return 0; // non-executable venues never form the taker legs of a cashable arb
}

// Compute executable bid/ask arb between two YES-outcome legs, net of REAL taker fees on both legs.
// Tries both directions; picks the cheaper entry. `polyFeeRate` = live Polymarket base_fee/20000 for
// whichever leg is Polymarket (or null if unknown).
// Returns:
//   null                         — no positive-gross arb at these prices (not an opportunity)
//   { …, feeUnknown:true, net:null } — arb exists but a required taker fee is UNKNOWN → render "—"
//   { bestCost, bestDir, gross, net, feeUsd } — net of real taker fees; net<=0 → null (fees erase it)
function computeArbROI({ yesAsk_A, yesBid_A, yesAsk_B, yesBid_B, platformA, platformB, polyFeeRate = null }) {
  const aA = Number(yesAsk_A), bA = Number(yesBid_A);
  const aB = Number(yesAsk_B), bB = Number(yesBid_B);
  if (!(aA > 0 && aA < 1) || !(aB > 0 && aB < 1)) return null;

  // dir1: buy YES on A + buy NO on B  (cost = yesAsk_A + (1 − yesBid_B))
  // dir2: buy YES on B + buy NO on A  (cost = yesAsk_B + (1 − yesBid_A))
  const dir1Cost = aA + (1 - bB);
  const dir2Cost = aB + (1 - bA);
  const [bestCost, bestDir] = dir1Cost <= dir2Cost ? [dir1Cost, 1] : [dir2Cost, 2];

  const grossProfit = 1 - bestCost;
  if (grossProfit <= 0) return null;
  const grossROI = (grossProfit / bestCost) * 100;

  // The two TAKER legs for the chosen direction, each at its own execution price.
  //   dir1: YES on A @ aA ; NO on B @ (1−bB)      dir2: YES on B @ aB ; NO on A @ (1−bA)
  const legs = bestDir === 1
    ? [{ platform: platformA, p: aA }, { platform: platformB, p: 1 - bB }]
    : [{ platform: platformB, p: aB }, { platform: platformA, p: 1 - bA }];

  let feeUsd = 0;
  for (const lg of legs) {
    const rate = legFeeRate(lg.platform, polyFeeRate);
    if (rate == null) {
      // A required taker fee is unknown → we CANNOT present a net edge. Honest "—", not a guess.
      return { bestCost: +bestCost.toFixed(4), bestDir, gross: +grossROI.toFixed(2), net: null, feeUnknown: true };
    }
    feeUsd += rate * lg.p * (1 - lg.p); // real taker fee per $1 payout, price-scaled
  }

  const netProfit = grossProfit - feeUsd;
  const netROI = (netProfit / bestCost) * 100;
  if (netROI <= 0) return null; // real fees erase the edge → not a cashable arb

  return {
    bestCost: +bestCost.toFixed(4),
    bestDir,
    gross:    +grossROI.toFixed(2),
    net:      +netROI.toFixed(2),
    feeUsd:   +feeUsd.toFixed(5),
  };
}

// Platforms that expose a real, executable bid/ask order book. A "cashable"
// determination must be gated on this set — mid-price/AMM/last-trade platforms
// (Manifold, PredictIt, Futuur, OddsAPI) can only ever be signal, regardless
// of how large their apparent spread looks.
const EXECUTABLE_PLATFORMS = new Set(['kalshi', 'polymarket']);

module.exports = { PLATFORM_FEES, computeArbROI, EXECUTABLE_PLATFORMS };
