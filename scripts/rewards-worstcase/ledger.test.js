#!/usr/bin/env node
'use strict';
// Unit tests for the ledger aggregation: TESTED vs UNTOUCHED (zero-fill) net split, the unknown-net "—" path
// (excluded from totals and counted, never defaulted to 0), and net ≤ gross. Hand-computed synthetic rows.
const assert = require('assert');
const { aggregateLedger } = require('./lib/ledger');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

// 4 rows: two tested (fills>0), one zero-fill (unobserved), one unknown-net (fills but no +5m sample → null).
const rows = [
  { marketId: 'A', grossPerDay: 40, costPerDay: 1, netPerDay: 39, fills: 5, zeroFill: false },
  { marketId: 'B', grossPerDay: 10, costPerDay: 0, netPerDay: 10, fills: 2, zeroFill: false },
  { marketId: 'C', grossPerDay: 20, costPerDay: 0, netPerDay: 20, fills: 0, zeroFill: true },  // untouched
  { marketId: 'D', grossPerDay: 5, costPerDay: null, netPerDay: null, fills: 3, zeroFill: false }, // unknown → "—"
];

console.log('aggregateLedger — tested/untouched split, "—" exclusion, net ≤ gross');
{
  const a = aggregateLedger(rows);
  ok('unknown-net row excluded + counted (1)', a.unknownNet === 1);
  ok('totals exclude the unknown row: gross 70, cost 1, net 69', near(a.totals.grossPerDay, 70) && near(a.totals.costPerDay, 1) && near(a.totals.netPerDay, 69));
  ok('TESTED: 2 markets, 7 fills, net 49', a.split.tested.count === 2 && a.split.tested.fills === 7 && near(a.split.tested.netPerDay, 49));
  ok('UNTOUCHED: 1 market, net 20 (= gross, zero observed cost)', a.split.untouched.count === 1 && near(a.split.untouched.netPerDay, 20));
  ok('untouched net share = 20/69 = 28.99%', near(a.split.untouchedNetShare, 20 / 69));
  ok('aggregate net 69 ≤ gross 70 (invariant holds)', a.totals.netPerDay <= a.totals.grossPerDay + 1e-9);
}
console.log('all-untouched → net share 100%, all unobserved');
{
  const a = aggregateLedger([{ marketId: 'Z', grossPerDay: 5, costPerDay: 0, netPerDay: 5, fills: 0, zeroFill: true }]);
  ok('single zero-fill market → 100% of net is untouched/unobserved', a.split.tested.count === 0 && near(a.split.untouchedNetShare, 1));
}
console.log(`\nledger.test: ${n} assertions passed`);
