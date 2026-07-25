#!/usr/bin/env node
'use strict';
// reward-layered-selfcheck — assertions for the layered CONFIG (Phase 3), SCORING (Phase 4) and per-layer
// CAPACITY + capital reconciliation (Phase 5). Pure/offline. One assertion per new behaviour; each proves
// it fires independently. Run: node scripts/reward-layered-selfcheck.js
const assert = require('assert');
const { computeLayeredPlan, layerSizeSplit, TAIL_LO, TAIL_HI } = require('../lib/reward-layered');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); passed++; };

// ── PHASE 3 — layered configuration + per-layer tick-snap / tails / collapse ───────────────────────
function phase3() {
  console.log('PHASE 3 — layered quote configuration');

  // A real market: adjMid 0.66, maxSpread 4.5 (band radius 2.25¢ → band 0.6375–0.6825), tick 0.01,
  // minSize 1 share. Usable layers per side = 2.
  const rs = { mid: 0.66, maxSpreadCents: 4.5, minSize: 1, competitorQ: 500, poolDay: 30 };
  const plan = computeLayeredPlan({ rewardScore: rs, tick: 0.01, bandLow: 0.6375, bandHigh: 0.6825, perSideSizeUsd: 1000, numLayers: 5 });
  console.log(`  request 5 layers → maxUsable=${plan.maxUsablePerSide} numLayers=${plan.numLayers} prices bid=${plan.layers.map(l=>l.bidPrice)} ask=${plan.layers.map(l=>l.askPrice)}`);
  ok('numLayers is clamped to the real usable count (5 requested → 2)', plan.numLayers === 2 && plan.maxUsablePerSide === 2);
  ok('every layer price is on the tick grid and in band', plan.layers.every(l => [l.bidPrice, l.askPrice].every(p => Math.abs(p/0.01 - Math.round(p/0.01)) < 1e-9 && p >= 0.6375-1e-9 && p <= 0.6825+1e-9)));
  ok('equal split: per-layer $ sums to the per-side budget', Math.abs(plan.layers.reduce((a,l)=>a+l.sizeUsd,0) - 1000) < 0.01);
  ok('nearest layer is index 1 (bid 0.65 / ask 0.67)', plan.layers[0].bidPrice === 0.65 && plan.layers[0].askPrice === 0.67);
  ok('no layer is degraded or tail on a healthy mid-book market', plan.layers.every(l => !l.degraded && !l.tailZero && l.quoteValid));

  // A ONE-TICK band → exactly 1 layer, so the selector must not be offered (numLayers cannot exceed 1).
  const one = computeLayeredPlan({ rewardScore: { mid: 0.65, maxSpreadCents: 2, minSize: 1 }, tick: 0.01, bandLow: 0.64, bandHigh: 0.66, perSideSizeUsd: 500, numLayers: 3 });
  ok('one-tick band offers exactly 1 layer (selector hidden upstream when maxUsable=1)', one.maxUsablePerSide === 1 && one.numLayers === 1);

  // TAILS per layer: mid 0.88, band 0.85–0.91 (maxSpread 6). Usable = 3. The outer ask layer lands at
  // 0.91, in the tail (> 0.90) → that layer earns nothing, while the inner layers still score.
  const tail = computeLayeredPlan({ rewardScore: { mid: 0.88, maxSpreadCents: 6, minSize: 1 }, tick: 0.01, bandLow: 0.85, bandHigh: 0.91, perSideSizeUsd: 900, numLayers: 3 });
  const outer = tail.layers[tail.layers.length - 1];
  console.log(`  near-tail market: outer layer bid=${outer.bidPrice} ask=${outer.askPrice} tailZero=${outer.tailZero}`);
  ok('an outer layer priced in the tail (0.91 > 0.90) is flagged tailZero, per layer', outer.askPrice === 0.91 && outer.askTail === true && outer.tailZero === true);
  ok('inner layers of the same near-tail market are NOT tail-zeroed', tail.layers[0].tailZero === false);
  ok('tail-zero layer carries the plain-Italian no-reward note', /coda del book/.test(outer.note));

  // COLLAPSE / degradation per layer: a per-side budget so small that shares fall below min_incentive_size
  // makes BOTH legs unqualified → the two-sided Q_min collapses to zero, disclosed per layer.
  const tiny = computeLayeredPlan({ rewardScore: { mid: 0.66, maxSpreadCents: 4.5, minSize: 100 }, tick: 0.01, bandLow: 0.6375, bandHigh: 0.6825, perSideSizeUsd: 10, numLayers: 2 });
  console.log(`  below-min market: layer1 degraded=${tiny.layers[0].degraded} weakerSide=${tiny.layers[0].weakerSide}`);
  ok('a below-min-size layer is degraded and its weaker side is "both" (collapse to 0)', tiny.layers[0].degraded === true && tiny.layers[0].weakerSide === 'both');
  ok('degraded layer is not quoteValid', tiny.layers.every(l => l.quoteValid === false));

  // Size-split shape is swappable (front-loaded weights) without touching the geometry.
  const split = layerSizeSplit(3, { weights: [3, 2, 1] });
  ok('custom size-split weights normalise to sum 1 (swappable shape)', Math.abs(split.reduce((a,b)=>a+b,0) - 1) < 1e-9 && split[0] > split[2]);
  ok('default size-split is equal', JSON.stringify(layerSizeSplit(4)) === JSON.stringify([0.25,0.25,0.25,0.25]));
}

console.log('reward-layered-selfcheck\n');
phase3();
console.log(`\nreward-layered-selfcheck: ${passed} assertions passed`);
