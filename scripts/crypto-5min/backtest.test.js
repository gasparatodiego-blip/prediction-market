#!/usr/bin/env node
'use strict';
// Unit tests for the base backtest: entry fill, every SKIP path (counted, never filled), win/loss P&L, and
// the distribution stats (worst cycle, longest losing streak, max drawdown). Hand-computed synthetic cycles.
const assert = require('assert');
const { replayCycle, runBacktest, longestLosingStreak, maxDrawdown } = require('./lib/backtest');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;
const cyc = (o) => ({ marketId: 'M', asset: 'BTC', windowEndEpoch: 1000, tick: 0.01, samples: [], settlement: 'Up', ...o });

console.log('ENTRY — fills at the observed 0.98 ask, holds to settlement');
{
  const up = replayCycle(cyc({ samples: [{ secToExpiry: 30, ask: 0.98, depthUsd: 100 }], settlement: 'Up' }));
  ok('Up → entered, fill 0.98, shares 10/0.98, pnl = shares·0.02', up.status === 'entered' && near(up.fillAsk, 0.98) && near(up.shares, 10 / 0.98) && near(up.pnl, (10 / 0.98) * 0.02));
  const dn = replayCycle(cyc({ samples: [{ secToExpiry: 30, ask: 0.98, depthUsd: 100 }], settlement: 'Down' }));
  ok('Down → loss = −$10 (full stake), pnl = −shares·0.98', dn.status === 'entered' && !dn.win && near(dn.pnl, -10));
}
console.log('SKIP paths — each fires independently and is COUNTED, never filled');
{
  ok('ask never in [0.98,0.989] → skipped', replayCycle(cyc({ samples: [{ secToExpiry: 30, ask: 0.95, depthUsd: 100 }] })).status === 'skipped');
  ok('depth < $10 at the 0.98 ask → skipped', (() => { const r = replayCycle(cyc({ samples: [{ secToExpiry: 30, ask: 0.98, depthUsd: 5 }] })); return r.status === 'skipped' && /depth/.test(r.reason); })());
  ok('no sample inside the final 47s → skipped', (() => { const r = replayCycle(cyc({ samples: [{ secToExpiry: 60, ask: 0.98, depthUsd: 100 }] })); return r.status === 'skipped' && /final 47s/.test(r.reason); })());
  ok('settlement unknown → skipped', replayCycle(cyc({ samples: [{ secToExpiry: 30, ask: 0.98, depthUsd: 100 }], settlement: null })).status === 'skipped');
  ok('no samples at all → skipped', replayCycle(cyc({ samples: [] })).status === 'skipped');
}
console.log('DISTRIBUTION — worst cycle, longest losing streak, max drawdown');
{
  const W = (10 / 0.98) * 0.02, L = -10;
  // ordered pnls: +W +W −10 +W −10 −10 +W  (4 wins, 3 losses; losing streak of 2 at the end-middle)
  const seq = ['Up', 'Up', 'Down', 'Up', 'Down', 'Down', 'Up'];
  const cycles = seq.map((s, i) => cyc({ marketId: 'M' + i, windowEndEpoch: 1000 + i, samples: [{ secToExpiry: 20, ask: 0.98, depthUsd: 100 }], settlement: s }));
  const r = runBacktest(cycles);
  ok('7 observed, 7 entered, 0 skipped', r.cyclesObserved === 7 && r.entered === 7 && r.skipped === 0);
  ok('4 wins / 3 losses, win rate 4/7', r.wins === 4 && r.losses === 3 && near(r.winRate, 4 / 7));
  ok('worst single cycle = −$10', near(r.worstCycle.pnl, L));
  ok('longest losing streak = 2', r.longestLosingStreak === 2);
  // equity path: W,2W,2W−10,3W−10,3W−20,3W−30,4W−30 ; peak = 2W ; trough = 3W−30 ; mdd = 2W−(3W−30)=30−W
  ok('max drawdown = 30 − W', near(r.maxDrawdown, 30 - W));
  ok('gross P&L = 4W − 30', near(r.grossPnl, 4 * W - 30));
}
console.log('EMPTY — nothing entered → rates are null, never a fake 0/0');
{
  const r = runBacktest([cyc({ samples: [{ secToExpiry: 30, ask: 0.95, depthUsd: 100 }] })]);
  ok('all skipped → winRate null, grossPnl null, maxDrawdown null', r.entered === 0 && r.winRate === null && r.grossPnl === null && r.maxDrawdown === null && r.skipped === 1);
}
console.log(`\nbacktest.test: ${n} assertions passed`);
