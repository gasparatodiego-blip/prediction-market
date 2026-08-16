#!/usr/bin/env node
'use strict';
// Unit tests for the fill score: percentile ranks (with null exclusion), the equal-weight composite, the
// "—" path when a feature is missing, and the AUC + its Hanley–McNeil confidence interval. Hand-computed.
const assert = require('assert');
const { computeFillScores, auc, aucSE, percentiles } = require('./lib/fillscore');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('percentiles — rank/(n-1), nulls excluded');
{
  const p = percentiles([10, 30, 20]);
  ok('[10,30,20] → [0, 1, 0.5]', near(p[0], 0) && near(p[1], 1) && near(p[2], 0.5));
  const p2 = percentiles([10, null, 20]);
  ok('null stays null (excluded)', near(p2[0], 0) && p2[1] === null && near(p2[2], 1));
}
console.log('computeFillScores — equal-weight composite, "—" on missing feature');
{
  const feats = [
    { marketId: 'HI', orderVsDepth: 10, volPerSample: 0.01, spreadTicks: 1 },   // high depth, high vol, narrow
    { marketId: 'LO', orderVsDepth: 1, volPerSample: 0.001, spreadTicks: 10 },   // low, low, wide
    { marketId: 'NA', orderVsDepth: 5, volPerSample: 0.005, spreadTicks: null }, // missing spread → "—"
  ];
  const s = computeFillScores(feats);
  const hi = s.find((x) => x.marketId === 'HI'), lo = s.find((x) => x.marketId === 'LO'), na = s.find((x) => x.marketId === 'NA');
  ok('HI (riskiest on all three) scores strictly above LO', hi.fillScore > lo.fillScore);
  ok('missing spread → fillScore null ("—", excluded + counted)', na.fillScore === null);
}
console.log('auc — filled vs unfilled discrimination + confidence');
{
  const scored = [{ marketId: 'A', fillScore: 0.9 }, { marketId: 'B', fillScore: 0.7 }, { marketId: 'C', fillScore: 0.4 }, { marketId: 'D', fillScore: 0.2 }];
  const perfect = auc(scored, new Set(['A', 'B']));
  ok('filled {A,B} strictly outrank unfilled {C,D} → AUC 1.0', near(perfect.auc, 1));
  const partial = auc(scored, new Set(['A', 'C']));
  ok('filled {A,C} vs {B,D} → 3 of 4 pairs → AUC 0.75', near(partial.auc, 0.75));
  ok('one class empty → AUC null (never a guess)', auc(scored, new Set()).auc === null);
  const se = aucSE(0.75, 2, 2);
  ok('Hanley–McNeil SE > 0 and the 95% CI brackets the AUC within [0,1]', se.se > 0 && se.ci95[0] >= 0 && se.ci95[1] <= 1 && se.ci95[0] <= 0.75 && se.ci95[1] >= 0.75);
}
console.log(`\nfillscore.test: ${n} assertions passed`);
