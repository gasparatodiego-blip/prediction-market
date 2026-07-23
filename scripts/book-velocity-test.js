#!/usr/bin/env node
'use strict';
/**
 * Unit tests for lib/book-velocity.js — the pure metric.
 *
 * Covers the contract claims that matter: executable-only, sign-consistency,
 * depth normalisation direction, the revert/persist split, and every
 * "unknown book → no signal" path. Plain node, no test framework.
 *
 * Usage: node scripts/book-velocity-test.js
 */
const bv = require('../lib/book-velocity');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) < eps; }

const S = (t, bid, ask, bidSz, askSz) => ({ t, bid, ask, bidSz, askSz });

console.log('\n── normalizeSnapshot: unknown/unreadable book → null, never a patched value ──');
ok('valid snapshot passes', bv.normalizeSnapshot(S(1000, 0.4, 0.41, 100, 100)) !== null);
ok('null input → null', bv.normalizeSnapshot(null) === null);
ok('missing bid → null', bv.normalizeSnapshot({ t: 1, ask: 0.5, bidSz: 1, askSz: 1 }) === null);
ok('NaN price → null', bv.normalizeSnapshot(S(1, NaN, 0.5, 1, 1)) === null);
ok('null size → null', bv.normalizeSnapshot(S(1, 0.4, 0.5, null, 1)) === null);
ok('zero size → null (level absent, not zero depth)', bv.normalizeSnapshot(S(1, 0.4, 0.5, 0, 1)) === null);
ok('crossed book (bid > ask) → null', bv.normalizeSnapshot(S(1, 0.6, 0.5, 1, 1)) === null);
ok('locked book (bid == ask) → null', bv.normalizeSnapshot(S(1, 0.5, 0.5, 1, 1)) === null);
ok('price >= 1 → null', bv.normalizeSnapshot(S(1, 0.99, 1.0, 1, 1)) === null);
ok('price <= 0 → null', bv.normalizeSnapshot(S(1, 0, 0.5, 1, 1)) === null);
ok('string price rejected (no coercion)', bv.normalizeSnapshot({ t: 1, bid: '0.4', ask: 0.5, bidSz: 1, askSz: 1 }) === null);

console.log('\n── executableMove: both sides must confirm; mid is never used ──');
{
  const up = bv.executableMove(S(0, 0.40, 0.41, 1, 1), S(0, 0.45, 0.46, 1, 1));
  ok('parallel up-move → +5c, direction +1', near(up.moveCents, 5) && up.direction === 1, JSON.stringify(up));
  const dn = bv.executableMove(S(0, 0.40, 0.41, 1, 1), S(0, 0.35, 0.36, 1, 1));
  ok('parallel down-move → -5c, direction -1', near(dn.moveCents, -5) && dn.direction === -1, JSON.stringify(dn));
  const wide = bv.executableMove(S(0, 0.40, 0.41, 1, 1), S(0, 0.35, 0.46, 1, 1));
  ok('spread WIDENS (bid down, ask up) → 0, not a price move', wide.moveCents === 0 && wide.direction === 0, JSON.stringify(wide));
  const narrow = bv.executableMove(S(0, 0.40, 0.46, 1, 1), S(0, 0.44, 0.45, 1, 1));
  ok('spread NARROWS → 0, not a price move', narrow.moveCents === 0, JSON.stringify(narrow));
  const uneven = bv.executableMove(S(0, 0.40, 0.41, 1, 1), S(0, 0.42, 0.50, 1, 1));
  ok('uneven up-move takes the conservative MIN (+2c not +9c)', near(uneven.moveCents, 2), JSON.stringify(uneven));
  // Mid would show a move here; executable prices show none on one side.
  const midOnly = bv.executableMove(S(0, 0.40, 0.41, 1, 1), S(0, 0.40, 0.50, 1, 1));
  ok('ask-only move (mid rises, bid static) → 0', midOnly.moveCents === 0, JSON.stringify(midOnly));
}

console.log('\n── depthWeight: severity RISES with depth, sub-linearly, anchored on minSize ──');
{
  const wAtMin = bv.depthWeight(200, 200);
  ok('depth == minSize → ln 2', near(wAtMin, Math.log(2)), String(wAtMin));
  const w10x = bv.depthWeight(2000, 200);
  ok('depth == 10x minSize → ln 11', near(w10x, Math.log(11)), String(w10x));
  ok('deeper book scores HIGHER (not lower)', bv.depthWeight(5000, 200) > bv.depthWeight(4, 200));
  const thin = bv.depthWeight(4, 200), atMin = bv.depthWeight(200, 200);
  ok('$4 book vs $200 min is damped ~35x vs a book at the minimum', atMin / thin > 30, `ratio ${(atMin / thin).toFixed(1)}`);
  ok('sub-linear: 10x depth is < 10x weight', bv.depthWeight(2000, 200) < 10 * bv.depthWeight(200, 200));
  ok('unknown minSize → null (no guessed anchor)', bv.depthWeight(1000, null) === null);
  ok('zero minSize → null', bv.depthWeight(1000, 0) === null);
}

console.log('\n── velocityPair ──');
{
  const p = bv.velocityPair(S(0, 0.40, 0.41, 1000, 1000), S(60_000, 0.45, 0.46, 1000, 1000), { minSizeUsd: 200 });
  ok('returns a pair for a clean 5c up-move', p !== null);
  ok('depth is taken on the CONSUMED side (asks lifted) at t0',
    near(p.depthUsd0, 0.41 * 1000), String(p.depthUsd0));
  const expected = 5 * Math.log1p(0.41 * 1000 / 200) / 1;
  ok('nv = |move| * weight / minutes', near(p.nv, expected), `${p.nv} vs ${expected}`);
  ok('unknown minSize → null', bv.velocityPair(S(0, 0.4, 0.41, 1, 1), S(60_000, 0.45, 0.46, 1, 1), {}) === null);
  ok('unreadable first book → null', bv.velocityPair(S(0, 0.6, 0.41, 1, 1), S(60_000, 0.45, 0.46, 1, 1), { minSizeUsd: 200 }) === null);
  ok('unreadable second book → null', bv.velocityPair(S(0, 0.4, 0.41, 1, 1), null, { minSizeUsd: 200 }) === null);
  ok('gap beyond maxPairGapMs → null (unobserved path is not a move)',
    bv.velocityPair(S(0, 0.4, 0.41, 1, 1), S(999_000, 0.45, 0.46, 1, 1), { minSizeUsd: 200 }) === null);
  ok('non-increasing time → null', bv.velocityPair(S(60_000, 0.4, 0.41, 1, 1), S(0, 0.45, 0.46, 1, 1), { minSizeUsd: 200 }) === null);
  // A big move on a book far below the qualifying size must NOT clear the bar.
  const thin = bv.velocityPair(S(0, 0.40, 0.41, 10, 10), S(60_000, 0.50, 0.51, 10, 10), { minSizeUsd: 1000 });
  ok('10c move on a ~$4 book stays far below threshold', thin.nv < bv.DEFAULTS.nvThreshold, `nv=${thin.nv.toFixed(3)}`);
  const deep = bv.velocityPair(S(0, 0.40, 0.41, 10000, 10000), S(60_000, 0.50, 0.51, 10000, 10000), { minSizeUsd: 1000 });
  ok('same 10c move on a $4.1k book clears threshold', deep.nv >= bv.DEFAULTS.nvThreshold, `nv=${deep.nv.toFixed(3)}`);
}

console.log('\n── classifyHold: reverting vs persistent ──');
{
  const p = bv.velocityPair(S(0, 0.40, 0.41, 5000, 5000), S(60_000, 0.50, 0.51, 5000, 5000), { minSizeUsd: 200 });
  const held = bv.classifyHold(p, S(60_000 + 180_000, 0.50, 0.51, 5000, 5000));
  ok('price stays put → PERSISTENT, retention 1', held.state === 'PERSISTENT' && near(held.retention, 1), JSON.stringify(held));
  const back = bv.classifyHold(p, S(60_000 + 180_000, 0.40, 0.41, 5000, 5000));
  ok('price returns fully → REVERTING, retention 0', back.state === 'REVERTING' && near(back.retention, 0), JSON.stringify(back));
  const half = bv.classifyHold(p, S(60_000 + 180_000, 0.45, 0.46, 5000, 5000));
  ok('exactly half held → PERSISTENT (retentionMin boundary is inclusive)', half.state === 'PERSISTENT', JSON.stringify(half));
  const justUnder = bv.classifyHold(p, S(60_000 + 180_000, 0.44, 0.45, 5000, 5000));
  ok('just under half held → REVERTING', justUnder.state === 'REVERTING', JSON.stringify(justUnder));
  const early = bv.classifyHold(p, S(60_000 + 10_000, 0.50, 0.51, 5000, 5000));
  ok('before the hold window elapses → UNKNOWN, never guessed', early.state === 'UNKNOWN', JSON.stringify(early));
  const blind = bv.classifyHold(p, null);
  ok('no future book → UNKNOWN', blind.state === 'UNKNOWN' && blind.retention === null);
  const unread = bv.classifyHold(p, S(60_000 + 180_000, 0.6, 0.5, 1, 1));
  ok('unreadable future book → UNKNOWN', unread.state === 'UNKNOWN');
  // Overshoot: price kept going. Retention > 1 is still PERSISTENT.
  const over = bv.classifyHold(p, S(60_000 + 180_000, 0.60, 0.61, 5000, 5000));
  ok('move continued past t1 → PERSISTENT with retention > 1', over.state === 'PERSISTENT' && over.retention > 1, JSON.stringify(over));
}

console.log('\n── isDetection ──');
{
  const p = bv.velocityPair(S(0, 0.40, 0.41, 10000, 10000), S(60_000, 0.50, 0.51, 10000, 10000), { minSizeUsd: 1000 });
  ok('strong move on a deep book fires', bv.isDetection(p) === true, `nv=${p.nv.toFixed(2)}`);
  ok('null pair never fires', bv.isDetection(null) === false);
  const flat = bv.velocityPair(S(0, 0.40, 0.41, 10000, 10000), S(60_000, 0.40, 0.41, 10000, 10000), { minSizeUsd: 1000 });
  ok('no move → no detection', bv.isDetection(flat) === false);
  // minMoveCents floor. It only binds where depth/minSize > e^10-1 (~22,025), i.e.
  // above ~$881k at the touch against a $40 minimum. Below a sub-tick move simply
  // cannot reach nv 10 on its own, so this constructs the case where it CAN.
  const tiny = bv.velocityPair(S(0, 0.400, 0.410, 1e7, 1e7), S(60_000, 0.409, 0.419, 1e7, 1e7), { minSizeUsd: 40 });
  ok('sub-tick 0.9c move on a $4.1M book clears nv but is blocked by the minMoveCents floor',
    tiny.nv >= bv.DEFAULTS.nvThreshold && bv.isDetection(tiny) === false,
    `nv=${tiny.nv.toFixed(2)} move=${tiny.moveCents.toFixed(2)}c`);
}

console.log('\n── scanSeries: end-to-end over a synthetic series ──');
{
  const base = [];
  for (let i = 0; i < 10; i++) base.push(S(i * 10_000, 0.40, 0.41, 8000, 8000));   // 100s calm
  for (let i = 10; i < 40; i++) base.push(S(i * 10_000, 0.52, 0.53, 8000, 8000));  // jump, then holds
  const det = bv.scanSeries(base, { minSizeUsd: 1000, thinBook: false });
  ok('detects the jump', det.length > 0, `n=${det.length}`);
  ok('classified PERSISTENT', det[0] && det[0].state === 'PERSISTENT', det[0] && det[0].state);
  ok('thinBook flag is passed through, not derived', det[0] && det[0].thinBook === false);

  const rev = [];
  for (let i = 0; i < 10; i++) rev.push(S(i * 10_000, 0.40, 0.41, 8000, 8000));
  for (let i = 10; i < 14; i++) rev.push(S(i * 10_000, 0.52, 0.53, 8000, 8000));   // spike
  for (let i = 14; i < 40; i++) rev.push(S(i * 10_000, 0.40, 0.41, 8000, 8000));   // and back
  const det2 = bv.scanSeries(rev, { minSizeUsd: 1000, thinBook: true });
  ok('detects the spike', det2.length > 0, `n=${det2.length}`);
  ok('classified REVERTING (noise a maker profits from)', det2[0] && det2[0].state === 'REVERTING', det2[0] && det2[0].state);
  ok('thinBook true propagates', det2[0] && det2[0].thinBook === true);

  ok('empty series → no detections', bv.scanSeries([], { minSizeUsd: 1000 }).length === 0);
  ok('single sample → no detections', bv.scanSeries([S(0, 0.4, 0.41, 1, 1)], { minSizeUsd: 1000 }).length === 0);
  ok('all-unreadable series → no detections',
    bv.scanSeries([S(0, 0.6, 0.4, 1, 1), S(10_000, 0.7, 0.5, 1, 1)], { minSizeUsd: 1000 }).length === 0);
  ok('unknown minSize over a real move → no detections',
    bv.scanSeries(base, { minSizeUsd: null }).length === 0);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
