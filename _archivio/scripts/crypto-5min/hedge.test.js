#!/usr/bin/env node
'use strict';
// Unit tests for the 4% drawdown rule: crossing arithmetic (worked pair), hedge sizing, hedge fill
// (full/partial/FAILED — never assumed), the combined P&L, and that the SAME crossing the maker refuses at
// arming (lib/maker/inventory-guard.findSelfMatches) flags this pair. Hand-computed expected values.
const assert = require('assert');
const { crossingLossPerPair, crosses, hedgeSizeToOffset, hedgeFill, pairPnl } = require('./lib/arithmetic');
const { replayCycleWithHedge } = require('./lib/backtest');
const { findSelfMatches } = require('../../lib/maker/inventory-guard'); // the shipped crossing guard (cited, exercised)

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

console.log('CROSSING — a worked pair: YES 0.98 + NO 0.06 pays 1.04 for a $1 payout');
{
  ok('crossingLossPerPair(0.98,0.06) = 0.04 guaranteed loss / pair', near(crossingLossPerPair(0.98, 0.06), 0.04));
  ok('crosses(0.98,0.06) = true (sum 1.04 ≥ 1)', crosses(0.98, 0.06) === true);
  ok('crosses(0.98,0.01) = false (sum 0.99 < 1)', crosses(0.98, 0.01) === false);
  ok('p+q ≤ 1 → no crossing loss', crossingLossPerPair(0.98, 0.02) === 0);
  // total locked loss over min(y,n) matched pairs: 0.04 × min(10/0.98, 10/0.94) = 0.04 × 10.20408 = 0.408163
  const y = 10 / 0.98, nn = 10 / 0.94;
  ok('total locked crossing loss = 0.04 × 10.20408 = $0.408163', near(0.04 * Math.min(y, nn), 0.408163, 1e-5));
}
console.log('CROSSING GUARD — the shipped maker guard refuses this exact pair (cited, not reimplemented)');
{
  const sm = findSelfMatches([{ book: 'yes', kind: 'buy', price: 0.98 }, { book: 'no', kind: 'buy', price: 0.06 }]);
  ok('findSelfMatches flags YES 0.98 + NO 0.06 as a self-cross, sum 1.04', sm.length === 1 && near(sm[0].sum, 1.04));
  const okPair = findSelfMatches([{ book: 'yes', kind: 'buy', price: 0.98 }, { book: 'no', kind: 'buy', price: 0.01 }]);
  ok('sum 0.99 → not flagged (no cross)', okPair.length === 0);
}
console.log('HEDGE SIZING + FILL against real depth');
{
  ok('hedgeSizeToOffset($10, 0.06) = 10/0.94 = 10.6383 NO shares', near(hedgeSizeToOffset(10, 0.06), 10 / 0.94));
  const full = hedgeFill(10 / 0.94, 0.06, 100);
  ok('depth $100 ≥ need → FULL, cost = shares·0.06', full.status === 'full' && near(full.filledShares, 10 / 0.94) && near(full.cost, (10 / 0.94) * 0.06));
  const part = hedgeFill(10 / 0.94, 0.06, 0.30);
  ok('depth $0.30 < need → PARTIAL, filled 0.30/0.06 = 5', part.status === 'partial' && near(part.filledShares, 5) && near(part.cost, 0.30));
  const fail = hedgeFill(10 / 0.94, 0.06, 0);
  ok('depth $0 → FAILED, 0 filled (never assumed)', fail.status === 'failed' && fail.filledShares === 0);
}
console.log('COMBINED P&L — the rule CAPS the tail but locks a loss (recovers nothing)');
{
  const y = 10 / 0.98, nn = 10 / 0.94;
  ok('Up → −$0.434216 (the NO premium; hedging turned the likely win into a loss)', near(pairPnl(y, 0.98, nn, 0.06, 'Up'), -0.434216));
  ok('Down → $0.00 (the hedge offsets the full stake exactly)', near(pairPnl(y, 0.98, nn, 0.06, 'Down'), 0));
}
console.log('replayCycleWithHedge — end to end');
{
  const mk = (o) => ({ marketId: 'M', asset: 'BTC', windowEndEpoch: 1000, tick: 0.01, samples: [{ secToExpiry: 30, ask: 0.98, depthUsd: 100 }], settlement: 'Up', ...o });
  const up = replayCycleWithHedge(mk({ settlement: 'Up', drawdown: { yesMid: 0.94, noAsk: 0.06, noDepthUsd: 100 } }));
  ok('trigger + full hedge + Up → pnl −$0.434216, crosses true', up.hedge.triggered && up.hedge.status === 'full' && up.hedge.crosses && near(up.pnl, -0.434216));
  const dn = replayCycleWithHedge(mk({ settlement: 'Down', drawdown: { yesMid: 0.94, noAsk: 0.06, noDepthUsd: 100 } }));
  ok('trigger + full hedge + Down → pnl $0.00', near(dn.pnl, 0));
  const noTrig = replayCycleWithHedge(mk({ drawdown: { yesMid: 0.97, noAsk: 0.03, noDepthUsd: 100 } }));
  ok('down only 1.02% ≤ 4% → NOT triggered, pnl = unhedged win 0.204082', noTrig.hedge.triggered === false && near(noTrig.pnl, (10 / 0.98) * 0.02));
  const failed = replayCycleWithHedge(mk({ drawdown: { yesMid: 0.94, noAsk: 0.06, noDepthUsd: 0 } }));
  ok('hedge FAILS (no depth) → 0 filled, position left UNHEDGED (pnl = base win, not assumed filled)', failed.hedge.triggered && failed.hedge.status === 'failed' && failed.hedge.filledShares === 0 && near(failed.pnl, (10 / 0.98) * 0.02));
}
console.log(`\nhedge.test: ${n} assertions passed`);
