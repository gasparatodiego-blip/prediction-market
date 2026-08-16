#!/usr/bin/env node
'use strict';
// Unit tests for the total-capital allocator. Two independent proofs:
//   (1) perMarketNetAtSize reuses the shipped fill→markout→net math on hand-built rows+tape (every
//       intermediate number is hand-computed below), and
//   (2) knapsack splits ONE budget across markets under the hard constraint that capital spent in market A
//       is unavailable to market B — with hand-computed optima including the constraint-binding case.
// Deterministic (synthetic rows).
const assert = require('assert');
const { perMarketNetAtSize, knapsack } = require('./lib/allocate');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

// ── (1) perMarketNetAtSize — every number hand-computed ──────────────────────────
// Journal rows (45s cadence): adjMid 0.50 through t=270s, then 0.48 at t=315s. tick 0.01, band [0.45,0.55],
// in-band depth 100 sh each side (limiting depth = median(min(100,100)) = 100), mid = median(adjMid) = 0.50.
// One real print: BUY-side taker at price 0.49, size 50 sh, at t=10s.
console.log('perMarketNetAtSize — hand-computed fill, gross, cost, net');
{
  const mkRow = (sec, adjMid) => ({
    ts: new Date(sec * 1000).toISOString(), tsMs: sec * 1000, marketId: 'M', tokenIdYes: 'TK',
    adjMid, plainMid: adjMid, bestBid: adjMid - 0.01, bestAsk: adjMid + 0.01,
    bidDepthInBand: 100, askDepthInBand: 100, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws',
  });
  const rows = [0, 45, 90, 135, 180, 225, 270].map((s) => mkRow(s, 0.50)).concat([mkRow(315, 0.48)]);
  const trades = [{ tsVenueMs: 10000, tsMs: 10000, marketId: 'M', tokenId: 'TK', price: 0.49, size: 50, side: 'buy', src: 'ws', tsVenueIso: new Date(10000).toISOString() }];
  const potByCond = new Map([['M', 10]]); // $10/day pot
  // size $25/side → orderShares = 25/0.50 = 50; the print of 50 sh fills it exactly. capital = $50.
  // share = ((50/2)/0.50)/((50/2)/0.50 + 100) = 50/150 = 1/3. grossPerDay = 10·(1/3) = 3.3333 ($/day, no window).
  // OBSERVED span = first→last row = 315s = 0.0875h (0.00364583 d). grossWindow = 3.3333·0.00364583 = $0.01215.
  // markout +5m: fill adjMid 0.50, nearest sample to +310s is t=315s (Δ5s) adjMid 0.48 → −0.02·50 = −$1.00 adverse.
  // costPerDay = 1.00 / 0.00364583 = $274.29/day; netPerDay = 3.3333 − 274.29 = −$270.95 (short span ⇒ cost blows up).
  const spanDays = 0.0875 / 24;
  const r = perMarketNetAtSize('M', rows, trades, potByCond, { offsetCents: 1, sizeUsd: 25, maxInventoryUsd: 5000 });
  ok('exactly one fill', r.fills === 1);
  ok('capital = 2×$25 = $50', near(r.capital, 50));
  ok('share = 1/3', near(r.share, 1 / 3, 1e-6));
  ok('spanHours = 315s = 0.0875h', near(r.spanHours, 0.0875, 1e-6));
  ok('grossPerDay = pot·share = $3.3333', near(r.grossPerDay, 10 / 3, 1e-4));
  ok('grossWindow (over span) = $0.01215', near(r.grossWindow, (10 / 3) * spanDays, 1e-5));
  ok('cost(+5m) adverse over span = $1.00', near(r.cost5m, 1.00, 1e-9));
  ok('costPerDay(+5m) = 1.00 / spanDays = $274.29/day', near(r.costPerDay5m, 1.00 / spanDays, 1e-2));
  ok('netWindow(+5m) = grossWindow − 1.00 = −$0.98785', near(r.netWindow5m, (10 / 3) * spanDays - 1.00, 1e-4));
  ok('netPerDay(+5m) = 3.3333 − 274.29 = −$270.95', near(r.netPerDay5m, 10 / 3 - 1.00 / spanDays, 1e-2));
  ok('not excluded (pot + depth present)', r.excluded === false);
  // no-pot market → excluded, unfundable
  const rNoPot = perMarketNetAtSize('M', rows, trades, new Map(), { offsetCents: 1, sizeUsd: 25, maxInventoryUsd: 5000 });
  ok('no pot → excluded', rNoPot.excluded === true && rNoPot.netPerDay5m == null);
}

// ── (2) knapsack — shared budget across markets, hand-computed optima ─────────────
console.log('knapsack — one budget split across markets, capital in A unavailable to B');
{
  const curves = [
    { marketId: 'A', levels: [{ units: 0, net5m: 0, capital: 0, gross: 0, cost5m: 0 }, { units: 1, net5m: 5, capital: 100, gross: 6, cost5m: 1 }, { units: 2, net5m: 8, capital: 200, gross: 10, cost5m: 2 }] },
    { marketId: 'B', levels: [{ units: 0, net5m: 0, capital: 0, gross: 0, cost5m: 0 }, { units: 1, net5m: 4, capital: 100, gross: 5, cost5m: 1 }, { units: 2, net5m: 10, capital: 200, gross: 12, cost5m: 2 }] },
  ];
  // budget 2 units: A2=8, B2=10, A1+B1=9 → max 10 = B2 alone (funding BOTH at 2 units would need 4 units — the constraint bites).
  const b2 = knapsack(curves, 2);
  ok('budget 2 → net 10 (B2 alone)', near(b2.totalNet5m, 10) && b2.marketsHeld === 1 && b2.allocation[0].marketId === 'B' && b2.allocation[0].units === 2);
  ok('budget 2 → used exactly 2 units (cannot fund both fully)', b2.usedUnits === 2);
  // budget 1 unit: max(A1=5, B1=4) = 5, one market only.
  const b1 = knapsack(curves, 1);
  ok('budget 1 → net 5 (A1), one market', near(b1.totalNet5m, 5) && b1.marketsHeld === 1 && b1.allocation[0].marketId === 'A');
  // budget 3 units: A1+B2 = 5+10 = 15 beats A2+B1 = 12.
  const b3 = knapsack(curves, 3);
  ok('budget 3 → net 15 (A1+B2), two markets', near(b3.totalNet5m, 15) && b3.marketsHeld === 2 && b3.usedUnits === 3);
  // budget 4 units: A2+B2 = 18, both fully funded.
  const b4 = knapsack(curves, 4);
  ok('budget 4 → net 18 (A2+B2), both full', near(b4.totalNet5m, 18) && b4.marketsHeld === 2 && b4.usedUnits === 4);
  // budget 10 units but only 4 useful: never spends more than helps (idle capital allowed).
  const b10 = knapsack(curves, 10);
  ok('budget 10 → still net 18, only 4 units used (idle capital allowed)', near(b10.totalNet5m, 18) && b10.usedUnits === 4);
}
console.log('knapsack — a market that is net-negative at every size is never funded');
{
  const curves = [{ marketId: 'C', levels: [{ units: 0, net5m: 0 }, { units: 1, net5m: -3 }, { units: 2, net5m: -7 }] }];
  const r = knapsack(curves, 5);
  ok('net-negative market → not funded, net 0', near(r.totalNet5m, 0) && r.marketsHeld === 0 && r.usedUnits === 0);
}

console.log(`\nallocate.test: ${n} assertions passed`);
