#!/usr/bin/env node
'use strict';
// Unit tests for the LEXICOGRAPHIC pick: (1) capital preservation is a HARD gate that rejects outright,
// (2) among feasible, fewest expected fills wins, (3) ties broken by most net. Hand-computed.
const assert = require('assert');
const { lexiPick } = require('./lib/lexi');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

const P = (id, bound, fills, net) => ({ id, structuralBound: bound, expectedFills: fills, netPerDay: net });

console.log('lexiPick — constraint 1 gates, then min fills, then max net');
{
  const pts = [
    P('A', 2500, 11, 100.98), // reward king but most fills
    P('B', 2500, 5, 110.08),  // fewer fills AND more net
    P('C', 1250, 8, 63.21),
  ];
  ok('50% tol ($2500 limit): all feasible → fewest fills wins (B, 5 fills)', lexiPick(pts, { tolerance: 0.50, budget: 5000 }).id === 'B');
  ok('a higher-reward but more-filled option (A) does NOT win — fills rank above reward', lexiPick(pts, { tolerance: 0.50, budget: 5000 }).id !== 'A');
}
console.log('constraint 1 REJECTS outright regardless of reward');
{
  const pts = [P('BIG', 2500, 2, 200), P('SMALL', 500, 9, 30)];
  ok('10% tol ($500 limit): BIG ($2500 bound) rejected despite best reward → SMALL wins', lexiPick(pts, { tolerance: 0.10, budget: 5000 }).id === 'SMALL');
  ok('no feasible candidate → null (never a forced pick)', lexiPick([P('X', 5000, 1, 500)], { tolerance: 0.10, budget: 5000 }) === null);
}
console.log('ties on fills broken by max net');
{
  const pts = [P('LO', 1000, 4, 40), P('HI', 1000, 4, 55)];
  ok('equal fills (4) → higher net (HI, $55) wins', lexiPick(pts, { tolerance: 0.50, budget: 5000 }).id === 'HI');
}
console.log(`\nlexi.test: ${n} assertions passed`);
