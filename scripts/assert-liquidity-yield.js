'use strict';
// Node assertion for lib/liquidity-yield.ts — proves the balance-driven yield DILUTES and
// CAPS to remaining book space, killing the inflated aggregate-book number:
//   McConnell (pool 100, cap 626, filled .84, $1k)  → deployed ≈ 100, daily ≈ $16 (NOT $84)
//   Iran      (pool 2000, cap 58000, filled .95, $500k) → idle ≈ 497,100
// Run: node scripts/assert-liquidity-yield.js
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

// Transpile the .ts SSOT in-process so this script exercises the exact shipped math.
function loadTs(tsPath) {
  const src = fs.readFileSync(tsPath, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const m = new Module(tsPath, module);
  m.filename = tsPath;
  m.paths = Module._nodeModulePaths(path.dirname(tsPath));
  m._compile(js, tsPath);
  return m.exports;
}

const { computeLiquidityYield } = loadTs(path.join(__dirname, '..', 'lib', 'liquidity-yield.ts'));

let failures = 0;
function approx(got, want, tol, label) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got.toFixed(2)}, expected ≈ ${want} (±${tol})`);
}
function assert(cond, label) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

// McConnell — pool 100/day, cap 626, filled .84 ⇒ Q = cap×filled; balance $1,000.
{
  const cap = 626, filled = 0.84, Q = cap * filled;
  const r = computeLiquidityYield({ poolPerDay: 100, cap, qualifyingLiquidity: Q, balance: 1000 });
  console.log('McConnell (pool 100, cap 626, filled .84, balance 1000):');
  approx(r.deployed, 100, 5, 'deployed ≈ 100');
  approx(r.dailyUsd, 16, 2, 'dailyUsd ≈ 16 (NOT 84)');
  console.log(`    share=${r.share.toFixed(4)}  idle=${r.idle.toFixed(0)}  apyRaw=${r.apyRaw.toFixed(0)}%`);
}

// Iran — pool 2000/day, cap 58000, filled .95 ⇒ Q; balance $500,000 (book almost full → idle).
{
  const cap = 58000, filled = 0.95, Q = cap * filled;
  const r = computeLiquidityYield({ poolPerDay: 2000, cap, qualifyingLiquidity: Q, balance: 500000 });
  console.log('Iran (pool 2000, cap 58000, filled .95, balance 500000):');
  approx(r.idle, 497100, 50, 'idle ≈ 497,100');
  console.log(`    deployed=${r.deployed.toFixed(0)}  dailyUsd=$${r.dailyUsd.toFixed(2)}  apyRaw=${r.apyRaw.toFixed(1)}%`);
}

// Missing inputs ⇒ unknown (caller renders "—"); nothing fabricated.
{
  const r = computeLiquidityYield({ poolPerDay: null, cap: 1, qualifyingLiquidity: null, balance: 1000 });
  assert(r.unknown === true && r.dailyUsd === 0, 'missing pool/Q → unknown:true, dailyUsd 0 (renders "—")');
}

// No cap (Polymarket: any liquidity qualifies) ⇒ deploy full balance, idle 0, pure dilution.
// McConnell real fields: pool 100, Q = in-band depth 626, no cap; $1k ⇒ share 1000/1626.
{
  const r = computeLiquidityYield({ poolPerDay: 100, cap: null, qualifyingLiquidity: 626, balance: 1000 });
  const wantDaily = 100 * (1000 / (626 + 1000));   // ≈ 61.5
  console.log('McConnell HONEST (no cap: pool 100, Q depth 626, balance 1000):');
  approx(r.deployed, 1000, 0.01, 'deploys full balance (no cap)');
  approx(r.idle, 0, 0.01, 'idle 0 (no fabricated cap)');
  approx(r.dailyUsd, wantDaily, 0.1, 'dailyUsd ≈ 61.5 (diluted, NOT 84)');
}

// TWO-SIDED DILUTION (Polymarket): supplying the opposite side's in-band depth GROWS the
// competitor denominator, so the share DROPS on a skewed book — and the shown competitorDepth
// equals the denominator the share uses (near + opposite), so "depth" is display-consistent.
{
  // Yamal real fields: pool 155, near (YES) depth 1328, far (NO) depth 3790, balance $1,000.
  const oneSided = computeLiquidityYield({ poolPerDay: 155, cap: null, qualifyingLiquidity: 1328, balance: 1000 });
  const twoSided = computeLiquidityYield({ poolPerDay: 155, cap: null, qualifyingLiquidity: 1328, qualifyingLiquidityOpposite: 3790, balance: 1000 });
  console.log('Yamal TWO-SIDED (pool 155, near 1328, far 3790, balance 1000):');
  approx(oneSided.share, 1000 / (1328 + 1000), 1e-4, 'one-sided share ≈ 0.4295 (old, overstated)');
  approx(twoSided.share, 1000 / (1328 + 3790 + 1000), 1e-4, 'two-sided share ≈ 0.1634 (honest, lower)');
  assert(twoSided.share < oneSided.share, 'two-sided share is STRICTLY lower than one-sided on a skewed book');
  approx(twoSided.competitorDepth, 5118, 0.01, 'competitorDepth = near + far = 5118 (what "depth" displays)');
  approx(twoSided.dailyUsd, 155 * (1000 / 6118), 0.01, 'dailyUsd tracks the two-sided share ($25.3, not $66.6)');
}

// Opposite side ABSENT ⇒ reduces EXACTLY to the one-sided model (Kalshi flat pro-rata unchanged).
{
  const noOpp   = computeLiquidityYield({ poolPerDay: 100, cap: null, qualifyingLiquidity: 594, balance: 1000 });
  const nullOpp = computeLiquidityYield({ poolPerDay: 100, cap: null, qualifyingLiquidity: 594, qualifyingLiquidityOpposite: null, balance: 1000 });
  assert(noOpp.share === nullOpp.share && noOpp.competitorDepth === 594, 'no/null opposite side → one-sided model byte-for-byte (competitorDepth = near)');
}

// KALSHI flat pro-rata (observed). Kalshi's LIP reward = yourScore / totalScore × pool, and
// totalScore pools BOTH sides of the market — so the honest single-deployment share is
// deployed/(bothSidesDepth + deployed). The normalizer pre-sums both sides into bookDepthAtBand,
// and Kalshi passes NO opposite side (Qopp absent) → competitorDepth = that both-sides depth. This
// is a distinct venue mechanic from Polymarket's Qmin, but reduces to the same one-sided lib call.
{
  // Austin 74.99° real fields: pool $2482.208/day, both-sides depth $3766.02, balance $1,000.
  const r = computeLiquidityYield({ poolPerDay: 2482.208, cap: null, qualifyingLiquidity: 3766.02, balance: 1000 });
  console.log('Kalshi FLAT PRO-RATA (pool 2482.208, both-sides depth 3766.02, balance 1000):');
  approx(r.share, 1000 / (3766.02 + 1000), 1e-4, 'share ≈ 0.2098 (both-sides pro-rata)');
  approx(r.dailyUsd, 2482.208 * (1000 / 4766.02), 0.01, 'dailyUsd ≈ $520.8/day (gross, pre-uptime/distance)');
  approx(r.competitorDepth, 3766.02, 0.01, 'competitorDepth = both-sides depth (what "depth" displays)');
  assert(r.unknown === false, 'a real two-sided Kalshi book is priceable (unknown:false)');
}

// KALSHI one-sided / non-executable book → the caller nulls Q (executable-depth guard) → the lib
// must return unknown ⇒ the row renders "—", never the spurious dominance number (e.g. $1k
// "owning" 88% of a $139 one-sided book → thousands/day). The guard lives in the caller; the lib's
// contract is only that a null qualifying depth ⇒ unknown, which this pins.
{
  const r = computeLiquidityYield({ poolPerDay: 2482.208, cap: null, qualifyingLiquidity: null, balance: 1000 });
  assert(r.unknown === true && r.dailyUsd === 0, 'Kalshi one-sided (Q nulled by guard) → unknown:true → renders "—"');
}

// APY is on DEPLOYED capital, not total balance: idle capital must not dilute the APY.
{
  const cap = 626, Q = 526;                 // space = 100
  const r = computeLiquidityYield({ poolPerDay: 100, cap, qualifyingLiquidity: Q, balance: 100000 });
  const apyOnDeployed = r.deployed > 0 ? (r.dailyUsd * 365 / r.deployed) * 100 : 0;
  assert(Math.abs(r.apyRaw - apyOnDeployed) < 1e-6 && r.idle > 99000, 'APY on deployed capital, not total balance');
}

// INVARIANT: a KNOWN depth must yield a finite number at EVERY balance — unknown must
// never flip true when pool+Q are real (the "—" is for missing data only, never a gate).
{
  const pool = 288, Q = 344539;   // Lula: real pool + real in-band depth
  let ok = true;
  for (const bal of [1, 1000, 10000, 100000, 500000, 5_000_000]) {
    const r = computeLiquidityYield({ poolPerDay: pool, cap: null, qualifyingLiquidity: Q, balance: bal });
    if (r.unknown || !Number.isFinite(r.dailyUsd) || !Number.isFinite(r.apyRaw)) { ok = false; break; }
  }
  assert(ok, 'known depth → finite dailyUsd & unknown:false at every balance (Lula 288/344539)');
}

console.log(failures === 0 ? '\nALL ASSERTIONS PASS' : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
