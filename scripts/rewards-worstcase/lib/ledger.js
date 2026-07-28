'use strict';
// scripts/rewards-worstcase/lib/ledger.js — PHASE 1: the full observed universe at $5,000, both sides of the
// ledger per market, with ZERO-FILL markets counted separately as UNOBSERVED (not safe). Pure over inputs;
// reuses lib/rewards/allocator (which reuses the shipped computeNet) — no parallel math. Replay, not P&L.

const { allocateBudget } = require('../../../lib/rewards/allocator');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Build the $budget allocation ledger. Returns per-market rows (gross/fills/cost/net per day), the fundable
 * count, and the tested-by-fills vs never-touched split of the total net.
 * A row's net is a real measured figure ONLY where a fill was observed; a zero-fill market's net equals its
 * gross (KNOWN zero cost per Phase-1 fix) but is LABELLED unobserved — no fill has tested it.
 */
function buildLedger(D, { budgetUsd = 5000, unitUsd = 100, offsetCents = 1, maxInventoryUsd = 5000 } = {}) {
  const alloc = allocateBudget(D.byMarket, D.marketTokens, D.tapeByToken, D.potByCond,
    { offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: budgetUsd, policy: 'hold' });
  const fundable = alloc.curves.filter((c) => !c.excluded).length;

  const rows = alloc.allocation.map((a) => ({
    marketId: a.marketId, sizeUsd: a.sizeUsd, capital: a.capital, spanHours: a.spanHours,
    grossPerDay: fin(a.grossPerDay) ? a.grossPerDay : null,
    costPerDay: fin(a.costPerDay5m) ? a.costPerDay5m : null,
    netPerDay: fin(a.netPerDay5m) ? a.netPerDay5m : null, // null ⇒ "—" (cost unknown), excluded + counted below
    fills: a.fills || 0, share: a.share, zeroFill: (a.fills || 0) === 0,
    depthShares: a.depthShares ?? null,
  }));

  const agg = aggregateLedger(rows);
  return {
    budgetUsd, fundableCount: fundable, marketsHeld: rows.length, rows,
    ...agg,
    totals: { ...agg.totals, capital: alloc.usedUnits * unitUsd },
    alloc, // pass through for later phases
  };
}

/**
 * PURE aggregation of ledger rows. A row with unknown net (netPerDay == null) is EXCLUDED from every total
 * and COUNTED (unknownNet) — never defaulted to 0. Splits net into TESTED (fills > 0) vs UNTOUCHED
 * (zero-fill, unobserved). Aggregate net ≤ aggregate gross by construction (each row's net ≤ its gross).
 */
function aggregateLedger(rows) {
  const known = rows.filter((r) => r.netPerDay != null);
  const unknownNet = rows.length - known.length;
  const tested = known.filter((r) => !r.zeroFill);
  const untouched = known.filter((r) => r.zeroFill);
  const sum = (arr, k) => arr.reduce((s, r) => s + (fin(r[k]) ? r[k] : 0), 0);
  const totalNet = sum(known, 'netPerDay');
  return {
    unknownNet,
    totals: { grossPerDay: sum(known, 'grossPerDay'), costPerDay: sum(known, 'costPerDay'), netPerDay: totalNet },
    split: {
      tested: { count: tested.length, grossPerDay: sum(tested, 'grossPerDay'), netPerDay: sum(tested, 'netPerDay'), fills: tested.reduce((s, r) => s + (r.fills || 0), 0) },
      untouched: { count: untouched.length, grossPerDay: sum(untouched, 'grossPerDay'), netPerDay: sum(untouched, 'netPerDay') },
      untouchedNetShare: totalNet > 0 ? sum(untouched, 'netPerDay') / totalNet : null,
    },
  };
}

module.exports = { buildLedger, aggregateLedger };
