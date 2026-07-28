#!/usr/bin/env node
'use strict';
// Unit tests for the pre-fill features: stdev/median, realised-vol structure (max jump, stability, the "—"
// path under a short span), time-to-resolution buckets, and the distribution aggregator. Hand-computed.
const assert = require('assert');
const { realisedVol, ttrBuckets, distribution, stdev, median } = require('./lib/features');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('stdev / median');
{
  ok('stdev([2,4,4,4,5,5,7,9]) = 2 (population)', near(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2));
  ok('stdev of a single element = null', stdev([5]) === null);
  ok('median odd = middle; even = lower-middle', median([1, 2, 3]) === 2 && median([1, 2, 3, 4]) === 2);
}
console.log('realisedVol — max jump, stability, short-span "—"');
{
  const v = realisedVol([0.40, 0.45, 0.40, 0.60, 0.80].map((m) => ({ adjMid: m })));
  // changes [0.05,-0.05,0.20,0.20]; 1st half sd = 0.05, 2nd half sd = 0 → stability 0; max jump 0.20
  ok('max single jump = 0.20', near(v.maxJump, 0.20));
  ok('stability = 2nd-half vol / 1st-half vol = 0/0.05 = 0', near(v.stability, 0));
  ok('< 4 samples → all null (excluded, never a guessed 0)', realisedVol([{ adjMid: 0.5 }, { adjMid: 0.6 }]).perSample === null);
}
console.log('ttrBuckets — the operator’s <15-day count, with unknown counted');
{
  const feats = [{ ttrDays: 5 }, { ttrDays: 14.9 }, { ttrDays: 20 }, { ttrDays: 90 }, { ttrDays: 100 }, { ttrDays: null }];
  const b = ttrBuckets(feats);
  ok('<15: 2 (5, 14.9)', b.under15 === 2);
  ok('15–90: 2 (20, 90)', b.from15to90 === 2);
  ok('>90: 1 (100)', b.over90 === 1);
  ok('unknown counted, never bucketed: 1', b.unknown === 1);
}
console.log('distribution — quantiles with nulls excluded and counted');
{
  const d = distribution([{ x: 10 }, { x: 20 }, { x: 30 }, { x: null }], 'x');
  ok('n=3, nulls=1 (the null excluded and counted)', d.n === 3 && d.nulls === 1);
  ok('min 10, median 20, max 30', d.min === 10 && d.median === 20 && d.max === 30);
}
console.log(`\nfeatures.test: ${n} assertions passed`);
