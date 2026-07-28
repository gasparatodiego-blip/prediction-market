'use strict';
// scripts/rewards-riskfirst/lib/preserve.js — CONSTRAINT 1: capital preservation, a HARD structural bound
// (not a probability). Reuses the worst-case structural bound: one full adverse fill of a resting $size
// order that resolves against it loses the whole $size, so an allocation's total bound = Σ per-side size =
// deployed capital / 2. The tolerance therefore acts as a cap on DEPLOYED capital. Replay, not P&L.

const { structuralBound } = require('../../rewards-worstcase/lib/structural');
const { allocateBudget } = require('../../../lib/rewards/allocator');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Total structural bound of an allocation = Σ maxLoss (per market, reused from worstcase). */
function structuralTotal(allocation) {
  return (allocation || []).reduce((s, a) => { const b = structuralBound({ sizeUsd: a.sizeUsd }).maxLoss; return s + (fin(b) ? b : 0); }, 0);
}

/** Does the allocation satisfy: total structural bound ≤ toleranceFrac × budget? */
function withinTolerance(boundTotal, toleranceFrac, budget) {
  const limit = toleranceFrac * budget;
  return { bound: boundTotal, limit, ok: fin(boundTotal) && boundTotal <= limit + 1e-9 };
}

/**
 * Sweep the tolerance. To keep the total bound (= deployed/2) ≤ t·budget, deploy at most 2·t·budget (capped
 * at the budget). Reports the reward achievable at each tolerance — the price of safety.
 */
function toleranceSweep(D, { budget = 5000, unitUsd = 100, tolerances = [0.10, 0.25, 0.50, 1.00], offsetCents = 1, maxInventoryUsd = 5000 } = {}) {
  return tolerances.map((t) => {
    const deployCap = Math.min(budget, 2 * t * budget);
    const alloc = allocateBudget(D.byMarket, D.marketTokens, D.tapeByToken, D.potByCond,
      { offsetCents, maxInventoryUsd, budgetUsd: deployCap, unitUsd, maxPerMarketUsd: deployCap, policy: 'hold' });
    const bound = structuralTotal(alloc.allocation);
    const chk = withinTolerance(bound, t, budget);
    return {
      tolerance: t, deployCap, deployed: alloc.usedUnits * unitUsd, marketsHeld: alloc.marketsHeld,
      structuralBound: bound, limit: chk.limit, satisfies: chk.ok,
      grossPerDay: alloc.grossPerDay, netPerDay: alloc.totalNet5m,
    };
  });
}

module.exports = { structuralTotal, withinTolerance, toleranceSweep };
