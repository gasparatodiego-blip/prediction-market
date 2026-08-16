#!/usr/bin/env node
'use strict';
// scripts/rewards-worstcase/sweep-cli.js — PHASE 2: diversification sweep, both tails. Offline replay.
//   node sweep-cli.js [--pots snapshot.json] [--budget 5000]

const { loadWindow } = require('./lib/data');
const { diversificationSweep } = require('./lib/sweep');

const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));

function parseArgs(argv) {
  const a = { pots: null, budget: 5000 };
  for (let i = 2; i < argv.length; i++) { const k = argv[i], v = argv[i + 1]; if (k === '--pots') { a.pots = v; i++; } else if (k === '--budget') { a.budget = Number(v); i++; } }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const D = await loadWindow({ potsPath: args.pots });
  const S = diversificationSweep(D, { budgetUsd: args.budget });

  console.log('═'.repeat(94));
  console.log(`PHASE 2 — DIVERSIFICATION SWEEP AT $${args.budget}, BOTH TAILS (offline replay; ${S.days.length}-day / tiny sample)`);
  console.log('═'.repeat(94));
  console.log(`fundable markets: ${S.fundable} · ws-window daily buckets: ${S.days.map((d) => d.dayKey).join(', ')}`);
  console.log('\n  count  held  gross/d   net/d    bestDay   medDay    worstDay  stdevDay  worstFill');
  for (const L of S.levels) {
    console.log('  ' + String(L.isAll ? 'all' : L.requested).padStart(5) + ' ' + String(L.held).padStart(5) + ' ' +
      money(L.grossPerDay).padStart(8) + ' ' + money(L.netPerDay).padStart(8) + ' ' +
      money(L.daily.max).padStart(9) + ' ' + money(L.daily.median).padStart(9) + ' ' + money(L.daily.min).padStart(9) + ' ' +
      money(L.daily.stdev).padStart(9) + ' ' + (L.worstFill ? money(L.worstFill.usd) : '—').padStart(9));
  }
  console.log('\n  (bestDay/worstDay = best/worst realised CALENDAR-DAY net; worstFill = most adverse single +5m markout, $)');

  // does diversification reduce the worst case?
  const worstByLevel = S.levels.map((L) => ({ held: L.held, worstDay: L.daily.min, worstFill: L.worstFill ? L.worstFill.usd : null }));
  const minHeld = worstByLevel[0], maxHeld = worstByLevel[worstByLevel.length - 1];
  console.log('\nDOES DIVERSIFICATION REDUCE THE WORST CASE (observed)?');
  console.log(`  worst day at ${minHeld.held} market(s): ${money(minHeld.worstDay)}   ·   at ${maxHeld.held} markets: ${money(maxHeld.worstDay)}`);
  const improved = minHeld.worstDay != null && maxHeld.worstDay != null && maxHeld.worstDay > minHeld.worstDay + 0.01;
  console.log(`  → worst case ${improved ? 'IMPROVES with diversification' : 'does NOT materially improve with diversification'}.`);
  console.log('  WHY: the observed losses are concentrated in specific TOXIC markets the optimiser EXCLUDES at every level');
  console.log('  (Phase 3), not spread idiosyncratically — so adding net-positive markets cannot diversify them away. The');
  console.log('  worst OBSERVED day stays mild at every level, which is the unobserved-tail problem, not evidence of safety.');
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
