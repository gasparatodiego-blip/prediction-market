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
const { closeNowPolicy } = require('./close-now');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Net for ONE market at ONE per-side size, reusing the shipped gross+cost+net math verbatim. Now that
 * computeNet uses each market's OWN observed window, the allocation objective is the observed-window NET
 * PER DAY (netPerDay5m) — the honest go-forward rate — not a window total scaled to a global window.
 * `excluded` is true when the market has no pot or no scoreable depth (computeNet dropped it).
 * The `windowHours` param is accepted for call-site compatibility but ignored (computeNet uses the span).
 */
function perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, cfg) {
  const { offsetCents, sizeUsd, maxInventoryUsd, policy } = cfg; // policy: 'hold' (default) | 'close-now'
  const fillsRes = reconstructTapeFillsForMarket(marketRows, tokenTrades, { offsetCents, sizeUsd, maxInventoryUsd });
  const one = new Map([[marketId, marketRows]]);
  const MO = markoutAll(fillsRes.fills, one);
  const net = computeNet(one, MO, potByCond, { sizeUsd, wsOnly: false }); // gross + HOLD cost, observed-window
  const row = net.rows[0] || null;
  if (!row) {
    return { marketId, sizeUsd, capital: 2 * sizeUsd, excluded: true, spanHours: null, grossPerDay: null, grossWindow: null, cost5m: null, costPerDay5m: null, netWindow5m: null, netPerDay5m: null, fills: fillsRes.fills.length, share: null, closed: null, stuck: null, nakedRefused: null };
  }
  // HOLD figures come straight from computeNet (+5m markout, floored, observed-window).
  let cost5m = row.costWindow['5m'], costPerDay5m = row.costPerDay['5m'], netWindow5m = row.netWindow['5m'], netPerDay5m = row.netPerDay['5m'];
  let closed = null, stuck = null, nakedRefused = null, noBook = null;
  if (policy === 'close-now') {
    // CLOSE-NOW: cost is the REALISED spread paid crossing the real book at each fill instant (buy fills; sell
    // fills are naked-refused). Certain and ≥0, so net ≤ gross by construction. Amortised over the span.
    const cn = closeNowPolicy(fillsRes.fills, one);
    // Floor the realised spread at ≥0: a fill whose nearest exit-book sample sits above entry books a
    // spurious windfall (sample is up to 40s off the fill instant); a favorable exit is not reward income,
    // so it is not booked — net ≤ gross holds for CLOSE-NOW too (same rule Phase 1 applied to HOLD markout).
    const spread = Math.max(0, cn.aggregate.spreadPaid);
    const spanDays = row.spanHours / 24;
    cost5m = spread;
    costPerDay5m = spanDays > 0 ? spread / spanDays : null;
    netWindow5m = row.grossWindow - spread;
    netPerDay5m = costPerDay5m == null ? null : row.grossPerDay - costPerDay5m;
    closed = cn.aggregate.closed; stuck = cn.aggregate.stuck; nakedRefused = cn.aggregate.nakedRefused; noBook = cn.aggregate.noBook;
  }
  return {
    marketId, sizeUsd, capital: 2 * sizeUsd, excluded: false,
    spanHours: row.spanHours, grossPerDay: row.grossPerDay, grossWindow: row.grossWindow,
    cost5m, costPerDay5m, netWindow5m, netPerDay5m,                         // ← netPerDay5m is the objective
    fills: fillsRes.fills.length, closed, stuck, nakedRefused, noBook, share: row.share,
  };
}

/**
 * Net curve for one market across a per-side size grid. Always includes the zero level (do not fund →
 * capital 0, net 0). The knapsack maximises `net5m`, which HERE carries the observed-window NET PER DAY
 * ($/day) — the go-forward rate. A level whose net-per-day is UNKNOWN (fills but no +5m sample → null) is
 * dropped, never defaulted to 0, so an unfundable-on-unknown-cost size is never chosen.
 * @returns { marketId, excluded, levels:[{ sizeUsd, capital, units, grossPerDay, cost5m, costPerDay5m,
 *            netWindow5m, netPerDay5m, net5m, fills, share, spanHours }] }
 */
function perMarketNetCurve(marketId, marketRows, tokenTrades, potByCond, opts) {
  const { offsetCents, maxInventoryUsd, sizeGrid, unitUsd, policy } = opts;
  const levels = [{ sizeUsd: 0, capital: 0, units: 0, grossPerDay: 0, cost5m: 0, costPerDay5m: 0, netWindow5m: 0, netPerDay5m: 0, net5m: 0, fills: 0, closed: 0, stuck: 0, nakedRefused: 0, share: 0, spanHours: null }];
  let excluded = false;
  for (const s of sizeGrid) {
    const r = perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, { offsetCents, sizeUsd: s, maxInventoryUsd, policy });
    if (r.excluded) { excluded = true; continue; }         // pot/depth missing → unfundable; keep only zero level
    if (r.netPerDay5m == null) continue;                   // cost UNKNOWN at this size → skip (never default to 0)
    levels.push({
      sizeUsd: s, capital: r.capital, units: Math.round(r.capital / unitUsd), spanHours: r.spanHours,
      grossPerDay: r.grossPerDay, cost5m: r.cost5m, costPerDay5m: r.costPerDay5m,
      netWindow5m: r.netWindow5m, netPerDay5m: r.netPerDay5m, net5m: r.netPerDay5m, // net5m := objective (net/day)
      fills: r.fills, closed: r.closed, stuck: r.stuck, nakedRefused: r.nakedRefused, noBook: r.noBook, share: r.share,
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
  const { offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd, policy } = opts;
  const perSideStep = unitUsd / 2;
  const capPerMarket = Math.min(maxPerMarketUsd || budgetUsd, budgetUsd); // a single market may take up to the whole budget
  const maxLevels = Math.max(1, Math.floor(capPerMarket / unitUsd));
  const sizeGrid = [];
  for (let k = 1; k <= maxLevels; k++) sizeGrid.push(k * perSideStep);
  const curves = [];
  for (const [marketId, rows] of byMarket.entries()) {
    const tokenId = marketTokens.get(marketId);
    const trades = (tokenId && tapeByToken.get(tokenId)) || [];
    const c = perMarketNetCurve(marketId, rows, trades, potByCond, { offsetCents, maxInventoryUsd, sizeGrid, unitUsd, policy });
    curves.push(c);
  }
  const budgetUnits = Math.floor(budgetUsd / unitUsd);
  const res = knapsack(curves, budgetUnits); // res.totalNet5m carries Σ net/day (the objective)
  // attach per-day gross/cost aggregates over the chosen allocation (for reporting)
  let grossPerDay = 0, costPerDay5m = 0;
  for (const a of res.allocation) { grossPerDay += fin(a.grossPerDay) ? a.grossPerDay : 0; costPerDay5m += fin(a.costPerDay5m) ? a.costPerDay5m : 0; }
  return { budgetUsd, unitUsd, curves, grossPerDay, costPerDay5m, ...res };
}

module.exports = { perMarketNetAtSize, perMarketNetCurve, knapsack, allocateBudget };
