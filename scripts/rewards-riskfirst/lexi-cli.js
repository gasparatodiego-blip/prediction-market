#!/usr/bin/env node
'use strict';
// scripts/rewards-riskfirst/lexi-cli.js — PHASE 4: the risk-first (lexicographic) allocation vs reward-only,
// the price of safety in dollars, and the max-quiet variant. Offline replay.
//   node lexi-cli.js [--pots snapshot.json]

const fs = require('fs');
const { loadWindow } = require('../rewards-worstcase/lib/data');
const { allocateAt, maxQuiet } = require('./lib/lexi');

const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const pct = (x) => (x == null ? '—' : x > 200 ? '>200%/yr' : x.toFixed(1) + '%/yr');
function parseArgs(argv) { const a = { pots: null }; for (let i = 2; i < argv.length; i++) if (argv[i] === '--pots') { a.pots = argv[i + 1]; i++; } return a; }
function maxSpreadMap(potsPath) {
  const m = new Map();
  if (potsPath) { const s = JSON.parse(fs.readFileSync(potsPath, 'utf8')); for (const [c, o] of Object.entries(s.byCond)) if (o.maxSpread != null) m.set(c, o.maxSpread); }
  try { const b = JSON.parse(fs.readFileSync('/root/prediction-market/data/liquidity-rewards.json', 'utf8')); for (const x of b.markets || []) if (!m.has(x.conditionId) && x.rewardsMaxSpread != null) m.set(x.conditionId, x.rewardsMaxSpread); } catch {}
  return m;
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const BUDGET = 5000;
  const msMap = maxSpreadMap(args.pots);

  console.log('═'.repeat(92));
  console.log('PHASE 4 — RISK-FIRST (LEXICOGRAPHIC) ALLOCATION vs REWARD-ONLY, WITH THE PRICE OF SAFETY');
  console.log('═'.repeat(92));
  console.log('COVERAGE:'); for (const l of D.coverage.headerLines) console.log('  ' + l);
  console.log(`  TRUE ${D.coverage.truePct}% — PARTIAL. ws/stale ${(D.staleFrac * 100).toFixed(1)}%${D.staleFrac > 0.2 ? ' ⚠' : ' trusted'}.`);

  // REWARD-ONLY baseline (today's allocator: full deploy, offset 1c)
  const rewardOnly = allocateAt(D, { tolerance: 1.0, offsetCents: 1, budget: BUDGET });
  console.log('\nREWARD-ONLY (today): ' + `${rewardOnly.marketsHeld} markets · deploy ${money(rewardOnly.deployed)} · offset 1¢ · gross ${money(rewardOnly.grossPerDay)}/d · net ${money(rewardOnly.netPerDay)}/d · struct bound ${money(rewardOnly.structuralBound)} · expected fills ${rewardOnly.expectedFills}`);
  if (rewardOnly.netPerDay > rewardOnly.grossPerDay + 1e-9) console.log('  ⚠ net > gross — INVARIANT VIOLATED');
  else console.log('  invariant net ≤ gross: HOLDS');

  // RISK-FIRST GRID: (capital tolerance) × (offset), band-honest — objective (1) then (2), reward within
  console.log('\nRISK-FIRST GRID (tolerance = max structural loss %; offset = fill lever; band-honest: offset > maxSpread/2 excludes the market):');
  console.log('  tol   offset  deploy   markets  bandXcl  bound     net/day   fills   price-of-safety vs reward-only');
  const grid = [[0.50, 1], [0.50, 2], [0.25, 1], [0.25, 2], [0.10, 1]];
  for (const [tol, off] of grid) {
    const p = allocateAt(D, { tolerance: tol, offsetCents: off, budget: BUDGET, maxSpreadByMarket: msMap });
    const price = rewardOnly.netPerDay - p.netPerDay;
    console.log('  ' + (tol * 100 + '%').padStart(4) + '  ' + (off + '¢').padStart(6) + '  ' + money(p.deployed).padStart(8) + '  ' +
      String(p.marketsHeld).padStart(7) + '  ' + String(p.excludedBand).padStart(7) + '  ' + money(p.structuralBound).padStart(8) + '  ' + money(p.netPerDay).padStart(8) + '  ' +
      String(p.expectedFills).padStart(6) + '   ' + (Math.abs(price) < 0.005 ? 'free' : (price < 0 ? '+' : '-') + money(Math.abs(price)) + '/day'));
  }
  console.log('  → 50%/1¢ = reward-only (free preservation, all bands hold 1¢). Tightening capital or widening the offset');
  console.log('    (which drops narrow-band markets) costs measured reward — priced above; that is the price of safety.');

  // MAX-QUIET: minimise fills subject only to clearing ~4% risk-free (band-honest)
  const mq = maxQuiet(D, { budget: BUDGET, riskFreePct: 4, offsets: [1, 2, 3], maxSpreadByMarket: msMap });
  console.log('\nMAX-QUIET (minimise expected fills subject only to net > ~4% risk-free) — "earn while left alone":');
  console.log('  offset  deploy   net/day   annualised     fills   clears 4%?');
  for (const s of mq.sweep) console.log('  ' + (s.offsetCents + '¢').padStart(6) + '  ' + money(s.deployed).padStart(8) + '  ' + money(s.netPerDay).padStart(8) + '  ' + pct(s.annualPct).padStart(12) + '  ' + String(s.expectedFills).padStart(6) + '   ' + (s.clearsRiskFree ? 'yes' : 'NO'));
  if (mq.chosen) console.log(`  → MAX-QUIET pick: offset ${mq.chosen.offsetCents}¢ — ${mq.chosen.expectedFills} expected fills, net ${money(mq.chosen.netPerDay)}/day (${pct(mq.chosen.annualPct)}), still clears ~4%.`);
  else console.log('  → no offset both minimises fills and clears 4% in this window.');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
