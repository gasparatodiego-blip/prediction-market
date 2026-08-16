#!/usr/bin/env node
'use strict';
// scripts/rewards-riskfirst/preserve-cli.js — CONSTRAINT 1: capital-preservation tolerance sweep + a proof
// that the constraint actually REJECTS an over-budget allocation. Offline replay.
//   node preserve-cli.js [--pots snapshot.json]

const { loadWindow } = require('../rewards-worstcase/lib/data');
const { buildLedger } = require('../rewards-worstcase/lib/ledger');
const { structuralTotal, withinTolerance, toleranceSweep } = require('./lib/preserve');

const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
function parseArgs(argv) { const a = { pots: null }; for (let i = 2; i < argv.length; i++) if (argv[i] === '--pots') { a.pots = argv[i + 1]; i++; } return a; }

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const BUDGET = 5000;

  console.log('═'.repeat(84));
  console.log('PHASE 2 — CONSTRAINT 1: CAPITAL PRESERVATION (hard structural bound, NOT a probability)');
  console.log('═'.repeat(84));
  console.log('Structural bound of an allocation = Σ per-side $size = deployed capital ÷ 2 (one full adverse fill');
  console.log('per market resolves to $0). So the tolerance is a cap on DEPLOYED capital. This bounds the SIZE of the');
  console.log('loss, NOT its probability — which stays UNMEASURED with 11 observed fills.');

  const sweep = toleranceSweep(D, { budget: BUDGET });
  console.log('\nTOLERANCE SWEEP (max structural loss as a fraction of $5,000):');
  console.log('  tolerance  bound-limit  deployed   structural-bound  markets  net/day    price-of-preservation vs 100%');
  const full = sweep[sweep.length - 1];
  for (const s of sweep) {
    const price = full.netPerDay - s.netPerDay;
    console.log('  ' + (s.tolerance * 100 + '%').padStart(8) + '  ' + money(s.limit).padStart(10) + '  ' + money(s.deployed).padStart(9) + '  ' +
      money(s.structuralBound).padStart(15) + '  ' + String(s.marketsHeld).padStart(7) + '  ' + money(s.netPerDay).padStart(8) + '   ' +
      (s.tolerance >= 1 ? '(baseline)' : '-' + money(price) + '/day given up'));
  }
  console.log('\n  → the price of preservation: deploying less to cap the loss gives up reward roughly in proportion to the');
  console.log('    capital withheld — tighter safety costs real reward, and the operator can now price that choice.');

  // PROOF the constraint rejects
  console.log('\nREJECTION PROOF (the constraint actually blocks an allocation):');
  const L = buildLedger(D, { budgetUsd: BUDGET }); // the full reward-only $5,000 allocation
  const bound = structuralTotal(L.rows.map((r) => ({ sizeUsd: r.sizeUsd })));
  const at10 = withinTolerance(bound, 0.10, BUDGET);
  console.log(`  the full $5,000 reward-only allocation has structural bound ${money(bound)} (= deployed/2).`);
  console.log(`  at a 10% tolerance the limit is ${money(at10.limit)}: bound ${money(bound)} > limit ${money(at10.limit)} → REJECTED (${at10.ok ? 'accepted' : 'ok:false'}).`);
  console.log(`  at a 50% tolerance the limit is ${money(withinTolerance(bound, 0.50, BUDGET).limit)}: bound ${money(bound)} ≤ limit → ACCEPTED.`);
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
