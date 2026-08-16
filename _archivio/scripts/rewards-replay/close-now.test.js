#!/usr/bin/env node
'use strict';
// Unit tests for the immediate-close exit: the book-walk cost, the STUCK path (size exceeds observed exit
// depth), and the NAKED-SHORT guard (an exit with no backing inventory is refused). Hand-computed values.
const assert = require('assert');
const { ladderFromRow, walk, closeFill, closeNowPolicy } = require('./lib/close-now');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

console.log('ladderFromRow — explicit levels + in-band residual at the band edge');
{
  const row = { levels: [{ bidPrice: 0.49, bidSizeAtLevel: 60, askPrice: 0.51, askSizeAtLevel: 70 }], bidDepthInBand: 100, askDepthInBand: 90, bandLow: 0.45, bandHigh: 0.55 };
  const bid = ladderFromRow(row, 'bid');
  ok('bid ladder: touch 0.49×60, then residual 40 @ bandLow 0.45', bid.length === 2 && near(bid[0].price, 0.49) && near(bid[0].size, 60) && near(bid[1].price, 0.45) && near(bid[1].size, 40) && bid[1].residual === true);
  const ask = ladderFromRow(row, 'ask');
  ok('ask ladder: touch 0.51×70, then residual 20 @ bandHigh 0.55', ask.length === 2 && near(ask[0].price, 0.51) && near(ask[1].price, 0.55) && near(ask[1].size, 20));
}

console.log('walk — absorbs, crosses levels, and gets stuck');
{
  const lad = [{ price: 0.49, size: 100 }, { price: 0.48, size: 200 }];
  ok('walk 50 @ touch → avg 0.49, no stuck', (() => { const w = walk(lad, 50); return near(w.filled, 50) && near(w.notional, 24.5) && near(w.avgPrice, 0.49) && w.stuck === 0; })());
  ok('walk 150 crosses → 100·0.49 + 50·0.48 = 73, avg 0.48667', (() => { const w = walk(lad, 150); return near(w.filled, 150) && near(w.notional, 73) && near(w.avgPrice, 73 / 150); })());
  ok('walk 500 > depth 300 → filled 300, STUCK 200', (() => { const w = walk(lad, 500); return near(w.filled, 300) && near(w.notional, 145) && near(w.stuck, 200); })());
}

console.log('closeFill BUY — realised spread paid, hand-computed');
{
  // long 100 sh bought at 0.50; bid book 0.49×60 then residual 40 @ 0.45. proceeds = 60·0.49 + 40·0.45 = 47.40.
  // cost basis 100·0.50 = 50. realisedPnL = 47.40 − 50 = −2.60; spreadPaid = 2.60.
  const row = { levels: [{ bidPrice: 0.49, bidSizeAtLevel: 60 }], bidDepthInBand: 100, bandLow: 0.45 };
  const r = closeFill({ side: 'buy', sizeShares: 100, price: 0.50, tsMs: 0 }, row);
  ok('closed 100, not stuck', near(r.closedShares, 100) && r.stuck === false);
  ok('exit avg 0.474', near(r.exitAvg, 0.474));
  ok('proceeds $47.40', near(r.proceeds, 47.40));
  ok('realised P&L −$2.60', near(r.realisedPnL, -2.60));
  ok('spread paid +$2.60 (certain, crossing down)', near(r.spreadPaid, 2.60));
}

console.log('closeFill BUY — STUCK when the book cannot absorb the exit');
{
  // long 200 sh; bid book only 0.49×60, no residual → close 60, STUCK 140.
  const row = { levels: [{ bidPrice: 0.49, bidSizeAtLevel: 60 }], bidDepthInBand: 60, bandLow: 0.45 };
  const r = closeFill({ side: 'buy', sizeShares: 200, price: 0.50, tsMs: 0 }, row);
  ok('closed 60, STUCK 140 (not silently filled)', near(r.closedShares, 60) && r.stuck === true && near(r.stuckShares, 140));
  ok('spread on the closed 60 only = 60·0.50 − 60·0.49 = 0.60', near(r.spreadPaid, 0.60));
}

console.log('NAKED-SHORT guard — a sell with no inventory is refused');
{
  const row = { levels: [{ askPrice: 0.51, askSizeAtLevel: 100 }], askDepthInBand: 100, bandHigh: 0.55 };
  const naked = closeFill({ side: 'sell', sizeShares: 50, price: 0.51, tsMs: 0 }, row, { held: 0 });
  ok('sell held 0 → naked short, REFUSED', naked.naked === true && naked.refused === true && naked.realisedPnL === null);
  const backed = closeFill({ side: 'sell', sizeShares: 50, price: 0.51, tsMs: 0 }, row, { held: 80 });
  ok('sell held 80 ≥ 50 → backed, not refused', backed.naked === false && backed.refused !== true && near(backed.backedShares, 50));
}

console.log('closeFill BUY — a favorable exit reports a signed gain (allocator floors it to 0 for net)');
{
  // bought at 0.50 but the nearest exit book bids 0.52 (sample drifted up) → proceeds 52 > cost 50 → gain.
  const row = { levels: [{ bidPrice: 0.52, bidSizeAtLevel: 1000 }], bidDepthInBand: 1000, bandLow: 0.45 };
  const r = closeFill({ side: 'buy', sizeShares: 100, price: 0.50, tsMs: 0 }, row);
  ok('signed realised P&L = +$2.00, spreadPaid = −$2.00 (favorable, transparent)', near(r.realisedPnL, 2.00) && near(r.spreadPaid, -2.00));
  ok('the allocator floors cost = max(0, spreadPaid) = 0 → net ≤ gross preserved', Math.max(0, r.spreadPaid) === 0);
}

console.log('closeNowPolicy — buys close, sells naked-refused under immediate-close');
{
  const rows = [{ ts: '', tsMs: 0, marketId: 'M', levels: [{ bidPrice: 0.49, bidSizeAtLevel: 1000, askPrice: 0.51, askSizeAtLevel: 1000 }], bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55 }];
  const byMarket = new Map([['M', rows]]);
  const fills = [
    { marketId: 'M', side: 'buy', sizeShares: 100, price: 0.50, tsMs: 1000 },
    { marketId: 'M', side: 'sell', sizeShares: 40, price: 0.50, tsMs: 2000 },
  ];
  const p = closeNowPolicy(fills, byMarket);
  ok('2 fills: 1 buy closed, 1 sell naked-refused', p.aggregate.fills === 2 && p.aggregate.closed === 1 && p.aggregate.nakedRefused === 1);
  ok('buy spread = 100·0.50 − 100·0.49 = $1.00 (touch absorbs it)', near(p.aggregate.spreadPaid, 1.00) && near(p.spreadByMarket.get('M'), 1.00));
}

console.log(`\nclose-now.test: ${n} assertions passed`);
