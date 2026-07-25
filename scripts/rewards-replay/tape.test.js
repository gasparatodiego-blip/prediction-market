#!/usr/bin/env node
'use strict';
// Unit tests for tape-based fills (Phase 3) — hand-computed, incl. PARTIAL fills and the null path.
const assert = require('assert');
const { reconstructTapeFillsForMarket } = require('./lib/tape');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

// journal: one interval [0min,1min], adjMid 0.50, tick 0.01, band [0.40,0.60].
const jrows = [
  { tsMs: 0, ts: '', marketId: 'M', tokenIdYes: 'T', adjMid: 0.50, tick: 0.01, bandLow: 0.40, bandHigh: 0.60 },
  { tsMs: 60000, ts: '', marketId: 'M', tokenIdYes: 'T', adjMid: 0.50, tick: 0.01, bandLow: 0.40, bandHigh: 0.60 },
];
const trade = (tsMs, price, size, side) => ({ tsMs, tsVenueIso: '', tsLocalIso: '', marketId: 'M', tokenId: 'T', price, size, side, src: 'ws:last_trade_price' });

console.log('TAPE FILLS — price-based, size-respecting (PARTIAL)');
{
  // offset 1¢ → bid 0.49, ask 0.51. size $1000 / price 0.50 = 2000 shares resting per side.
  // trade1 @0.48 size 500 (≤ bid) → BUY partial 500 (500 < 2000). trade2 @0.49 size 3000 → fills remaining 1500.
  const trades = [trade(10000, 0.48, 500, 'SELL'), trade(20000, 0.49, 3000, 'SELL'), trade(30000, 0.52, 800, 'BUY')];
  const r = reconstructTapeFillsForMarket(jrows, trades, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1e9 });
  const buys = r.fills.filter((f) => f.side === 'buy');
  const sells = r.fills.filter((f) => f.side === 'sell');
  ok('BUY fill #1 is partial 500 shares (print 500 < order 2000)', near(buys[0].sizeShares, 500) && buys[0].partial === true);
  ok('BUY fill #2 fills the remaining 1500 (min(1500, 3000))', near(buys[1].sizeShares, 1500));
  ok('total bought = 2000 (the full resting order, across 2 prints)', near(buys.reduce((s, f) => s + f.sizeShares, 0), 2000));
  ok('SELL: trade @0.52 ≥ ask 0.51 fills 800 (price-based)', sells.length === 1 && near(sells[0].sizeShares, 800));
  ok('partials counted', r.partials >= 1);
}
console.log('NULL PATH — a trade with a null price is EXCLUDED and counted, never defaulted');
{
  const trades = [trade(10000, null, 500, 'SELL')];
  const r = reconstructTapeFillsForMarket(jrows, trades, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 1e9 });
  ok('null-price trade excluded + counted, no fill', r.fills.length === 0 && r.excluded.reasons['trade null price/size'] === 1);
}
console.log('INVENTORY CAP — a fill is truncated to the cap room');
{
  // maxInventory $500 → 1000 shares cap. A print of 3000 @0.48 can only fill 1000 (the room).
  const trades = [trade(10000, 0.48, 3000, 'SELL')];
  const r = reconstructTapeFillsForMarket(jrows, trades, { offsetCents: 1, sizeUsd: 1000, maxInventoryUsd: 500 });
  ok('fill truncated to inventory room (1000 shares)', r.fills.length === 1 && near(r.fills[0].sizeShares, 1000));
}
console.log(`\ntape.test: ${n} assertions passed`);
