#!/usr/bin/env node
'use strict';
// Unit tests for the pre-backtest arithmetic: break-even win rate, per-share/per-cycle EV, and the win rate
// needed to beat ~4% risk-free. Hand-computed expected values.
const assert = require('assert');
const { breakEvenWinRate, evPerShare, evPerCycle, requiredWinRateToBeat } = require('./lib/arithmetic');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('break-even win rate = entry price (buy at 0.98 → must win 98%)');
{
  ok('breakEvenWinRate(0.98) = 0.98', near(breakEvenWinRate(0.98), 0.98));
  ok('at break-even EV/share = 0', near(evPerShare(0.98, 0.98), 0));
  ok('win rate 0.99 → EV/share = 0.99 − 0.98 = +0.01', near(evPerShare(0.99, 0.98), 0.01));
  ok('win rate 0.97 → EV/share = −0.01 (below break-even loses)', near(evPerShare(0.97, 0.98), -0.01, 1e-12));
}
console.log('EV per cycle for $10 (shares = 10/0.98 = 10.2041)');
{
  ok('at break-even EV/cycle = 0', near(evPerCycle(0.98, 0.98, 10), 0));
  ok('win rate 0.99 → EV/cycle = (10/0.98)·0.01 = $0.10204', near(evPerCycle(0.99, 0.98, 10), (10 / 0.98) * 0.01, 1e-9));
  ok('one loss (−0.98/share) erases 49 wins (+0.02/share): 0.98/0.02 = 49', near(0.98 / 0.02, 49));
}
console.log('win rate needed to beat 4%/yr at 288 cycles/day, $10, 0.98');
{
  const w = requiredWinRateToBeat(4, 288, 10, 0.98);
  // 0.98 + 0.04·0.98/(288·365) = 0.98 + 0.0392/105120 ≈ 0.98000037
  ok('≈ 0.98000037 — a hair above break-even (cycle count makes the margin negligible)', near(w, 0.98 + 0.04 * 0.98 / (288 * 365), 1e-12));
  ok('so the binding constraint is essentially w > 98%', w > 0.98 && w < 0.9801);
}
console.log(`\narithmetic.test: ${n} assertions passed`);
