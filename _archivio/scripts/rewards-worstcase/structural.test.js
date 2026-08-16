#!/usr/bin/env node
'use strict';
// Unit tests for the structural bounds: per-market max loss / days-erased / order-vs-depth, and the
// portfolio ceiling + days-to-recover. Hand-computed; the "—" contract holds (gross 0 or net 0 → null).
const assert = require('assert');
const { structuralBound, portfolioBounds } = require('./lib/structural');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('structuralBound — one full adverse fill = $size lost; days-erased = size/gross');
{
  const b = structuralBound({ sizeUsd: 100, grossPerDay: 4, mid: 0.5, depthShares: 200 });
  ok('maxLoss = $100 (the full resting order)', near(b.maxLoss, 100));
  ok('daysErased = 100/4 = 25 days of that market’s reward', near(b.daysErased, 25));
  ok('orderShares = 100/0.5 = 200', near(b.orderShares, 200));
  ok('orderVsDepth = 200/200 = 1×', near(b.orderVsDepth, 1));
  ok('gross 0 → daysErased "—" (null, never ∞)', structuralBound({ sizeUsd: 100, grossPerDay: 0, mid: 0.5, depthShares: 200 }).daysErased === null);
  ok('depth 0 → orderVsDepth "—" (null)', structuralBound({ sizeUsd: 100, grossPerDay: 4, mid: 0.5, depthShares: 0 }).orderVsDepth === null);
}
console.log('portfolioBounds — ceiling + days to recover a single worst market');
{
  const p = portfolioBounds([{ maxLoss: 1000 }, { maxLoss: 250 }, { maxLoss: 50 }], 100);
  ok('portfolio max loss = 1000+250+50 = 1300 (every market adverse)', near(p.portfolioMaxLoss, 1300));
  ok('worst single market loss = 1000', near(p.worstSingleMarketLoss, 1000));
  ok('days to recover the single worst = 1000/100 = 10', near(p.daysToRecoverSingle, 10));
  ok('days to recover the portfolio ceiling = 1300/100 = 13', near(p.daysToRecoverPortfolio, 13));
  ok('net 0 → recover "—" (null, never a divide-by-zero)', portfolioBounds([{ maxLoss: 1000 }], 0).daysToRecoverSingle === null);
}
console.log(`\nstructural.test: ${n} assertions passed`);
