#!/usr/bin/env node
'use strict';
// scripts/rewards-worstcase/ledger-cli.js — PHASE 1: the full observed universe at $5,000, with zero-fill
// markets counted separately. Offline replay; maker disarmed; reads no key, places nothing.
//   node ledger-cli.js [--pots snapshot.json] [--from ISO --to ISO] [--budget 5000]

const { loadWindow } = require('./lib/data');
const { buildLedger } = require('./lib/ledger');

const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const perDay = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2) + '/d');

function parseArgs(argv) {
  const a = { pots: null, from: undefined, to: undefined, budget: 5000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--pots') { a.pots = v; i++; } else if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; } else if (k === '--budget') { a.budget = Number(v); i++; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ from: args.from, to: args.to, potsPath: args.pots });

  console.log('═'.repeat(80));
  console.log('PHASE 1 — FULL OBSERVED UNIVERSE AT $' + args.budget + ' (offline replay; maker disarmed)');
  console.log('═'.repeat(80));
  console.log('window:', D.window.hours.toFixed(2) + 'h · pots:', D.potSource);
  console.log('COVERAGE:'); for (const l of D.coverage.headerLines) console.log('  ' + l);
  console.log(`  TRUE coverage: ${D.coverage.coveredMarketCount} of ${D.coverage.liveUniverse} collectable reward markets ≈ ${D.coverage.truePct}% — PARTIAL, not the header's over-100%.`);
  const stalePct = D.staleFrac * 100;
  console.log(`ws/stale: ws ${D.ws} · stale ${D.stale} (${stalePct.toFixed(1)}%)${stalePct > 20 ? ' ⚠ >20% — DO NOT TRUST' : ' — trusted (<20%)'}`);

  const L = buildLedger(D, { budgetUsd: args.budget });
  console.log(`\nfundable markets (pot + observed depth): ${L.fundableCount} of ${D.byMarket.size} in the journal`);
  console.log(`$${args.budget} allocation holds ${L.marketsHeld} markets · gross ${perDay(L.totals.grossPerDay)} · cost ${perDay(L.totals.costPerDay)} · NET ${perDay(L.totals.netPerDay)}`);

  console.log('\nPER-MARKET LEDGER (both sides; zero-fill = UNOBSERVED, not safe):');
  console.log('  market            $/side  gross/d   fills  cost/d    net/d     status');
  for (const r of [...L.rows].sort((a, b) => (b.grossPerDay || 0) - (a.grossPerDay || 0))) {
    console.log('  ' + r.marketId.slice(0, 14) + '… ' + String('$' + r.sizeUsd).padStart(6) + ' ' +
      perDay(r.grossPerDay).padStart(8) + ' ' + String(r.fills).padStart(6) + ' ' + perDay(r.costPerDay).padStart(8) + ' ' +
      (r.netPerDay == null ? '—'.padStart(8) : perDay(r.netPerDay).padStart(8)) + '   ' + (r.zeroFill ? 'ZERO-FILL (unobserved)' : r.fills + ' fills (tested)'));
  }
  if (L.unknownNet) console.log(`  (${L.unknownNet} market(s) had fills but no +5m sample → net "—", excluded from totals and counted)`);

  console.log('\nZERO-FILL SPLIT — how much net is actually TESTED vs merely UNTOUCHED:');
  console.log(`  TESTED by fills:  ${L.split.tested.count} markets · ${L.split.tested.fills} fills · gross ${perDay(L.split.tested.grossPerDay)} · net ${perDay(L.split.tested.netPerDay)}`);
  console.log(`  UNTOUCHED (0 fills, UNOBSERVED): ${L.split.untouched.count} markets · net ${perDay(L.split.untouched.netPerDay)} (= gross, zero OBSERVED cost — NOT evidence of safety)`);
  console.log(`  → ${L.split.untouchedNetShare == null ? '—' : (L.split.untouchedNetShare * 100).toFixed(1) + '%'} of total net comes from markets NEVER TOUCHED by a fill.`);

  // net ≤ gross invariant at the aggregate
  const netLeGross = L.totals.netPerDay <= L.totals.grossPerDay + 1e-9;
  console.log(`\nINVARIANT: aggregate net ${perDay(L.totals.netPerDay)} ≤ gross ${perDay(L.totals.grossPerDay)} → ${netLeGross ? 'HOLDS' : 'VIOLATED'}`);
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
