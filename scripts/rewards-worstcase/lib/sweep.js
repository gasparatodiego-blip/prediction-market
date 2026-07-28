'use strict';
// scripts/rewards-worstcase/lib/sweep.js — PHASE 2: the diversification sweep. For each market-count level,
// allocate $budget with the SAME knapsack (frontierByCount) and report both tails over the observed window:
// best/median/worst realised daily net, stdev of daily net, the worst single fill, and per-market tails.
// Reuses the shipped allocator + frontier read-only. Replay, not P&L.

const { allocateBudget } = require('../../../lib/rewards/allocator');
const { frontierByCount } = require('../../rewards-replay/lib/allocate-sweep');
const { dailyNet } = require('./daily');

const DEFAULT_COUNTS = [1, 2, 3, 5, 6, 8, 10, 15, 20, 30, 50];

function diversificationSweep(D, { budgetUsd = 5000, unitUsd = 100, counts = DEFAULT_COUNTS, offsetCents = 1, maxInventoryUsd = 5000 } = {}) {
  const alloc = allocateBudget(D.byMarket, D.marketTokens, D.tapeByToken, D.potByCond,
    { offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: budgetUsd, policy: 'hold' });
  const fundable = alloc.curves.filter((c) => !c.excluded).length;
  const budgetUnits = Math.floor(budgetUsd / unitUsd);
  const allCounts = [...counts.filter((c) => c <= fundable), fundable]; // …plus the all-observed level
  const F = frontierByCount(alloc.curves, budgetUnits, Math.max(...allCounts));

  const levels = allCounts.map((c) => {
    const recon = F.reconstruct(c);
    const dn = dailyNet(recon.allocation, D.byMarket, D.marketTokens, D.tapeByToken, { offsetCents, maxInventoryUsd });
    const grossPerDay = recon.allocation.reduce((s, a) => s + (a.grossPerDay || 0), 0);
    return {
      requested: c, held: recon.count, isAll: c === fundable,
      grossPerDay, netPerDay: recon.net, capital: recon.usedUnits * unitUsd,
      daily: dn.daily, worstFill: dn.worstFill, worstMarket: dn.worstMarket, bestMarket: dn.bestMarket,
    };
  });
  return { fundable, budgetUsd, levels, days: dailyNet(F.reconstruct(fundable).allocation, D.byMarket, D.marketTokens, D.tapeByToken, { offsetCents, maxInventoryUsd }).days };
}

module.exports = { diversificationSweep, DEFAULT_COUNTS };
