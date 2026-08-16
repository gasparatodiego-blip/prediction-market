#!/usr/bin/env node
'use strict';
// Unit tests for the daily decomposition: calendar-day overlap segments, the daily stats, and dailyNet's
// span-proportional gross accrual with real adverse fills. Hand-computed synthetic data.
const assert = require('assert');
const { dayOverlaps, stats, dailyNet } = require('./lib/daily');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

console.log('dayOverlaps — splits a span across UTC calendar days with hours');
{
  const o = dayOverlaps(Date.parse('2026-07-25T22:00:00Z'), Date.parse('2026-07-26T02:00:00Z'));
  ok('22:00→02:00 next day → [25:2h, 26:2h]', o.length === 2 && o[0].dayKey === '2026-07-25' && near(o[0].hours, 2) && o[1].dayKey === '2026-07-26' && near(o[1].hours, 2));
  const o2 = dayOverlaps(Date.parse('2026-07-25T00:00:00Z'), Date.parse('2026-07-27T00:00:00Z'));
  ok('two full days → [25:24h, 26:24h]', o2.length === 2 && near(o2[0].hours, 24) && near(o2[1].hours, 24));
}
console.log('stats — mean/median/stdev/min/max (population stdev)');
{
  const s = stats([10, 20, 30]);
  ok('mean 20, median 20, min 10, max 30', near(s.mean, 20) && near(s.median, 20) && s.min === 10 && s.max === 30);
  ok('population stdev = sqrt((100+0+100)/3) = 8.16497', near(s.stdev, Math.sqrt(200 / 3)));
  ok('empty → nulls', stats([]).mean === null && stats([]).stdev === null);
}
console.log('dailyNet — span-proportional gross, per day; zero fills → net = gross');
{
  const row = (tsMs) => ({ ts: new Date(tsMs).toISOString(), tsMs, marketId: 'M', tokenIdYes: 'TK', adjMid: 0.5, bidDepthInBand: 100, askDepthInBand: 100, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws' });
  const byMarket = new Map([['M', [row(Date.parse('2026-07-25T00:00:00Z')), row(Date.parse('2026-07-27T00:00:00Z'))]]]);
  const marketTokens = new Map([['M', 'TK']]);
  const tapeByToken = new Map(); // no trades → 0 fills
  const alloc = [{ marketId: 'M', sizeUsd: 100, grossPerDay: 24, net5m: 24, fills: 0 }];
  const dn = dailyNet(alloc, byMarket, marketTokens, tapeByToken, {});
  ok('two day-buckets, each net = gross $24 (24h × $24/24)', dn.days.length === 2 && near(dn.days[0].net, 24) && near(dn.days[1].net, 24));
  ok('daily stats: min 24, max 24, stdev 0 (no losing day)', near(dn.daily.min, 24) && near(dn.daily.max, 24) && near(dn.daily.stdev, 0));
  ok('no fills → worstFill null (never a fabricated 0)', dn.worstFill === null);
  ok('worst/best market = M at $24', near(dn.worstMarket.net, 24) && near(dn.bestMarket.net, 24));
}
console.log(`\ndaily.test: ${n} assertions passed`);
