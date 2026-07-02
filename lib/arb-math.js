'use strict';

// Single source of truth for prediction-market arb fee rates and ROI math.
// Both the discovery matcher (matcher-v2.js) and the live re-pricer (agent23)
// import from here so their numbers can never diverge.

// Flat combined rate (win fee + withdrawal fee) used in net-ROI calculation.
const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.15,   // 10% win + 5% withdrawal
  manifold:   0.00,
  futuur:     0.05,
};

// Compute executable bid/ask arb between two YES-outcome legs.
// Tries both directions; picks the cheaper entry.
// Returns null when no positive net-of-fees arb exists at these prices.
function computeArbROI({ yesAsk_A, yesBid_A, yesAsk_B, yesBid_B, platformA, platformB }) {
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
  const feeA     = PLATFORM_FEES[platformA] ?? 0;
  const feeB     = PLATFORM_FEES[platformB] ?? 0;
  const netROI   = grossROI * (1 - feeA - feeB);
  if (netROI <= 0) return null;

  return {
    bestCost: +bestCost.toFixed(4),
    bestDir,
    gross:    +grossROI.toFixed(2),
    net:      +netROI.toFixed(2),
  };
}

// Platforms that expose a real, executable bid/ask order book. A "cashable"
// determination must be gated on this set — mid-price/AMM/last-trade platforms
// (Manifold, PredictIt, Futuur, OddsAPI) can only ever be signal, regardless
// of how large their apparent spread looks.
const EXECUTABLE_PLATFORMS = new Set(['kalshi', 'polymarket']);

module.exports = { PLATFORM_FEES, computeArbROI, EXECUTABLE_PLATFORMS };
