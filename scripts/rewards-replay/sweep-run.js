#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/sweep-run.js — PHASE 4: with the budget FIXED, sweep the allocation to find where
// NET is maximised. Prints the NET frontier vs #markets held; the concentration answer (best count, and net
// if that count is halved / doubled); where the capacity cap binds (saturationCapital); and an offset
// sensitivity. Offline replay; maker disarmed. Same window/pots basis as allocate-run.js.
//   node sweep-run.js --from ISO --to ISO [--pots snapshot.json] [--budget 5000] [--unit 100] [--max-count 25]

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { loadTape } = require('./lib/tape');
const { computeNet } = require('./lib/net');
const { markoutAll } = require('./lib/markout');
const { reconstructTapeFills } = require('./lib/tape');
const { allocateBudget } = require('./lib/allocate');
const { frontierByCount, saturationCapital } = require('./lib/allocate-sweep');

function parseArgs(argv) {
  const a = { from: null, to: null, pots: null, budget: 5000, unit: 100, offset: 1, size: 1000, maxInventory: 5000, maxCount: 25 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--from') { a.from = v; i++; } else if (k === '--to') { a.to = v; i++; }
    else if (k === '--pots') { a.pots = v; i++; } else if (k === '--budget') { a.budget = Number(v); i++; }
    else if (k === '--unit') { a.unit = Number(v); i++; } else if (k === '--offset') { a.offset = Number(v); i++; }
    else if (k === '--max-inventory') { a.maxInventory = Number(v); i++; } else if (k === '--max-count') { a.maxCount = Number(v); i++; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));

async function loadPots(args) {
  if (args.pots) { const s = JSON.parse(fs.readFileSync(args.pots, 'utf8')); const m = new Map(); for (const [c, o] of Object.entries(s.byCond)) m.set(c, o.pot); return m; }
  const { fetchRewardMarkets } = require('../rewards-ceiling/lib/gamma');
  const { markets } = await fetchRewardMarkets();
  return new Map(markets.map((m) => [m.conditionId, m.rewardsDailyRate]));
}

async function main() {
  const args = parseArgs(process.argv);
  const fromMs = args.from ? Date.parse(args.from) : -Infinity;
  const toMs = args.to ? Date.parse(args.to) : Infinity;
  const tapeFull = loadTape({ fromMs, toMs });
  const winFrom = Math.max(fromMs, tapeFull.window.fromMs || -Infinity);
  const winTo = Math.min(toMs, tapeFull.window.toMs || Infinity);
  const J = loadJournal({ fromMs: winFrom, toMs: winTo });
  const tape = loadTape({ fromMs: winFrom, toMs: winTo });
  const windowHours = J.window.hours;
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  const potByCond = await loadPots(args);

  console.log('═'.repeat(78));
  console.log(`PHASE 4 — ALLOCATION SWEEP ON NET AT A FIXED BUDGET OF ${money(args.budget)} (offline replay)`);
  console.log('═'.repeat(78));
  console.log(`window ${windowHours.toFixed(2)}h · unit $${args.unit} capital · offset ${args.offset}¢`);

  // baseline net.rows (for limDepth/mid → capacity binding)
  const Fbase = reconstructTapeFills(J.byMarket, tape.byToken, marketTokens, { offsetCents: args.offset, sizeUsd: args.size, maxInventoryUsd: args.maxInventory });
  const netBase = computeNet(J.byMarket, markoutAll(Fbase.fills, J.byMarket), potByCond, { sizeUsd: args.size, windowHours, wsOnly: false });
  const rowByMkt = new Map(netBase.rows.map((r) => [r.marketId, r]));

  // build curves + global optimum
  const alloc = allocateBudget(J.byMarket, marketTokens, tape.byToken, potByCond,
    { offsetCents: args.offset, maxInventoryUsd: args.maxInventory, windowHours, budgetUsd: args.budget, unitUsd: args.unit, maxPerMarketUsd: args.budget });
  const budgetUnits = Math.floor(args.budget / args.unit);

  const F = frontierByCount(alloc.curves, budgetUnits, args.maxCount);
  console.log('\nNET FRONTIER vs #markets held simultaneously (budget fixed; knapsack picks size per market):');
  console.log('  count │   NET(+5m)  │ Δ vs best');
  const bestNet = Math.max(...F.frontier.map((p) => p.net));
  const bestCount = F.frontier.find((p) => Math.abs(p.net - bestNet) < 1e-9).count;
  for (const p of F.frontier) {
    if (p.count > Math.min(args.maxCount, bestCount + 8) && p.count % 5 !== 0) continue;
    const bar = '█'.repeat(Math.round((p.net / bestNet) * 30));
    console.log(`   ${String(p.count).padStart(3)}  │ ${money(p.net).padStart(9)}  │ ${bar} ${p.count === bestCount ? '← best' : ''}`);
  }

  // concentration answer
  const half = Math.max(1, Math.round(bestCount / 2));
  const dbl = bestCount * 2;
  console.log('\nCONCENTRATION ANSWER:');
  console.log(`  best $${args.budget} allocation needs ${bestCount} markets → NET ${money(F.netAt(bestCount))}`);
  console.log(`  halved to ${half} markets → NET ${money(F.netAt(half))} (${((F.netAt(half) / bestNet - 1) * 100).toFixed(1)}% vs best)`);
  console.log(`  doubled to ${dbl} markets → NET ${money(F.netAt(dbl))} (${F.netAt(dbl) != null ? ((F.netAt(dbl) / bestNet - 1) * 100).toFixed(1) + '% vs best' : 'beyond sweep'})`);

  // where capacity binds — for the best allocation's top markets
  console.log('\nWHERE THE CAPACITY CAP BINDS (total capital to reach 50%/90%/99% pool share; reuses ceiling capitalForShare):');
  const topHoldings = [...alloc.allocation].sort((a, b) => b.net5m - a.net5m).slice(0, 6);
  for (const h of topHoldings) {
    const r = rowByMkt.get(h.marketId);
    if (!r) { console.log(`  ${h.marketId.slice(0, 14)}… (no baseline depth row)`); continue; }
    const sat = saturationCapital(r.limDepthShares, r.mid, [0.5, 0.9, 0.99]);
    console.log(`  ${h.marketId.slice(0, 14)}…  held $${h.capital} (share ${(h.share * 100).toFixed(0)}%) · depth ${r.limDepthShares.toFixed(0)}sh @ ${r.mid.toFixed(3)} · 50%→${money(sat[0.5])} · 90%→${money(sat[0.9])} · 99%→${money(sat[0.99])}`);
  }
  console.log('  → past the 90% point each extra dollar buys <1/10th more pool share; that is the capacity ceiling for that market.');

  // offset sensitivity — measured on the BASELINE config (every market $size/side) so it is one cheap pass
  // per offset, not a re-run of the knapsack. NOTE gross is the S=1 ceiling and does NOT fall with offset in
  // this replay, so offset moves COST/fills only; a wider offset that leaves the reward band would forfeit
  // gross on the venue but that is not modelled here (stated, not hidden).
  console.log('\nOFFSET SENSITIVITY (baseline: every market at $' + args.size + '/side; gross is the S=1 ceiling → offset changes COST/fills only):');
  for (const off of [0, 1, 2, 3]) {
    const f = reconstructTapeFills(J.byMarket, tape.byToken, marketTokens, { offsetCents: off, sizeUsd: args.size, maxInventoryUsd: args.maxInventory });
    const nt = computeNet(J.byMarket, markoutAll(f.fills, J.byMarket), potByCond, { sizeUsd: args.size, windowHours, wsOnly: false });
    const ag = nt.aggregate;
    console.log(`  offset ${off}¢ → gross ${money(ag.grossWindow)} · cost(+5m) ${money(ag.costWindow['5m'])} · NET ${money(ag.netWindow['5m'])} · ${f.fills.length} fills`);
  }

  const out = { window: J.window, budget: args.budget, unit: args.unit, frontier: F.frontier, bestCount, bestNet, halfNet: F.netAt(half), doubleNet: F.netAt(dbl) };
  try { fs.mkdirSync('/tmp/rewards-replay', { recursive: true }); fs.writeFileSync('/tmp/rewards-replay/sweep-summary.json', JSON.stringify(out, null, 0)); console.log('\nwrote /tmp/rewards-replay/sweep-summary.json'); } catch (e) { console.error('write failed', e.message); }
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
