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
