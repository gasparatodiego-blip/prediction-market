#!/usr/bin/env node
'use strict';
// Selfcheck for the shared allocator's UI wrapper planAllocation(). The knapsack itself is proven by the
// backtest tests + the machine-precision equality proof; here we assert the NEW normalisation behaviours:
//   • a market with 0 observed fills funds on gross but its NET renders null ("—"), never gross-as-net;
//   • portfolio net stays null when any chosen market's net is unknown;
//   • per-side size in shares, snapped bid/ask at the offset+tick, and in-band depth are surfaced correctly.
// Deterministic synthetic journal (no tape → 0 fills).
const assert = require('assert');
const { planAllocation } = require('./allocator');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

// One fundable market Z: two samples 24h apart (span 24h), mid 0.50, in-band depth 1000 sh, tick 0.01,
// pot $100/day, NO trades → 0 fills. grossPerDay = 100·share; net = gross (measured 0 cost) but DISPLAY "—".
const row = (tsMs) => ({ ts: new Date(tsMs).toISOString(), tsMs, marketId: 'Z', tokenIdYes: 'TKZ', adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51, bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws' });
const byMarket = new Map([['Z', [row(0), row(86400000)]]]);
const marketTokens = new Map([['Z', 'TKZ']]);
const tapeByToken = new Map(); // no trades
const potByCond = new Map([['Z', 100]]);

console.log('planAllocation — 0-fill market: funds on gross, net renders "—"');
{
  const plan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold' });
  ok('one market used', plan.marketsUsed === 1 && plan.rows.length === 1);
  const r = plan.rows[0];
  ok('0 fills → net is null (renders "—"), never a number', r.fills === 0 && r.netPerDay === null);
  ok('gross/day is a real positive number', typeof r.grossPerDay === 'number' && r.grossPerDay > 0);
  ok('portfolio net stays null when a chosen market net is unknown', plan.totalNetPerDay === null);
  ok('portfolio gross is summed (real)', near(plan.totalGrossPerDay, r.grossPerDay));
  // size in shares = sizeUsd / clampPrice(mid 0.50); capital = 2·sizeUsd.
  ok('per-side size in shares = sizeUsd / 0.50', near(r.sizePerSideShares, r.sizePerSideUsd / 0.50));
  ok('capital = 2 × per-side size $', near(r.capital, 2 * r.sizePerSideUsd));
  // snapped prices at offset 1¢, tick 0.01: bid 0.49, ask 0.51.
  ok('snapped bid 0.49 / ask 0.51 at offset 1¢, tick 0.01', near(r.snappedBid, 0.49) && near(r.snappedAsk, 0.51) && near(r.tick, 0.01));
  ok('in-band depth surfaced = 1000 shares', near(r.depthShares, 1000));
  ok('offset echoed on the row', r.offsetCents === 1);
  ok('frontier present (count → net)', Array.isArray(plan.frontier) && plan.frontier.length >= 1 && plan.frontier[0].count === 1);
}

console.log('planAllocation — unallocated remainder is explicit, never absorbed');
{
  // budget $250 at unit $100 → only $200 is allocatable in whole units; the $50 remainder is REPORTED,
  // never silently rolled into a market. unallocated is always exactly budget − totalCapital.
  const plan = planAllocation({ byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 250, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold' });
  ok('unallocated = budget − totalCapital (exact), and here the $50 granularity remainder is > 0', near(plan.unallocated, plan.budgetUsd - plan.totalCapital) && near(plan.unallocated, 50));
}

console.log(`\nallocator.test: ${n} assertions passed`);
