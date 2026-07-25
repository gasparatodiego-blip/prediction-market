#!/usr/bin/env node
'use strict';
// Unit tests for markout (Phase 2) — hand-computed expected values. Deterministic (synthetic rows).
const assert = require('assert');
const { markoutForFill, distribution } = require('./lib/markout');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;
const R = (mins, adjMid) => ({ tsMs: mins * 60000, ts: new Date(mins * 60000).toISOString(), adjMid });

console.log('MARKOUT — adjMid, signed so adverse = NEGATIVE');
{
  // BUY filled at adjMid 0.50, 1000 shares. +1m 0.48 (fell → adverse), +5m 0.55 (rose → favourable).
  const rows = [R(0, 0.50), R(1, 0.48), R(5, 0.55), R(30, 0.50)];
  const fill = { marketId: 'M', side: 'buy', tsMs: 0, ts: rows[0].ts, price: 0.49, sizeShares: 1000, adjMidFill: 0.50, src: 'ws', inBand: true };
  const mo = markoutForFill(fill, rows);
  ok('buy +1m: (0.48−0.50)·100 = −2¢', near(mo.horizons['1m'].cents, -2));
  ok('buy +1m $: −0.02 × 1000 = −$20', near(mo.horizons['1m'].usd, -20));
  ok('buy +5m: (0.55−0.50)·100 = +5¢ (favourable)', near(mo.horizons['5m'].cents, 5));
  ok('buy +30m: (0.50−0.50)·100 = 0¢', near(mo.horizons['30m'].cents, 0));
}
{
  // SELL filled at 0.50: +1m 0.52 (rose → adverse for a short).
  const rows = [R(0, 0.50), R(1, 0.52)];
  const fill = { marketId: 'M', side: 'sell', tsMs: 0, ts: rows[0].ts, price: 0.51, sizeShares: 1000, adjMidFill: 0.50, src: 'ws', inBand: true };
  const mo = markoutForFill(fill, rows);
  ok('sell +1m: (0.50−0.52)·100 = −2¢ (adverse for short)', near(mo.horizons['1m'].cents, -2));
  ok('sell +1m $: −$20', near(mo.horizons['1m'].usd, -20));
}
console.log('MARKOUT — null / missing-sample horizon EXCLUDED (never interpolated)');
{
  const fill = { marketId: 'M', side: 'buy', tsMs: 0, ts: '', price: 0.49, sizeShares: 1000, adjMidFill: 0.5, src: 'ws', inBand: true };
  ok('no +1m sample → null', markoutForFill(fill, [R(0, 0.5)]).horizons['1m'] === null);
  const nullFill = { ...fill, adjMidFill: null };
  ok('null fill adjMid → excludedAll', markoutForFill(nullFill, [R(1, 0.5)]).excludedAll != null);
}
console.log('DISTRIBUTION — hand-computed');
{
  const d = distribution([-2, -1, 0, 1, 2]);
  ok('n=5, median 0, mean 0', d.n === 5 && near(d.median, 0) && near(d.mean, 0));
  ok('p25 −1, p75 +1', near(d.p25, -1) && near(d.p75, 1));
  ok('empty → all null (never fabricated 0)', distribution([]).median === null && distribution([]).n === 0);
}
console.log(`\nmarkout.test: ${n} assertions passed`);
