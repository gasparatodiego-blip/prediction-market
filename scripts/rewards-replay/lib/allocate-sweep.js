'use strict';
// scripts/rewards-replay/lib/allocate-sweep.js — sweep the ALLOCATION of a FIXED budget to find where NET
// is maximised, and answer the concentration question: how many markets does the best allocation need, and
// what happens to net if that count is halved or doubled.
//
// frontierByCount is a 2D knapsack (budget × #markets-funded): dp[c][b] = best Σnet using ≤c markets and
// ≤b budget units. The single-constraint knapsack in allocate.js finds the global optimum; this adds the
// count axis so we can print NET as a function of "markets held simultaneously" — the frontier the operator
// actually chooses on. saturationCapital reuses the ceiling's capitalForShare to say where the capacity cap
// binds (the capital beyond which more money buys almost no additional pool share). Pure/deterministic.

const { capitalForShare } = require('../../rewards-ceiling/lib/curve');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * 2D knapsack over (count, budget). Returns the NET frontier per allowed market count and a reconstructor.
 * @param curves       [{ marketId, levels:[{units, net5m, ...}] }] (units-0/net-0 level present)
 * @param budgetUnits  budget in integer units
 * @param maxCount     largest #markets to consider funding
 * @returns { frontier:[{count, net}], reconstruct(count)->{count,usedUnits,net,allocation}, netAt(count) }
 */
function frontierByCount(curves, budgetUnits, maxCount) {
  const B = Math.max(0, Math.floor(budgetUnits));
  const C = Math.max(1, Math.floor(maxCount));
  const M = curves.length;
  let dp = Array.from({ length: C + 1 }, () => new Float64Array(B + 1));
  const choice = [];
  for (let m = 0; m < M; m++) {
    const levels = curves[m].levels;
    const ndp = Array.from({ length: C + 1 }, () => new Float64Array(B + 1));
    const ch = Array.from({ length: C + 1 }, () => new Int32Array(B + 1));
    for (let c = 0; c <= C; c++) {
      for (let b = 0; b <= B; b++) {
        let best = dp[c][b], bestIdx = 0; // level 0 = don't fund m
        if (c >= 1) {
          for (let li = 0; li < levels.length; li++) {
            const L = levels[li]; const u = L.units | 0;
            if (u <= 0 || u > b) continue;
            const val = dp[c - 1][b - u] + (fin(L.net5m) ? L.net5m : 0);
            if (val > best) { best = val; bestIdx = li; }
          }
        }
        ndp[c][b] = best; ch[c][b] = bestIdx;
      }
    }
    dp = ndp; choice.push(ch);
  }
  const frontier = [];
  for (let c = 1; c <= C; c++) frontier.push({ count: c, net: dp[c][B] });
  function reconstruct(cTarget) {
    let c = Math.min(C, Math.max(0, Math.floor(cTarget))), b = B;
    const alloc = [];
    for (let m = M - 1; m >= 0; m--) {
      const li = choice[m][c][b]; const L = curves[m].levels[li];
      if (L && (L.units | 0) > 0) { alloc.push({ marketId: curves[m].marketId, ...L }); c -= 1; b -= (L.units | 0); }
    }
    alloc.reverse();
    return {
      count: alloc.length,
      usedUnits: alloc.reduce((s, a) => s + (a.units | 0), 0),
      net: alloc.reduce((s, a) => s + (fin(a.net5m) ? a.net5m : 0), 0),
      allocation: alloc,
    };
  }
  return { frontier, reconstruct, netAt: (c) => (c >= 1 && c <= C ? dp[c][B] : null) };
}

/**
 * Where the capacity cap binds for one market: the TOTAL capital at which our pool share reaches a target
 * (0.5 / 0.9 / 0.99). Beyond the 0.9 point, each extra dollar buys < a tenth of the remaining pot share, so
 * that is where "more capital buys almost no additional share". Reuses the ceiling's capitalForShare.
 */
function saturationCapital(competitorQ, mid, targets = [0.5, 0.9, 0.99]) {
  const out = {};
  for (const X of targets) out[X] = capitalForShare(competitorQ, mid, X); // total capital, both sides
  return out;
}

/**
 * Size sweep for a SINGLE market: net at a grid of per-side sizes, plus the marginal net per extra dollar of
 * capital between consecutive grid points. `evalAtSize(sizeUsd)` returns { gross, cost5m, net5m, share }.
 */
function sizeSweepForMarket(evalAtSize, sizeGrid) {
  const pts = [{ sizeUsd: 0, capital: 0, gross: 0, cost5m: 0, net5m: 0, share: 0, marginalNetPerUsd: null }];
  let prev = pts[0];
  for (const s of sizeGrid) {
    const r = evalAtSize(s);
    const capital = 2 * s;
    const dCap = capital - prev.capital;
    pts.push({ sizeUsd: s, capital, gross: r.gross, cost5m: r.cost5m, net5m: r.net5m, share: r.share, marginalNetPerUsd: dCap > 0 ? (r.net5m - prev.net5m) / dCap : null });
    prev = pts[pts.length - 1];
  }
  return pts;
}

module.exports = { frontierByCount, saturationCapital, sizeSweepForMarket };
