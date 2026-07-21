'use strict';
// Node assertion for lib/reward-score.ts — proves the DETAIL ticket can NEVER disagree with the
// LIST for the same market at the same effective capital, and that the venue mechanics behave:
//   • Polymarket balanced two-sided at the mid == list $/day (exact).
//   • Polymarket ONE-sided (mid in band) applies the ÷3 penalty → share drops.
//   • Polymarket ONE-sided (mid OUT of band) earns nothing (two-sided required).
//   • Kalshi flat pro-rata == list $/day (both sides pooled, no proximity, no penalty).
//   • Out-of-band levels earn nothing.
// Run: node scripts/assert-reward-score.js
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

// Register a .ts require hook so the SSOT modules load with their real nested imports
// (reward-score.ts → './liquidity-yield') — this exercises the exact shipped math.
require.extensions['.ts'] = function (m, filename) {
  const src = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  m._compile(js, filename);
};

const { computeRewardScore }    = require(path.join(__dirname, '..', 'lib', 'reward-score.ts'));
const { computeLiquidityYield } = require(path.join(__dirname, '..', 'lib', 'liquidity-yield.ts'));

let failures = 0;
function approx(got, want, tol, label) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${Number(got).toFixed(4)}, expected ≈ ${Number(want).toFixed(4)} (±${tol})`);
}
function assert(cond, label) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

// ── DETAIL == LIST (Polymarket) ──────────────────────────────────────────────
// Real Polymarket market: pool $155/day, near (YES) depth 1328, far (NO) depth 3790.
// The LIST prices a $1,000 balance at share = 1000/(1328+3790+1000). The DETAIL ticket, when the
// user places $1,000 balanced two-sided AT THE MID (proximity 1, in-band), must equal it EXACTLY.
{
  const pool = 155, near = 1328, far = 3790, mid = 25, v = 4.5, B = 1000;
  const competitorDepth = near + far;

  const list = computeLiquidityYield({
    poolPerDay: pool, cap: null, qualifyingLiquidity: near, qualifyingLiquidityOpposite: far, balance: B,
  });

  const ticket = computeRewardScore({
    venue: 'polymarket', midCents: mid, maxSpreadC: v, pool, competitorDepthUsd: competitorDepth,
    yes: [{ priceCents: mid, sizeUsd: B / 2 }],   // $500 at the mid on YES
    no:  [{ priceCents: mid, sizeUsd: B / 2 }],   // $500 at the mid on NO
  });

  console.log('Polymarket DETAIL(balanced $1k @ mid) vs LIST ($1k):');
  approx(ticket.dailyUsd, list.dailyUsd, 1e-6, 'ticket $/day == list $/day (EXACT agreement)');
  approx(ticket.share, list.share, 1e-9, 'ticket share == list share');
  assert(ticket.penaltyApplied === false && ticket.twoSidedRequiredUnmet === false, 'balanced two-sided ⇒ no penalty');
  approx(ticket.capital, B, 1e-9, 'capital == $1,000 placed');
  approx(ticket.yesScore, B / 2, 1e-9, 'yesScore == $500 (proximity 1 at mid)');
}

// ── ONE-SIDED ÷3 penalty (mid in band) drops the share vs balanced ───────────
{
  const pool = 155, competitorDepth = 1328 + 3790, mid = 25, v = 4.5, B = 1000;
  const balanced = computeRewardScore({ venue: 'polymarket', midCents: mid, maxSpreadC: v, pool, competitorDepthUsd: competitorDepth,
    yes: [{ priceCents: mid, sizeUsd: B / 2 }], no: [{ priceCents: mid, sizeUsd: B / 2 }] });
  const oneSided = computeRewardScore({ venue: 'polymarket', midCents: mid, maxSpreadC: v, pool, competitorDepthUsd: competitorDepth,
    yes: [{ priceCents: mid, sizeUsd: B }], no: [] });   // all $1k on YES only
  console.log('Polymarket ONE-SIDED (mid 25¢ ∈ band) ÷3 penalty:');
  assert(oneSided.penaltyApplied === true, 'penaltyApplied true');
  approx(oneSided.effectiveScore, B / 3, 1e-9, 'effective score = capital ÷ 3');
  assert(oneSided.share < balanced.share, 'one-sided share STRICTLY below balanced share');
  approx(oneSided.dailyUsd, pool * (B / 3) / (competitorDepth + B / 3), 1e-6, 'one-sided $/day tracks ÷3 score');
}

// ── ONE-SIDED earns NOTHING when mid is outside [0.10,0.90] (two-sided required) ──
{
  const r = computeRewardScore({ venue: 'polymarket', midCents: 6, maxSpreadC: 4.5, pool: 155, competitorDepthUsd: 5000,
    yes: [{ priceCents: 6, sizeUsd: 1000 }], no: [] });   // one-sided, mid 6¢ < 10¢
  console.log('Polymarket ONE-SIDED (mid 6¢ ∉ band) two-sided required:');
  assert(r.twoSidedRequiredUnmet === true && r.dailyUsd === 0 && r.share === 0, 'earns nothing (dailyUsd 0)');
}

// ── OUT-OF-BAND levels earn nothing (proximity 0) ────────────────────────────
{
  const r = computeRewardScore({ venue: 'polymarket', midCents: 25, maxSpreadC: 4.5, pool: 155, competitorDepthUsd: 5000,
    yes: [{ priceCents: 40, sizeUsd: 500 }],   // 15¢ from mid > 4.5¢ band
    no:  [{ priceCents: 10, sizeUsd: 500 }] }); // 15¢ from mid > band
  console.log('Out-of-band placements:');
  assert(r.yesScore === 0 && r.noScore === 0 && r.dailyUsd === 0, 'out-of-band earns nothing, capital still counted');
  approx(r.capital, 1000, 1e-9, 'capital still reflects the $1,000 placed (idle, off-band)');
}

// ── DETAIL == LIST (Kalshi flat pro-rata) ────────────────────────────────────
// Kalshi list dilutes a $1,000 balance against both-sides depth (bothUsd). The ticket, placing
// $1,000 in-band (any split, no proximity, no penalty), must equal it.
{
  const pool = 2482.208, bothUsd = 3766.02, B = 1000;
  const list = computeLiquidityYield({ poolPerDay: pool, cap: null, qualifyingLiquidity: bothUsd, balance: B });
  const ticket = computeRewardScore({ venue: 'kalshi', midCents: 27, maxSpreadC: 50, pool, competitorDepthUsd: bothUsd,
    yes: [{ priceCents: 27, sizeUsd: 600 }], no: [{ priceCents: 73, sizeUsd: 400 }] });
  console.log('Kalshi DETAIL($1k in-band) vs LIST ($1k):');
  approx(ticket.dailyUsd, list.dailyUsd, 1e-6, 'ticket $/day == list $/day (flat pro-rata, pooled)');
  assert(ticket.penaltyApplied === false, 'Kalshi never applies the ÷3 penalty');
}

// ── Missing pool ⇒ dailyUsd null (never fabricated) ──────────────────────────
{
  const r = computeRewardScore({ venue: 'polymarket', midCents: 25, maxSpreadC: 4.5, pool: null, competitorDepthUsd: 5000,
    yes: [{ priceCents: 25, sizeUsd: 500 }], no: [{ priceCents: 25, sizeUsd: 500 }] });
  assert(r.dailyUsd === null, 'missing pool ⇒ dailyUsd null (renders "—")');
}

console.log(failures === 0 ? '\nALL ASSERTIONS PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
