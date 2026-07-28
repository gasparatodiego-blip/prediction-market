#!/usr/bin/env node
'use strict';
// Unit tests for the by-market markout distribution: worst decile, per-market cost↔gross join, the
// cost/gross rank correlation, and fill concentration — all with hand-computed expected values.
const assert = require('assert');
const { worstDecile, byMarketMarkout, costGrossRankCorr, fillConcentration } = require('./lib/markout-by-market');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

console.log('worstDecile — mean of the most-adverse 10%');
{
  // 10 values → ceil(10%)=1 → bottom 1 = −5 → mean −5, threshold −5.
  const wd = worstDecile([-5, -4, -3, -2, -1, 0, 0, 0, 0, 0]);
  ok('n=10 → decile size 1, mean −5', wd.n === 1 && near(wd.mean, -5) && near(wd.threshold, -5));
  // 20 values → ceil(2)=2 → bottom 2 = [−9,−8] → mean −8.5.
  const wd2 = worstDecile([-9, -8, ...Array(18).fill(0)]);
  ok('n=20 → decile size 2, mean −8.5', wd2.n === 2 && near(wd2.mean, -8.5));
  ok('empty → null', worstDecile([]) === null);
  ok('nulls filtered before ranking', worstDecile([null, -2, null, 0]).n === 1 && near(worstDecile([null, -2, null, 0]).mean, -2));
}

console.log('byMarketMarkout — per-market cost joined to gross');
{
  const mo = (marketId, side, usd, cents) => ({ marketId, side, horizons: { '5m': { usd, cents } } });
  const markouts = [
    mo('A', 'buy', -3, -2), mo('A', 'buy', -1, -1),     // A: 2 fills, cost +$4
    mo('B', 'sell', 0, 0),                               // B: 1 fill, cost $0
  ];
  const netRows = [
    { marketId: 'A', grossWindow: 10, netWindow: { '5m': 6 } },
    { marketId: 'B', grossWindow: 50, netWindow: { '5m': 50 } },
  ];
  const rows = byMarketMarkout(markouts, netRows, '5m');
  const A = rows.find((r) => r.marketId === 'A'), B = rows.find((r) => r.marketId === 'B');
  ok('A: 2 fills, cost +$4, gross $10, net $6', A.fills === 2 && near(A.costUsd, 4) && near(A.gross, 10) && near(A.net5m, 6));
  ok('B: 1 fill, cost $0, gross $50', B.fills === 1 && near(B.costUsd, 0) && near(B.gross, 50));
  ok('sorted worst-markout (most negative meanCents) first → A before B', rows[0].marketId === 'A');
  ok('A meanCents = (−2 + −1)/2 = −1.5', near(A.meanCents, -1.5));
}

console.log('costGrossRankCorr — worst markout vs most gross');
{
  // cost and gross perfectly aligned → Spearman +1 (worst-markout markets ARE the biggest-gross markets).
  const rowsAligned = [
    { costUsd: 1, gross: 10 }, { costUsd: 2, gross: 20 }, { costUsd: 3, gross: 30 }, { costUsd: 4, gross: 40 },
  ];
  ok('aligned cost/gross → +1', near(costGrossRankCorr(rowsAligned), 1, 1e-9));
  // perfectly inverse → −1.
  const rowsInverse = [
    { costUsd: 1, gross: 40 }, { costUsd: 2, gross: 30 }, { costUsd: 3, gross: 20 }, { costUsd: 4, gross: 10 },
  ];
  ok('inverse cost/gross → −1', near(costGrossRankCorr(rowsInverse), -1, 1e-9));
  ok('<3 markets → null (not enough to rank)', costGrossRankCorr([{ costUsd: 1, gross: 1 }]) === null);
}

console.log('fillConcentration — HHI, top share, markets for 80%');
{
  // counts 90,5,5 → total 100. top1 0.90, hhi 0.81+0.0025+0.0025=0.815. 80% reached by first market → k=1.
  const rows = [{ fills: 90 }, { fills: 5 }, { fills: 5 }, { fills: 0 }];
  const c = fillConcentration(rows);
  ok('total 100, 3 markets with fills', c.totalFills === 100 && c.marketsWithFills === 3);
  ok('top1 share 0.90', near(c.top1Share, 0.90));
  ok('hhi = 0.815', near(c.hhi, 0.815, 1e-9));
  ok('one market carries 80% of fills', c.marketsFor80pct === 1);
}

console.log(`\nmarkout-by-market.test: ${n} assertions passed`);
