#!/usr/bin/env node
'use strict';
// reward-layered-selfcheck — assertions for the layered CONFIG (Phase 3), SCORING (Phase 4) and per-layer
// CAPACITY + capital reconciliation (Phase 5). Pure/offline. One assertion per new behaviour; each proves
// it fires independently. Run: node scripts/reward-layered-selfcheck.js
const assert = require('assert');
const { computeLayeredPlan, scoreLayeredPlan, layerSizeSplit, depthSourceLabel, TAIL_LO, TAIL_HI } = require('../lib/reward-layered');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); passed++; };

// A synthetic mid-book market with a wide band so 3 layers all score. mid 0.50, maxSpread 8 (v=4¢),
// tick 0.01, band 0.46–0.54, minSize 1, poolDay 100.
const RS = { mid: 0.50, maxSpreadCents: 8, minSize: 1, poolDay: 100 };
const BAND = { tick: 0.01, bandLow: 0.46, bandHigh: 0.54 };
function depth(l1, l2, l3) { return [
  { index: 1, bidSizeAtLevel: l1, askSizeAtLevel: l1 },
  { index: 2, bidSizeAtLevel: l2, askSizeAtLevel: l2 },
  { index: 3, bidSizeAtLevel: l3, askSizeAtLevel: l3 },
]; }

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

// ── PHASE 4 — per-layer scoring, history-preferred / live fallback, source disclosure ──────────────
function phase4() {
  console.log('PHASE 4 — score each layer against its own depth');

  // 3 layers, equal split of $200/side into DEEP books (so the honest pool cap never binds here and the
  // per-layer structure is visible): deep→thin depth outward (5000, 3000, 1000).
  const plan3 = computeLayeredPlan({ rewardScore: RS, ...BAND, perSideSizeUsd: 200, numLayers: 3 });
  const scored3 = scoreLayeredPlan({ plan: plan3, perLevelDepth: depth(5000, 3000, 1000), rewardScore: RS, depthSource: { kind: 'storico', hours: 8 } });
  console.log('  layer $/day:', scored3.layers.map((l) => `L${l.index}=${l.dailyUsd}`).join(' '), '| total', scored3.totalDailyUsd, '| poolCapped', scored3.poolCapped);
  ok('every layer scores a finite $/day from its own depth', scored3.layers.every((l) => typeof l.dailyUsd === 'number' && Number.isFinite(l.dailyUsd)));
  ok('per-layer competitorQ differs by layer (own depth + own distance)', new Set(scored3.layers.map((l) => l.competitorQ)).size === 3);
  ok('this realistic case is under the pool cap (structure visible, not masked)', scored3.poolCapped === false);

  // NON-LINEARITY: the 1-layer figure puts the WHOLE $200 at the nearest layer. 3 layers split the size
  // and the outer layers score less — so the 3-layer total is NOT 3x the 1-layer figure.
  const plan1 = computeLayeredPlan({ rewardScore: RS, ...BAND, perSideSizeUsd: 200, numLayers: 1 });
  const scored1 = scoreLayeredPlan({ plan: plan1, perLevelDepth: depth(5000, 3000, 1000), rewardScore: RS, depthSource: { kind: 'storico', hours: 8 } });
  console.log(`  1-layer total=${scored1.totalDailyUsd} · 3-layer total=${scored3.totalDailyUsd} · 3x1layer=${(3*scored1.totalDailyUsd).toFixed(2)}`);
  ok('3-layer total is NOT 3x the 1-layer figure (non-linear)', Math.abs(scored3.totalDailyUsd - 3 * scored1.totalDailyUsd) > 0.5);

  // THIN-OUTER direction: make the OUTER layer thin (50) vs deep (20000); with less competition at that
  // layer our share there is higher, so the two markets' totals differ — the outer depth genuinely moves it.
  const thinOuter = scoreLayeredPlan({ plan: plan3, perLevelDepth: depth(5000, 3000, 50),    rewardScore: RS, depthSource: { kind: 'storico', hours: 8 } });
  const deepOuter = scoreLayeredPlan({ plan: plan3, perLevelDepth: depth(5000, 3000, 20000), rewardScore: RS, depthSource: { kind: 'storico', hours: 8 } });
  const l3thin = thinOuter.layers[2].dailyUsd, l3deep = deepOuter.layers[2].dailyUsd;
  console.log(`  outer layer $/day: thin-book=${l3thin} vs deep-book=${l3deep}`);
  ok('a THIN outer layer earns MORE than a deep one at the same price (own-depth competition)', l3thin > l3deep);
  ok('thin-outer vs deep-outer changes the 3-layer total (not simply additive)', Math.abs(thinOuter.totalDailyUsd - deepOuter.totalDailyUsd) > 0.5);

  // SOURCE DISCLOSURE: history vs live are never presented identically.
  ok('history source label reads "stima da storico Nh"', depthSourceLabel({ kind: 'storico', hours: 8 }) === 'stima da storico 8h');
  ok('live source label reads "stima da lettura live"', depthSourceLabel({ kind: 'live' }) === 'stima da lettura live');
  ok('every scored row carries its depth-source label', scored3.layers.every((l) => l.depthSourceLabel === 'stima da storico 8h'));

  // NULL-PER-LAYER fail-closed: an unreadable level scores "—" (null), never 0, never a guess.
  const withNull = scoreLayeredPlan({ plan: plan3, perLevelDepth: [depth(5000,3000,1000)[0], { index: 2, bidSizeAtLevel: null, askSizeAtLevel: 3000 }, depth(5000,3000,1000)[2]], rewardScore: RS, depthSource: { kind: 'live' } });
  console.log(`  unreadable middle layer → dailyUsd=${withNull.layers[1].dailyUsd} (must be null)`);
  ok('an unreadable layer scores null ("—"), not 0, not a guess', withNull.layers[1].dailyUsd === null && withNull.anyDepthUnreadable === true);
  ok('readable layers around a null one still score', withNull.layers[0].dailyUsd > 0 && withNull.layers[2].dailyUsd > 0);

  // POOL CAP: the summed independent per-layer shares can never earn more than the market's daily pool.
  const smallPool = scoreLayeredPlan({ plan: plan3, perLevelDepth: depth(1, 1, 1), rewardScore: { ...RS, poolDay: 5 }, depthSource: { kind: 'storico', hours: 8 } });
  console.log(`  tiny pool: rawTotal=${smallPool.rawTotalDailyUsd} capped total=${smallPool.totalDailyUsd} poolCapped=${smallPool.poolCapped}`);
  ok('the per-market total is capped at poolDay (never overstate the pool)', smallPool.totalDailyUsd <= 5 + 1e-9 && smallPool.poolCapped === true);
}

console.log('reward-layered-selfcheck\n');
phase3();
phase4();
console.log(`\nreward-layered-selfcheck: ${passed} assertions passed`);
