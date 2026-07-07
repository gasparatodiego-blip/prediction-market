'use strict';
/**
 * Unit tests for lib/source-verify comparators. Run: node lib/source-verify.test.js
 * Tiny inline harness (no framework — matches lib/display-sanity.test.js style).
 *
 * Focus: the comparison + settlement-boundary logic, which is where a false
 * positive (drop a good row) or false negative (pass a phantom) would live. The
 * live venue adapters are exercised separately by the agent29 smoke test.
 */
const SV = require('./source-verify');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('  ✗', name); } }

// ── compareFunding ───────────────────────────────────────────────────────────
// stored & live agree (both 0.010 %/8h, 8h interval) ⇒ ok
ok('funding equal ⇒ ok',
  SV.compareFunding(0.010, { ratePct: 0.010, nextFundingTime: 100, storedNextFundingTime: 100 }, 8).status === 'ok');

// live diverges far beyond tolerance in the SAME period ⇒ mismatch
ok('funding 0.010 vs 0.10 same period ⇒ mismatch',
  SV.compareFunding(0.010, { ratePct: 0.10, nextFundingTime: 100, storedNextFundingTime: 100 }, 8).status === 'mismatch');

// SETTLEMENT BOUNDARY: same big divergence but nextFundingTime advanced ⇒ NOT a
// mismatch (rate legitimately rolled at settlement) — the key false-positive guard.
ok('funding divergence across settlement boundary ⇒ ok (rolled)',
  SV.compareFunding(0.010, { ratePct: 0.10, nextFundingTime: 200, storedNextFundingTime: 100 }, 8).status === 'ok');
ok('rolled carries note',
  SV.compareFunding(0.010, { ratePct: 0.10, nextFundingTime: 200, storedNextFundingTime: 100 }, 8).note === 'settlement-rolled');

// within absolute tolerance (0.005 %/8h) even if relatively large near zero ⇒ ok
ok('funding tiny near-zero drift ⇒ ok (abs floor)',
  SV.compareFunding(0.0002, { ratePct: 0.0004, nextFundingTime: 100, storedNextFundingTime: 100 }, 8).status === 'ok');

// relative >10% above the rate floor AND absolute clears the noise floor ⇒ mismatch
ok('funding 20% relative + real abs ⇒ mismatch',
  SV.compareFunding(0.020, { ratePct: 0.024, nextFundingTime: 100, storedNextFundingTime: 100 }, 8).status === 'mismatch');

// >10% relative but a MICROSCOPIC absolute move (live-predicted-rate drift) ⇒ ok.
// (0.013875 → 0.015295 %/8h = 10.2% rel but only 0.00142 %/8h abs — the real
// TIA-bybit case that must NOT false-drop a live spread.)
ok('funding 10% relative but tiny abs ⇒ ok (predicted-rate drift)',
  SV.compareFunding(0.013875, { ratePct: 0.015295, nextFundingTime: 100, storedNextFundingTime: 100 }, 8).status === 'ok');

// interval scaling: a 1h-interval rate normalizes to /8h for the absolute test
ok('funding 1h interval abs test scales',
  SV.compareFunding(0.001, { ratePct: 0.0016, nextFundingTime: 100, storedNextFundingTime: 100 }, 1).status === 'mismatch');

// live unreachable (null rate) ⇒ unreachable, never fabricated ok
ok('funding null live ⇒ unreachable',
  SV.compareFunding(0.010, { ratePct: null }, 8).status === 'unreachable');

// ── comparePrice (5%) ────────────────────────────────────────────────────────
ok('price within 5% ⇒ ok',       SV.comparePrice(100, 103).status === 'ok');
ok('price beyond 5% ⇒ mismatch', SV.comparePrice(100, 110).status === 'mismatch');
ok('price null ⇒ unreachable',   SV.comparePrice(100, null).status === 'unreachable');

// ── comparePool ──────────────────────────────────────────────────────────────
ok('pool equal ⇒ ok',                 SV.comparePool(300, 300).status === 'ok');
ok('pool 1.5% drift ⇒ ok (no flap)',  SV.comparePool(2154, 2121).status === 'ok');
ok('pool source 0 while served>0 ⇒ mismatch (ended)', SV.comparePool(300, 0).status === 'mismatch');
ok('pool 20% drift ⇒ mismatch',       SV.comparePool(300, 240).status === 'mismatch');
ok('pool null ⇒ unreachable',         SV.comparePool(300, null).status === 'unreachable');

// ── key builders match display-sanity rowId scheme ──────────────────────────
ok('fundingKey canonical (sorted venues)',
  SV.fundingKey('OP', 'hyperliquid', 'binance') === SV.fundingKey('OP', 'binance', 'hyperliquid'));
ok('perpSpotKey', SV.perpSpotKey('BTC', 'extended') === 'perp-spot-BTC-extended');
ok('basisKey',    SV.basisKey('BTC', 'Deribit', 'BTC-25JUN27') === 'basis-BTC-Deribit-BTC-25JUN27');
ok('rewardsKey',  SV.rewardsKey('0xabc') === 'rewards-0xabc');

console.log(`source-verify.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
