'use strict';
// scripts/rewards-riskfirst/lib/lexi.js — the LEXICOGRAPHIC allocation. Objectives in strict priority:
//   (1) capital preservation — cap deployed capital so the structural bound ≤ tolerance × budget;
//   (2) fill avoidance — widen the offset (the one MEASURABLE lever; the fill score is only weakly validated);
//   (3) reward — the knapsack maximises it among what survives (1) and (2).
// Reuses the shipped allocator + structural bound read-only. Replay, not P&L; our order enters the depth.

const { allocateBudget } = require('../../../lib/rewards/allocator');
const { reconstructTapeFillsForMarket } = require('../../rewards-replay/lib/tape');
const { structuralTotal } = require('./preserve');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// Expected fills the allocation would have produced over the observed window (at its sizes + offset).
function expectedFills(allocation, D, offsetCents, maxInventoryUsd) {
  let fills = 0;
  for (const a of allocation) {
    const rows = D.byMarket.get(a.marketId) || [];
    const trades = (D.marketTokens.get(a.marketId) && D.tapeByToken.get(D.marketTokens.get(a.marketId))) || [];
    fills += reconstructTapeFillsForMarket(rows, trades, { offsetCents, sizeUsd: a.sizeUsd, maxInventoryUsd }).fills.length;
  }
  return fills;
}

/**
 * One allocation point: a (tolerance, offset) choice. Deploy ≤ 2·t·budget → bound ≤ t·budget. Honest offset:
 * a market only earns if the offset fits inside its reward band, i.e. offsetCents ≤ maxSpread/2. Markets
 * whose band cannot contain the offset (or whose maxSpread is unknown) are EXCLUDED and counted — this is
 * what makes a wider offset cost reward (the allocator's gross is otherwise the offset-independent S=1
 * ceiling). `maxSpreadByMarket` maps conditionId → maxSpread cents.
 */
function allocateAt(D, { tolerance = 0.5, offsetCents = 1, budget = 5000, unitUsd = 100, maxInventoryUsd = 5000, maxSpreadByMarket = null } = {}) {
  const deployCap = Math.min(budget, 2 * tolerance * budget);
  let byMarket = D.byMarket, excludedBand = 0;
  if (maxSpreadByMarket) {
    byMarket = new Map();
    for (const [mid, rows] of D.byMarket.entries()) {
      const ms = maxSpreadByMarket.get(mid);
      if (fin(ms) && offsetCents <= ms / 2 + 1e-9) byMarket.set(mid, rows); else if (D.potByCond.has(mid)) excludedBand++;
    }
  }
  const alloc = allocateBudget(byMarket, D.marketTokens, D.tapeByToken, D.potByCond,
    { offsetCents, maxInventoryUsd, budgetUsd: deployCap, unitUsd, maxPerMarketUsd: deployCap, policy: 'hold' });
  const bound = structuralTotal(alloc.allocation);
  return {
    tolerance, offsetCents, deployed: alloc.usedUnits * unitUsd, marketsHeld: alloc.marketsHeld, excludedBand,
    grossPerDay: alloc.grossPerDay, netPerDay: alloc.totalNet5m, structuralBound: bound,
    expectedFills: expectedFills(alloc.allocation, D, offsetCents, maxInventoryUsd),
    allocation: alloc.allocation,
  };
}

/**
 * Max-quiet: MINIMISE expected fills subject only to earning ABOVE the risk-free rate. Widen the offset (and
 * hold tolerance at the free 50%) as far as the annualised net still clears riskFreePct; among those, pick
 * the fewest fills. Returns the chosen point + the whole offset sweep for transparency.
 */
function maxQuiet(D, { budget = 5000, riskFreePct = 4, offsets = [1, 2, 3, 4, 5], maxSpreadByMarket = null } = {}) {
  const sweep = offsets.map((o) => {
    const p = allocateAt(D, { tolerance: 0.5, offsetCents: o, budget, maxSpreadByMarket });
    const annual = (fin(p.netPerDay) && budget > 0) ? (p.netPerDay * 365 / budget) * 100 : null;
    return { ...p, annualPct: annual, clearsRiskFree: annual != null && annual > riskFreePct };
  });
  const eligible = sweep.filter((s) => s.clearsRiskFree);
  const chosen = eligible.length ? eligible.reduce((q, s) => (s.expectedFills < q.expectedFills ? s : q)) : null;
  return { chosen, sweep, riskFreePct };
}

/**
 * Pick the lexicographic winner among candidate allocation points, in STRICT priority order:
 *   (1) feasible: structuralBound ≤ tolerance × budget (else rejected outright);
 *   (2) among feasible, FEWEST expected fills;
 *   (3) ties broken by MOST net/day.
 * Returns null if no candidate is feasible. Pure and deterministic.
 */
function lexiPick(points, { tolerance, budget }) {
  const limit = tolerance * budget;
  const feasible = (points || []).filter((p) => fin(p.structuralBound) && p.structuralBound <= limit + 1e-9);
  if (!feasible.length) return null;
  return feasible.slice().sort((a, b) => (a.expectedFills - b.expectedFills) || ((fin(b.netPerDay) ? b.netPerDay : -Infinity) - (fin(a.netPerDay) ? a.netPerDay : -Infinity)))[0];
}

module.exports = { allocateAt, maxQuiet, expectedFills, lexiPick };
