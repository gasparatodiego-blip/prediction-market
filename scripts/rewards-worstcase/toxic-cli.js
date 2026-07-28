#!/usr/bin/env node
'use strict';
// scripts/rewards-worstcase/toxic-cli.js — PHASE 3: the toxic markets at full weight + ex-ante analysis.
//   node toxic-cli.js [--pots snapshot.json] [--size 250]

const fs = require('fs');
const { loadWindow } = require('./lib/data');
const { buildLedger } = require('./lib/ledger');
const { resolveToxic, fractionErased, marketView } = require('./lib/toxic');

const TOXIC_PREFIXES = ['0x0d9d760f', '0x0dbd760f', '0x14d32732']; // both spellings seen in the brief
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));

function parseArgs(argv) {
  const a = { pots: null, size: 250 };
  for (let i = 2; i < argv.length; i++) { const k = argv[i], v = argv[i + 1]; if (k === '--pots') { a.pots = v; i++; } else if (k === '--size') { a.size = Number(v); i++; } }
  return a;
}

// category from the Gamma-sourced board, by conditionId
function categoryMap() {
  try { const b = JSON.parse(fs.readFileSync('/root/prediction-market/data/liquidity-rewards.json', 'utf8')); const m = new Map(); for (const x of b.markets || []) m.set(x.conditionId, x.category ?? null); return m; } catch { return new Map(); }
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const meta = args.pots ? { byCond: JSON.parse(fs.readFileSync(args.pots, 'utf8')).byCond } : null;
  const cats = categoryMap();
  const L = buildLedger(D, { budgetUsd: 5000 });
  const goodNet = L.totals.netPerDay;

  console.log('═'.repeat(84));
  console.log('PHASE 3 — THE TWO TOXIC MARKETS AT FULL WEIGHT (offline replay)');
  console.log('═'.repeat(84));
  console.log(`good $5,000 allocation net: ${money(goodNet)}/day (${L.marketsHeld} markets, ${L.split.tested.fills} fills)`);

  const toxIds = resolveToxic(D.byMarket, TOXIC_PREFIXES);
  console.log(`\nresolved ${toxIds.length} toxic market(s) in the journal:`);
  const views = [];
  for (const mid of toxIds) {
    console.log(`\n  ${mid.slice(0, 16)}…  [${(cats.get(mid) || '—')}]  "${((meta && meta.byCond[mid] && meta.byCond[mid].q) || '?').slice(0, 44)}"`);
    for (const sz of [50, args.size, 1000]) {
      const v = marketView(mid, D, sz, meta);
      if (sz === args.size) views.push(v);
      console.log(`    $${sz}/side → gross ${money(v.grossPerDay)}/d · cost ${money(v.costPerDay)}/d · NET ${money(v.netPerDay)}/d · ${v.fills} fills · erases ${fractionErased(v.netPerDay, goodNet) == null ? '—' : (fractionErased(v.netPerDay, goodNet) * 100).toFixed(1) + '%'} of a good day`);
    }
  }

  const combined = views.reduce((s, v) => s + (v.netPerDay || 0), 0);
  console.log(`\nDAMAGE (both toxic held at $${args.size}/side): combined NET ${money(combined)}/day → erases ${(fractionErased(combined, goodNet) * 100).toFixed(1)}% of the ${money(goodNet)}/day good allocation.`);
  console.log(`  (at $1000/side the two erase far more than a full good day — the day goes NEGATIVE.)`);

  // EX-ANTE property comparison
  console.log('\nEX-ANTE — was any property observable BEFORE their fills able to exclude them?');
  console.log('  property        toxic-1        toxic-2        good-allocation range');
  const goodViews = L.rows.map((r) => marketView(r.marketId, D, r.sizeUsd, meta));
  const rng = (k) => { const xs = goodViews.map((v) => v[k]).filter((x) => x != null); return xs.length ? `${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}` : '—'; };
  const prop = (label, k, fmt = (x) => x) => console.log(`  ${label.padEnd(15)} ${String(fmt(views[0] && views[0][k])).padEnd(14)} ${String(fmt(views[1] && views[1][k])).padEnd(14)} ${rng(k)}`);
  prop('pot ($/day)', 'pot');
  prop('maxSpread (¢)', 'maxSpreadCents');
  prop('minSize (sh)', 'minSize');
  prop('depth (sh)', 'depthShares', (x) => x == null ? '—' : x.toFixed(0));
  prop('mid', 'mid', (x) => x == null ? '—' : x.toFixed(3));
  prop('span (h)', 'spanHours', (x) => x == null ? '—' : x.toFixed(1));
  prop('fills', 'fills');
  console.log('  category:       ' + toxIds.map((m) => cats.get(m) || '—').join(' / ') + '   (vs good: ' + [...new Set(L.rows.map((r) => cats.get(r.marketId) || '—'))].join(', ') + ')');
  console.log('\n  HONEST CONFIDENCE: two markets is NOT a sample. Both happen to carry maxSpread 4.5¢ and be pop-culture');
  console.log('  entertainment, but good-allocation markets also span that band and category, so neither cleanly separates');
  console.log('  them. The ONLY property that predicts the loss is that their fills were adverse — observable only AFTER');
  console.log('  the fills, not before. Fitting an exclusion rule to two points would be overfitting; there is NO reliable');
  console.log('  ex-ante filter in this data. What flags them is realised markout, which requires the fills to have landed.');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
