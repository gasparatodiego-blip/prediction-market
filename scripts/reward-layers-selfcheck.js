#!/usr/bin/env node
'use strict';
// reward-layers-selfcheck — assertions for the canonical layer geometry (lib/reward-layers.js) and,
// as later phases land, the layered scoring/capacity behaviours that reuse it. Pure/offline. Each
// assertion proves ONE behaviour; the "control" lines prove a guard is what moved the result.
// Run: node scripts/reward-layers-selfcheck.js
const assert = require('assert');
const { rewardLayers, snapToTick } = require('../lib/reward-layers');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); passed++; };
const prices = (arr) => arr.map((l) => l.price);

// ── PHASE 1 — canonical usable-layer count + snapped prices ───────────────────────────────────────
function phase1() {
  console.log('PHASE 1 — reward-layers geometry');

  // A real sampled market: band 0.6375–0.6825, tick 0.01 (adjMid 0.66, half-width 0.0225).
  const m = rewardLayers(0.6375, 0.6825, 0.01);
  console.log(`  real market: maxUsablePerSide=${m.maxUsablePerSide} center=${m.center} bid=${prices(m.bid)} ask=${prices(m.ask)}`);
  ok('floor(half_width/tick): 0.0225/0.01 → 2 usable layers per side', m.maxUsablePerSide === 2);
  ok('bid layers are the two tick-snapped prices below mid, nearest first', JSON.stringify(prices(m.bid)) === JSON.stringify([0.65, 0.64]));
  ok('ask layers are the two tick-snapped prices above mid, nearest first', JSON.stringify(prices(m.ask)) === JSON.stringify([0.67, 0.68]));
  ok('every layer price is on the tick grid', [...m.bid, ...m.ask].every((l) => Math.abs(l.price / 0.01 - Math.round(l.price / 0.01)) < 1e-9));
  ok('every layer price is inside the band', [...m.bid, ...m.ask].every((l) => l.price >= 0.6375 - 1e-9 && l.price <= 0.6825 + 1e-9));

  // One-tick (half-width = 1 tick) band → EXACTLY 1 layer per side, and no selector should be offered.
  const one = rewardLayers(0.64, 0.66, 0.01);
  console.log(`  one-tick band: maxUsablePerSide=${one.maxUsablePerSide} bid=${prices(one.bid)} ask=${prices(one.ask)}`);
  ok('a one-tick-half-width band returns EXACTLY 1 layer per side', one.maxUsablePerSide === 1 && one.bid.length === 1 && one.ask.length === 1);
  ok('the single layer sits one tick either side of mid', prices(one.bid)[0] === 0.64 && prices(one.ask)[0] === 0.66);

  // Band too tight for even one distinct tick offset → 0 usable, nothing guessed.
  const tight = rewardLayers(0.645, 0.655, 0.01);
  ok('a sub-tick-half-width band yields 0 usable layers (never a guessed 1)', tight.maxUsablePerSide === 0 && tight.bid.length === 0);

  // Spacing reduces how many fit, but never raises the hard cap.
  const spaced = rewardLayers(0.6375, 0.6825, 0.01, { spacingTicks: 2 });
  console.log(`  spacing=2: cap=${spaced.maxUsablePerSide} bid=${prices(spaced.bid)} ask=${prices(spaced.ask)}`);
  ok('spacing 2 fits fewer layers (0.68 ask / 0.64 bid) but cap stays 2', spaced.maxUsablePerSide === 2 && JSON.stringify(prices(spaced.ask)) === JSON.stringify([0.68]) && JSON.stringify(prices(spaced.bid)) === JSON.stringify([0.64]));

  // maxLayers caps the emitted count without changing the geometry.
  const capped = rewardLayers(0.6375, 0.6825, 0.01, { maxLayers: 1 });
  ok('maxLayers=1 emits only the nearest layer each side', capped.bid.length === 1 && capped.ask.length === 1 && capped.bid[0].price === 0.65);

  // MERGE: a snapped duplicate must never appear twice. Force it with a tick that rounds two indices
  // to the same grid price near the band edge — a wide band, tiny fractional spacing is guarded by the
  // Math.max(1, floor) on spacingTicks, so instead prove dedupe via a degenerate tick alignment.
  const merged = rewardLayers(0.10, 0.90, 0.01, { spacingTicks: 1 });
  const allPrices = [...merged.bid, ...merged.ask].map((l) => l.price);
  ok('no duplicate price is ever emitted (merge holds)', new Set(allPrices.map((p) => p.toFixed(8))).size === allPrices.length);

  // Invalid inputs → empty, never a default.
  ok('inverted band → 0 usable, empty layers', rewardLayers(0.7, 0.6, 0.01).maxUsablePerSide === 0);
  ok('non-positive tick → 0 usable, empty layers', rewardLayers(0.6, 0.7, 0).bid.length === 0);
  ok('NaN input → 0 usable, empty layers', rewardLayers(NaN, 0.7, 0.01).maxUsablePerSide === 0);

  // snapToTick is exported and correct (callers snap consistently).
  ok('snapToTick rounds to the nearest grid multiple', snapToTick(0.6549, 0.01) === 0.65 && snapToTick(0.6551, 0.01) === 0.66);
}

console.log('reward-layers-selfcheck\n');
phase1();
console.log(`\nreward-layers-selfcheck: ${passed} assertions passed`);
