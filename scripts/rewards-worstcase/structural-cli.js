#!/usr/bin/env node
'use strict';
// scripts/rewards-worstcase/structural-cli.js — PHASE 4: structural maximum capital at risk, STATED not
// simulated. No Monte Carlo, no VaR. Offline replay.
//   node structural-cli.js [--pots snapshot.json]

const { loadWindow } = require('./lib/data');
const { buildLedger } = require('./lib/ledger');
const { marketMeta } = require('../../lib/rewards/allocator');
const { structuralBound, portfolioBounds } = require('./lib/structural');

const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const days = (x) => (x == null ? '—' : x.toFixed(0) + 'd');

function parseArgs(argv) { const a = { pots: null }; for (let i = 2; i < argv.length; i++) { if (argv[i] === '--pots') { a.pots = argv[i + 1]; i++; } } return a; }

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const L = buildLedger(D, { budgetUsd: 5000 });

  console.log('═'.repeat(90));
  console.log('PHASE 4 — STRUCTURAL MAXIMUM CAPITAL AT RISK (stated, NOT simulated — no Monte Carlo, no VaR)');
  console.log('═'.repeat(90));
  console.log(`allocation: ${L.marketsHeld} markets · total net ${money(L.totals.netPerDay)}/day · total capital committed ${money(L.totals.capital)} (= Σ 2×$/side)`);

  const bounds = [];
  console.log('\n  market            $/side  gross/d   maxLoss  days-erased  order(sh)  depth(sh)  order/depth');
  const rows = L.rows.map((r) => {
    const mm = marketMeta(D.byMarket.get(r.marketId) || []);
    const b = structuralBound({ sizeUsd: r.sizeUsd, grossPerDay: r.grossPerDay, mid: mm.mid, depthShares: mm.depthShares });
    bounds.push(b);
    return { r, b };
  });
  for (const x of rows.sort((a, b) => (b.b.orderVsDepth || 0) - (a.b.orderVsDepth || 0))) {
    console.log('  ' + x.r.marketId.slice(0, 14) + '… ' + ('$' + x.r.sizeUsd).padStart(6) + ' ' + money(x.r.grossPerDay).padStart(8) + ' ' +
      money(x.b.maxLoss).padStart(8) + ' ' + days(x.b.daysErased).padStart(11) + ' ' +
      (x.b.orderShares == null ? '—' : x.b.orderShares.toFixed(0)).padStart(9) + ' ' +
      (x.b.depthShares == null ? '—' : x.b.depthShares.toFixed(1)).padStart(9) + ' ' +
      (x.b.orderVsDepth == null ? '—' : x.b.orderVsDepth.toFixed(1) + '×').padStart(11));
  }

  const maxRatio = rows.reduce((m, x) => (x.b.orderVsDepth != null && (m == null || x.b.orderVsDepth > m.b.orderVsDepth) ? x : m), null);
  console.log('\nORDER vs DEPTH: our order enters the book. Largest ratio in this window: ' +
    (maxRatio ? maxRatio.b.orderVsDepth.toFixed(1) + '× (' + maxRatio.r.marketId.slice(0, 12) + '…, ' + maxRatio.b.orderShares.toFixed(0) + 'sh order vs ' + maxRatio.b.depthShares.toFixed(1) + 'sh depth)' : '—') + '.');
  console.log('  A prior LIVE-day allocation showed a far worse row — a ~$500 order against ~4.25 shares of in-band depth,');
  console.log('  ≈117× — on a thin market that has since rotated out. The ratio is UNSTABLE day to day and can spike.');
  console.log('  MEANING: when our order is many times the observed depth, that size CANNOT actually rest in the book, the');
  console.log('  gross reward computed on that pool-share is unearnable, the fill probability is near-1 if a taker appears,');
  console.log('  and there is NO exit — selling the resulting inventory would walk a book that is a fraction of the position.');

  const P = portfolioBounds(bounds, L.totals.netPerDay);
  console.log('\nSTRUCTURAL BOUNDS (per market: one full adverse fill = the whole $/side; days-erased = size ÷ gross):');
  console.log(`  a single full adverse fill erases ${days(Math.min(...bounds.map((b) => b.daysErased).filter((x) => x != null)))}–${days(Math.max(...bounds.map((b) => b.daysErased).filter((x) => x != null)))} of THAT market's reward.`);
  console.log(`  worst single market max loss: ${money(P.worstSingleMarketLoss)} → the whole allocation needs ${days(P.daysToRecoverSingle)} of net to recover ONE such resolution.`);
  console.log(`  portfolio ceiling (EVERY market resolves adversely on its filled side): ${money(P.portfolioMaxLoss)} → ${days(P.daysToRecoverPortfolio)} of net to recover.`);
  console.log('\nPROBABILITY: UNMEASURED. With 11 observed fills there is no basis to attach a probability to any of these');
  console.log('  bounds, and none is modelled. A Monte Carlo or fitted VaR here would invent a distribution the data cannot');
  console.log('  support — that would be the single most misleading number this analysis could produce, so it is refused.');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
