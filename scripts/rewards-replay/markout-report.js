#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/markout-report.js — PHASE 2: the markout, looked at properly. Offline replay.
// Prints the +5m markout distribution with the WORST DECILE, bid vs ask; the per-market markout cost joined
// to gross reward (answers "are the worst-markout markets the biggest-gross markets?"); and the fill
// concentration across markets. Same window/pots basis as allocate-run.js.
//   node markout-report.js --from ISO --to ISO [--pots snapshot.json]

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { loadTape, reconstructTapeFills } = require('./lib/tape');
const { markoutAll } = require('./lib/markout');
const { computeNet } = require('./lib/net');
const { sideDistributions, byMarketMarkout, costGrossRankCorr, fillConcentration } = require('./lib/markout-by-market');

function parseArgs(argv) {
  const a = { from: null, to: null, pots: null, offset: 1, size: 1000, maxInventory: 5000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--from') { a.from = v; i++; } else if (k === '--to') { a.to = v; i++; }
    else if (k === '--pots') { a.pots = v; i++; } else if (k === '--offset') { a.offset = Number(v); i++; }
    else if (k === '--size') { a.size = Number(v); i++; } else if (k === '--max-inventory') { a.maxInventory = Number(v); i++; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const cents = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2) + '¢');

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
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  const potByCond = await loadPots(args);

  const F = reconstructTapeFills(J.byMarket, tape.byToken, marketTokens, { offsetCents: args.offset, sizeUsd: args.size, maxInventoryUsd: args.maxInventory });
  const MO = markoutAll(F.fills, J.byMarket);
  const net = computeNet(J.byMarket, MO, potByCond, { sizeUsd: args.size, windowHours: J.window.hours, wsOnly: false });

  console.log('═'.repeat(78));
  console.log('PHASE 2 — MARKOUT DISTRIBUTION BY PERCENTILE AND BY MARKET (offline replay)');
  console.log('═'.repeat(78));
  console.log(`window ${J.window.hours.toFixed(2)}h · fills ${F.fills.length} · size $${args.size}/side · offset ${args.offset}¢`);

  const sd = sideDistributions(MO, '5m');
  console.log('\n+5m MARKOUT (adverse = NEGATIVE) — bid-side vs ask-side, with the worst decile:');
  for (const side of ['buy', 'sell', 'all']) {
    const c = sd[side].cents, u = sd[side].usd;
    console.log(`  ${side.toUpperCase().padEnd(4)} (${sd[side].fills} fills)  cents: mean ${cents(c.mean)} · median ${cents(c.median)} · p25 ${cents(c.p25)} · p75 ${cents(c.p75)} · p05 ${cents(c.p05)} · p95 ${cents(c.p95)} · min ${cents(c.min)}`);
    console.log(`       worst decile: ${c.worstDecile ? `${c.worstDecile.n} fills ≤ ${cents(c.worstDecile.threshold)}, mean ${cents(c.worstDecile.mean)}` : '—'}  ·  in $: worst-decile mean ${u.worstDecile ? money(u.worstDecile.mean) : '—'}, total ${money(u.sum)}`);
  }

  const rows = byMarketMarkout(MO, net.rows, '5m');
  console.log('\nWORST-MARKOUT MARKETS (mean +5m cents), with the gross reward each earns:');
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.marketId.slice(0, 16)}…  mean ${cents(r.meanCents)} · worst-decile ${r.worstDecileCents ? cents(r.worstDecileCents.mean) : '—'} · ${r.fills} fills (${r.buyFills}b/${r.sellFills}s) · cost ${money(r.costUsd)} · gross ${money(r.gross)} · net ${money(r.net5m)}`);
  }
  const byGross = [...rows].filter((r) => r.gross != null).sort((a, b) => b.gross - a.gross);
  console.log('\nMOST-GROSS MARKETS, with their markout:');
  for (const r of byGross.slice(0, 8)) {
    console.log(`  ${r.marketId.slice(0, 16)}…  gross ${money(r.gross)} · mean markout ${cents(r.meanCents)} · cost ${money(r.costUsd)} · ${r.fills} fills · net ${money(r.net5m)}`);
  }
  const corr = costGrossRankCorr(rows);
  console.log(`\nCOST↔GROSS rank correlation (Spearman) = ${corr == null ? '—' : corr.toFixed(3)}  ` +
    `(+1 ⇒ worst-markout markets ARE the biggest-gross markets [REWARDS-CEILING failure mode]; ~0 ⇒ unrelated)`);

  const conc = fillConcentration(rows);
  console.log('\nFILL CONCENTRATION across markets:');
  console.log(`  ${conc.totalFills} fills over ${conc.marketsWithFills} markets · HHI ${conc.hhi.toFixed(3)} · top-1 ${(conc.top1Share * 100).toFixed(1)}% · top-5 ${(conc.top5Share * 100).toFixed(1)}% · ${conc.marketsFor80pct} market(s) carry 80% of fills`);

  const out = { window: J.window, fills: F.fills.length, sideDistributions: sd, byMarket: rows, costGrossRankCorr: corr, fillConcentration: conc };
  try { fs.mkdirSync('/tmp/rewards-replay', { recursive: true }); fs.writeFileSync('/tmp/rewards-replay/markout-by-market.json', JSON.stringify(out, null, 0)); console.log('\nwrote /tmp/rewards-replay/markout-by-market.json'); } catch (e) { console.error('write failed', e.message); }
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
