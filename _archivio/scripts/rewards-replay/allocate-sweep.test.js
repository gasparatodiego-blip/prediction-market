#!/usr/bin/env node
'use strict';
// Unit tests for the fixed-budget allocation sweep: the (count × budget) frontier with hand-computed optima
// (including the case where MORE markets does not help under a tight budget), saturationCapital via the
// ceiling's capitalForShare, and the single-market size sweep with hand-computed marginal net per dollar.
const assert = require('assert');
const { frontierByCount, saturationCapital, sizeSweepForMarket } = require('./lib/allocate-sweep');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

const curves = [
  { marketId: 'A', levels: [{ units: 0, net5m: 0 }, { units: 1, net5m: 5 }, { units: 2, net5m: 8 }] },
  { marketId: 'B', levels: [{ units: 0, net5m: 0 }, { units: 1, net5m: 4 }, { units: 2, net5m: 10 }] },
];

console.log('frontierByCount — NET vs #markets held, under a fixed budget');
{
  // budget 4: count 1 → B2 = 10; count 2 → A2+B2 = 18.
  const f4 = frontierByCount(curves, 4, 2);
  ok('budget 4, count 1 → net 10', near(f4.netAt(1), 10));
  ok('budget 4, count 2 → net 18', near(f4.netAt(2), 18));
  const r2 = f4.reconstruct(2);
  ok('reconstruct count 2 → A2+B2, used 4 units, net 18', r2.count === 2 && r2.usedUnits === 4 && near(r2.net, 18));
  const r1 = f4.reconstruct(1);
  ok('reconstruct count 1 → B2 alone', r1.count === 1 && r1.allocation[0].marketId === 'B' && near(r1.net, 10));
}
console.log('frontierByCount — more markets does NOT help under a tight budget');
{
  // budget 2: one market at 2 units (B2=10) beats two markets at 1 unit each (A1+B1=9).
  const f2 = frontierByCount(curves, 2, 2);
  ok('budget 2, count 1 → net 10 (B2)', near(f2.netAt(1), 10));
  ok('budget 2, count 2 → still 10 (spreading is worse: A1+B1=9)', near(f2.netAt(2), 10));
}

console.log('saturationCapital — where the capacity cap binds (reuses ceiling capitalForShare)');
{
  // competitorQ 1000 sh, mid 0.50. capitalForShare = 2·price·cQ·X/(1−X) = 2·0.5·1000·X/(1−X) = 1000·X/(1−X).
  // X=0.5 → 1000; X=0.9 → 9000; X=0.99 → 99000.
  const s = saturationCapital(1000, 0.50, [0.5, 0.9, 0.99]);
  ok('share 0.5 → $1,000 total capital', near(s[0.5], 1000, 1e-6));
  ok('share 0.9 → $9,000 total capital', near(s[0.9], 9000, 1e-6));
  ok('share 0.99 → $99,000 (cap binds hard past 0.9)', near(s[0.99], 99000, 1e-6));
}

console.log('sizeSweepForMarket — net + marginal net per dollar, hand-computed');
{
  // synthetic evaluator: net = size (so capital = 2·size, dNet/dCap = 0.5 everywhere).
  const evalAtSize = (s) => ({ gross: s + 1, cost5m: 1, net5m: s, share: s / (s + 100) });
  const pts = sizeSweepForMarket(evalAtSize, [50, 100]);
  ok('3 points incl the zero point', pts.length === 3 && pts[0].capital === 0);
  ok('size 50 → capital 100, net 50', near(pts[1].capital, 100) && near(pts[1].net5m, 50));
  ok('marginal net/$ from 0→50 = (50−0)/(100−0) = 0.5', near(pts[1].marginalNetPerUsd, 0.5));
  ok('marginal net/$ from 50→100 = (100−50)/(200−100) = 0.5', near(pts[2].marginalNetPerUsd, 0.5));
}

console.log(`\nallocate-sweep.test: ${n} assertions passed`);
