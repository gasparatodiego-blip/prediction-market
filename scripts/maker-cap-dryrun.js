#!/usr/bin/env node
'use strict';
// scripts/maker-cap-dryrun.js — PROOF that the maker would respect a per-market collateral ceiling.
// DRY RUN: it plans, guards and caps exactly as agent35 does, against a REAL market from the live feed
// and a REAL ceiling written to the REAL durable store. It places NOTHING: no adapter is constructed,
// no credential is loaded, no venue is contacted, and the ceiling it writes is removed at the end.
//
//   node scripts/maker-cap-dryrun.js [marketId] [capUsd]
//
// The four calls below are the SAME four agent35 makes, in the same order — the script asserts they are
// present in the engine and prints their line numbers, so this is a proof about the engine and not a
// re-implementation that happens to agree.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { planQuotes } = require('../lib/maker/quote-plan');
const { validateQuote } = require('../lib/maker/venue-rules');
const { getMarketCap, setMarketCap, clearMarketCap } = require('../lib/maker/market-caps-store');
const { applyCollateralCap } = require('../lib/maker/market-cap');
const { planOnFill } = require('../lib/maker/fill-policy');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'agents', 'agent35-maker.js');
const FEED = '/tmp/liquidity-rewards.json';
const BOOKS = '/tmp/clob-live-books.json';

// ── 0 · the engine really makes these calls (line numbers printed, not asserted-by-vibes) ──────────
const engineSrc = fs.readFileSync(ENGINE, 'utf8').split('\n');
function lineOf(needle) {
  const i = engineSrc.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `agent35-maker.js does not call ${needle} — the engine is not wired to this path`);
  return i + 1;
}
console.log('\nENGINE WIRING (agents/agent35-maker.js)');
console.log(`  planQuotes(...)             → line ${lineOf('const plan = planQuotes(')}`);
console.log(`  validateQuote(...)  [guard] → line ${lineOf('const g = validateQuote(guardRules')}`);
console.log(`  getMarketCap(...)   [cap]   → line ${lineOf('const capRead = getMarketCap(')}`);
console.log(`  applyCollateralCap(...)     → line ${lineOf('const capped = applyCollateralCap(')}`);
console.log(`  planOnFill(...)     [fill]  → line ${lineOf('const onFill = planOnFill(')}`);

// ── 1 · a REAL market from the live feed ────────────────────────────────────────────────────────────
const snap = JSON.parse(fs.readFileSync(FEED, 'utf8'));
const argId = process.argv[2];
const row = argId
  ? snap.markets.find((m) => m.marketId === argId)
  : snap.markets.find((m) => m.venue === 'polymarket' && m.rewardScore && m.rewardScore.mid > 0.05 && m.rewardScore.mid < 0.95 && m.minSize);
assert.ok(row, 'no usable market in the feed snapshot');

// Prefer the LIVE adjusted mid (what the engine quotes off); fall back to the feed's scoring mid.
let mid = row.rewardScore.mid;
let midSource = 'feed rewardScore.mid';
try {
  const books = JSON.parse(fs.readFileSync(BOOKS, 'utf8'));
  const bk = books.markets && books.markets[row.marketId];
  if (bk && bk.live && typeof bk.mid === 'number') { mid = bk.mid; midSource = 'agent34 live adjusted mid'; }
} catch { /* feed mid it is */ }

const maxSpreadC = row.rewardScore.maxSpreadCents;
const minSize = row.rewardScore.minSize;
const tick = typeof row.tickSize === 'number' && row.tickSize > 0 ? row.tickSize : 0.01;
const CAP = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 120;

console.log('\nMARKET');
console.log(`  ${(row.title || '').slice(0, 78)}`);
console.log(`  id ${row.marketId}`);
console.log(`  mid ${(mid * 100).toFixed(2)}¢ (${midSource}) · band ±${(maxSpreadC / 2).toFixed(2)}¢ · tick ${tick} · min_incentive_size ${minSize}`);

// ── 2 · a leg set that DELIBERATELY over-commits, so the ceiling has to do work ─────────────────────
const perLegShares = Math.max(minSize, 200);
const legs = [
  { id: 'DRYRUN-1', book: 'yes', kind: 'buy',  price: +(mid - 0.01).toFixed(4), mode: 'follow', offsetC: -1.0, sizeShares: perLegShares, onFill: 'opposite' },
  { id: 'DRYRUN-2', book: 'yes', kind: 'sell', price: +(mid + 0.01).toFixed(4), mode: 'follow', offsetC:  1.0, sizeShares: perLegShares, onFill: 'opposite' },
  { id: 'DRYRUN-3', book: 'yes', kind: 'buy',  price: +(mid - 0.02).toFixed(4), mode: 'follow', offsetC: -2.0, sizeShares: perLegShares, onFill: 'close' },
];

const plan = planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId: row.tokenId, tokenIdNo: row.tokenIdNo, defaultSizeShares: 0 });

// ── 3 · the SHARED guard, exactly as the engine applies it ──────────────────────────────────────────
const guardRules = { tick, scoringMid: mid, maxSpreadCents: maxSpreadC, minSize };
let guardRefused = 0;
for (const q of plan.quotes) {
  const g = validateQuote(guardRules, { side: q.side, price: q.price, size: q.size });
  q.guard = { valid: g.valid, codes: g.reasons.map((r) => r.code) };
  if (!g.valid && q.postable) { q.postable = false; q.reason = `guard: ${q.guard.codes.join(', ')}`; guardRefused++; }
}
console.log('\nPLANNED LEGS (after the shared venue-rules guard)');
for (const q of plan.quotes) {
  console.log(`  ${q.side.padEnd(4)} ${q.book.toUpperCase().padEnd(3)} @ ${(q.price * 100).toFixed(2)}¢  ${String(q.size).padStart(5)} sh  $${String(q.notionalUsd).padStart(8)}  ` +
    `${q.guard.valid ? 'guard ok' : 'guard REFUSED ' + q.guard.codes.join(',')}  ${q.postable ? 'postable' : 'not postable'}`);
}
console.log(`  guard refused ${guardRefused} of ${plan.quotes.length}`);

// ── 4 · write a REAL ceiling to the REAL durable store, read it back the way the engine does ────────
const before = getMarketCap(row.marketId, { fallbackUsd: null });
const w = setMarketCap(row.marketId, CAP, 'cap-dryrun');
assert.ok(w.ok, `could not write the ceiling: ${w.error}`);
const capRead = getMarketCap(row.marketId, { fallbackUsd: 200 });
assert.strictEqual(capRead.capUsd, CAP);
assert.strictEqual(capRead.source, 'per-market');
console.log(`\nCEILING  $${CAP.toFixed(2)} written to data/maker-market-caps.json and read back (source: ${capRead.source})`);

// ── 5 · apply it — the assertion that matters ───────────────────────────────────────────────────────
const capped = applyCollateralCap({ quotes: plan.quotes, capUsd: capRead.capUsd });
const admitted = capped.quotes.filter((q) => q.postable);
const blocked = capped.quotes.filter((q) => q.capBlocked);

console.log('\nUNDER THE CEILING');
console.log(`  planned  $${capped.plannedNotionalUsd.toFixed(2)}`);
console.log(`  admitted $${capped.admittedNotionalUsd.toFixed(2)}  (${admitted.length} legs)`);
console.log(`  refused  ${capped.blockedCount} legs — ${blocked.map((q) => `${q.side} @${(q.price * 100).toFixed(1)}¢`).join(', ') || 'none'}`);
assert.ok(capped.admittedNotionalUsd <= CAP + 1e-9,
  `CEILING BREACHED: committed $${capped.admittedNotionalUsd} under a $${CAP} ceiling`);
console.log(`  ✓ committed collateral $${capped.admittedNotionalUsd.toFixed(2)} ≤ ceiling $${CAP.toFixed(2)}`);

// ── 6 · the on-fill round-trip is bounded by the SAME ceiling ───────────────────────────────────────
const headroom = Math.max(0, CAP - capped.admittedNotionalUsd);
const filled = admitted[0];
if (filled) {
  const fp = planOnFill({ filledLeg: { book: filled.book, kind: filled.kind, price: filled.price, offsetC: filled.offsetC, size: filled.size },
    rule: 'opposite', mid, maxSpreadC, tick, minSize, capHeadroomUsd: headroom });
  console.log('\nON-FILL, WITH THE CEILING STILL BINDING');
  console.log(`  headroom $${headroom.toFixed(2)} · round-trip would need $${(filled.price * filled.size).toFixed(2)}`);
  console.log(`  action: ${fp.action} — ${fp.reason}`);
  if (fp.action === 'place-opposite') {
    assert.ok(fp.quote.notionalUsd <= headroom + 1e-9, 'a round-trip was admitted above the headroom');
    console.log(`  ✓ round-trip admitted only because it fits: $${fp.quote.notionalUsd.toFixed(2)} ≤ $${headroom.toFixed(2)}`);
  } else {
    console.log('  ✓ round-trip refused — inventory cannot grow past the ceiling');
  }
}

// ── 7 · restore the store, and state plainly what did NOT happen ────────────────────────────────────
if (before.source === 'per-market') setMarketCap(row.marketId, before.capUsd, before.updatedBy || 'restored');
else clearMarketCap(row.marketId);
const after = getMarketCap(row.marketId, { fallbackUsd: null });
assert.strictEqual(after.source, before.source, 'the dry run must leave the caps store as it found it');
console.log(`\n  ✓ caps store restored (${after.source})`);

console.log('\nWHAT THIS RUN DID NOT DO: no adapter was constructed, no credential was read, no venue');
console.log('endpoint was contacted, no order was signed, placed or cancelled. MAKER_MODE was not read');
console.log('and not changed. This is a planning + ceiling proof, nothing more.\n');
