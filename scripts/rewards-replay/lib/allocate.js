'use strict';
// scripts/rewards-replay/lib/allocate.js — TOTAL-CAPITAL constraint allocated ACROSS markets.
//
// The base replay (run.js / net.js) scores EACH market independently at a fixed $size/side and then
// annualises against a capital denominator of (markets × 2 × size) — i.e. it silently assumes the operator
// can fund every market at once. With 125 markets at $1000/side that denominator is $250,000; the operator
// actually holds ~$52 in the proxy and the budget under discussion is $5,000. This module answers the real
// question: with ONE shared budget B that must be split across markets (capital resting in market A is not
// available in market B), how much net can it earn, and where should it go.
//
// NO PARALLEL MATH: the per-market gross/cost/net is produced by calling the shipped computeNet() on a
// one-market map, over fills produced by the shipped reconstructTapeFillsForMarket(). This module adds only
// (a) evaluating that same math across a grid of per-side sizes, and (b) a multiple-choice knapsack that
// picks one size per market under the shared budget. Because the reward share s/(s+cQ) is CONCAVE in size,
// the result is NOT the big-denominator result scaled down — that is the whole point, and it is proven
// numerically by the driver.
//
// Capital accounting: "capital committed" in a market = 2 × perSideSize (both sides must rest to score),
// matching net.js's capitalTotal. The budget constrains Σ(2 × perSideSize) over funded markets.

const { reconstructTapeFillsForMarket } = require('./tape');
const { markoutAll } = require('./markout');
const { computeNet } = require('./net');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Net for ONE market at ONE per-side size, reusing the shipped gross+cost+net math verbatim.
 * Returns { marketId, sizeUsd, capital, gross, cost5m, net5m, fills, share, excluded }.
 * `excluded` is true when the market has no pot or no scoreable depth (computeNet dropped it) — such a
 * market cannot be funded and only its zero level is meaningful.
 */
function perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, cfg, windowHours) {
  const { offsetCents, sizeUsd, maxInventoryUsd } = cfg;
  const fillsRes = reconstructTapeFillsForMarket(marketRows, tokenTrades, { offsetCents, sizeUsd, maxInventoryUsd });
  const one = new Map([[marketId, marketRows]]);
  const MO = markoutAll(fillsRes.fills, one);
  const net = computeNet(one, MO, potByCond, { sizeUsd, windowHours, wsOnly: false });
  const row = net.rows[0] || null;
  return {
    marketId,
    sizeUsd,
    capital: 2 * sizeUsd,
    gross: row ? row.grossWindow : null,
    cost5m: row ? row.costWindow['5m'] : null,
    net5m: row ? row.netWindow['5m'] : null,
    fills: fillsRes.fills.length,
    share: row ? row.share : null,
    excluded: !row,
  };
}

/**
 * Net curve for one market across a per-side size grid. Always includes the zero level (do not fund →
 * capital 0, net 0). Levels whose capital is not an exact multiple of `unitUsd` are still returned but the
 * knapsack only consumes those that land on its grid; the driver builds sizeGrid so capital = k·unitUsd.
 * @returns { marketId, excluded, levels:[{ sizeUsd, capital, units, gross, cost5m, net5m, fills, share }] }
 */
function perMarketNetCurve(marketId, marketRows, tokenTrades, potByCond, opts) {
  const { offsetCents, maxInventoryUsd, sizeGrid, windowHours, unitUsd } = opts;
  const levels = [{ sizeUsd: 0, capital: 0, units: 0, gross: 0, cost5m: 0, net5m: 0, fills: 0, share: 0 }];
  let excluded = false;
  for (const s of sizeGrid) {
    const r = perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, { offsetCents, sizeUsd: s, maxInventoryUsd }, windowHours);
    if (r.excluded) { excluded = true; continue; } // pot/depth missing → market unfundable; keep only zero level
    levels.push({
      sizeUsd: s, capital: r.capital, units: Math.round(r.capital / unitUsd),
      gross: r.gross, cost5m: r.cost5m, net5m: r.net5m, fills: r.fills, share: r.share,
    });
  }
  return { marketId, excluded, levels };
}

/**
 * MULTIPLE-CHOICE KNAPSACK — pick exactly one level per market to maximise Σ net5m under a shared budget.
 * Pure and deterministic. `curves` is [{ marketId, levels:[{units, net5m, ...}] }] with a units-0/net-0
 * level present. `budgetUnits` is the budget in the same integer unit as levels[].units.
 *
 * Correctness note: capital spent in one market is subtracted from the budget available to all others —
 * that is exactly what the shared dp[b] table enforces (dp_new[b] = max_L dp_prev[b − L.units] + L.net5m).
 * dp is non-decreasing in b, so dp[budgetUnits] is the global optimum (idle capital is always allowed).
 *
 * @returns { totalNet5m, budgetUnits, usedUnits, marketsHeld, allocation:[{ level..., marketId }] }
 */
function knapsack(curves, budgetUnits) {
  const B = Math.max(0, Math.floor(budgetUnits));
  const M = curves.length;
  let dp = new Float64Array(B + 1);          // dp[b] after processing markets so far
  const choice = Array.from({ length: M }, () => new Int32Array(B + 1)); // chosen level index per (market, budget)
  for (let m = 0; m < M; m++) {
    const levels = curves[m].levels;
    const ndp = new Float64Array(B + 1);
    for (let b = 0; b <= B; b++) {
      let best = -Infinity, bestIdx = 0;
      for (let li = 0; li < levels.length; li++) {
        const L = levels[li];
        const u = L.units | 0;
        if (u > b) continue;
        const val = dp[b - u] + (fin(L.net5m) ? L.net5m : 0);
        if (val > best) { best = val; bestIdx = li; }
      }
      ndp[b] = best === -Infinity ? dp[b] : best;
      choice[m][b] = bestIdx;
    }
    dp = ndp;
  }
  // reconstruct
  const allocation = [];
  let b = B;
  for (let m = M - 1; m >= 0; m--) {
    const li = choice[m][b];
    const L = curves[m].levels[li];
    if (L && (L.units | 0) > 0) {
      allocation.push({ marketId: curves[m].marketId, ...L });
      b -= L.units | 0;
    }
  }
  allocation.reverse();
  const usedUnits = allocation.reduce((s, a) => s + (a.units | 0), 0);
  const totalNet5m = allocation.reduce((s, a) => s + (fin(a.net5m) ? a.net5m : 0), 0);
  return { totalNet5m, budgetUnits: B, usedUnits, marketsHeld: allocation.length, allocation };
}

/**
 * End-to-end: build curves for every market, then knapsack under a dollar budget. `unitUsd` is the capital
 * granularity (dollars of both-sides capital per knapsack unit); the per-side size step is unitUsd/2.
 * @returns { budgetUsd, unitUsd, ...knapsack result, grossWindow, cost5mWindow }
 */
function allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, opts) {
  const { offsetCents, maxInventoryUsd, windowHours, budgetUsd, unitUsd, maxPerMarketUsd } = opts;
  const perSideStep = unitUsd / 2;
  const capPerMarket = Math.min(maxPerMarketUsd || budgetUsd, budgetUsd); // a single market may take up to the whole budget
  const maxLevels = Math.max(1, Math.floor(capPerMarket / unitUsd));
  const sizeGrid = [];
  for (let k = 1; k <= maxLevels; k++) sizeGrid.push(k * perSideStep);
  const curves = [];
  for (const [marketId, rows] of byMarket.entries()) {
    const tokenId = marketTokens.get(marketId);
    const trades = (tokenId && tapeByToken.get(tokenId)) || [];
    const c = perMarketNetCurve(marketId, rows, trades, potByCond, { offsetCents, maxInventoryUsd, sizeGrid, windowHours, unitUsd });
    curves.push(c);
  }
  const budgetUnits = Math.floor(budgetUsd / unitUsd);
  const res = knapsack(curves, budgetUnits);
  // attach gross/cost aggregates over the chosen allocation (for reporting)
  let grossWindow = 0, cost5mWindow = 0;
  for (const a of res.allocation) { grossWindow += fin(a.gross) ? a.gross : 0; cost5mWindow += fin(a.cost5m) ? a.cost5m : 0; }
  return { budgetUsd, unitUsd, curves, grossWindow, cost5mWindow, ...res };
}

module.exports = { perMarketNetAtSize, perMarketNetCurve, knapsack, allocateBudget };
