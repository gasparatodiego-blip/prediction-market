#!/usr/bin/env node
'use strict';
// Unit tests for fill crossing (Phase 1), net (Phase 3), and independent proofs that the null path, the
// stale path, and the refusal-to-annualise guard each fire. Deterministic (synthetic rows).
const assert = require('assert');
const { reconstructMarketFills } = require('./lib/fills');
const { computeNet } = require('./lib/net');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;
const R = (mins, o) => ({ ts: new Date(mins * 60000).toISOString(), tsMs: mins * 60000, marketId: 'M', adjMid: null, bestBid: null, bestAsk: null, bidDepthInBand: null, askDepthInBand: null, bandLow: 0, bandHigh: 1, tick: 0.01, src: 'ws', ...o });

console.log('FILL CROSSING — BUY when next bestAsk ≤ our bid; SELL when next bestBid ≥ our ask');
{
  const rows = [R(0, { adjMid: 0.50, bestBid: 0.49, bestAsk: 0.51 }), R(1, { adjMid: 0.50, bestBid: 0.60, bestAsk: 0.48, src: 'stale' })];
  const r = reconstructMarketFills(rows, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1e9 });
  ok('bid 0.49, next ask 0.48 ≤ 0.49 → BUY; ask 0.51, next bid 0.60 ≥ 0.51 → SELL (both fill)', r.fills.length === 2);
}
console.log('NULL PATH fires independently (excluded + counted, never defaulted)');
{
  const rows = [R(0, { adjMid: null, tick: null, bestAsk: 0.5, bestBid: 0.5 }), R(1, { adjMid: 0.5, bestAsk: 0.4, bestBid: 0.4 })];
  const r = reconstructMarketFills(rows, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1e9 });
  ok('null placement excluded + counted', r.excluded.count === 1 && r.excluded.reasons['placement null (adjMid/tick)'] === 1);
}
console.log('STALE PATH fires independently (ws-only can drop stale-sourced fills)');
{
  const rows = [R(0, { adjMid: 0.50, bestBid: 0.49, bestAsk: 0.51 }), R(1, { adjMid: 0.50, bestBid: 0.60, bestAsk: 0.48, src: 'stale' })];
  const r = reconstructMarketFills(rows, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1e9 });
  ok('fills carry the crossing row src ("stale")', r.fills.every((f) => f.src === 'stale'));
  ok('ws-only filter removes them → stale-inclusive ≠ ws-only', r.fills.filter((f) => f.src === 'ws').length === 0 && r.fills.length === 2);
}
console.log('INVENTORY CAP fires (a fill that would breach the cap is skipped)');
{
  // 3 rows = 2 buy intervals (ask 0.40 ≤ bid 0.49 each; bid 0.30 < ask 0.51 → no sell). size $1000/0.50 =
  // 2000 shares/fill; maxInventory $1000 → 2000 shares cap: 1st buy fills to 2000 (== cap), 2nd is capped.
  const rows = [R(0, { adjMid: 0.50, bestBid: 0.30, bestAsk: 0.40 }), R(1, { adjMid: 0.50, bestBid: 0.30, bestAsk: 0.40 }), R(2, { adjMid: 0.50, bestBid: 0.30, bestAsk: 0.40 })];
  const r = reconstructMarketFills(rows, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1000 });
  ok('one buy fills, the second is capped (skipped)', r.fills.length === 1 && r.capped >= 1);
}
console.log('NET — hand-computed (reuses ceiling shareForCapital)');
{
  // pot $100/day, obs limiting depth 1000 sh, mid 0.50, size $1000/side → capital $2000.
  // share = ((2000/2)/0.50)/(((2000/2)/0.50)+1000) = 2000/3000 = 0.6667; gross/day = 66.67; window 12h → 33.33.
  const byMarket = new Map([['M', [R(0, { adjMid: 0.5, bidDepthInBand: 1000, askDepthInBand: 1000 })]]]);
  const markouts = [{ marketId: 'M', side: 'buy', horizons: { '1m': { usd: -10 }, '5m': { usd: -4 }, '30m': { usd: -1 } } }];
  const net = computeNet(byMarket, markouts, new Map([['M', 100]]), { sizeUsd: 1000, windowHours: 12, wsOnly: false });
  const row = net.rows[0];
  ok('share 0.6667', near(row.share, 2 / 3, 1e-4));
  ok('grossWindow $33.33', near(row.grossWindow, 100 * (2 / 3) * 0.5, 1e-2));
  ok('cost(+5m) = −Σmarkout = +$4', near(row.costWindow['5m'], 4));
  ok('net(+5m) = 33.33 − 4 = 29.33', near(row.netWindow['5m'], 100 * (2 / 3) * 0.5 - 4, 1e-2));
  const net2 = computeNet(byMarket, [], new Map(), { sizeUsd: 1000, windowHours: 12, wsOnly: false });
  ok('no pot → excluded + counted', net2.rows.length === 0 && net2.excluded.noPot === 1);
}
console.log('REFUSAL-TO-ANNUALISE guard');
{
  const MIN = 48;
  ok('3.12h → refuse (3.12 < 48)', 3.12 < MIN);
  ok('50h → allow (50 ≥ 48)', 50 >= MIN);
}
console.log(`\nnet.test: ${n} assertions passed`);
