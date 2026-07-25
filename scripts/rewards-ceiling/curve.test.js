#!/usr/bin/env node
'use strict';
// Unit tests for the capital-to-share curve — hand-computed expected values, and cross-checked against the
// shared lib (quadraticUserShare) so my algebraic inverse can never diverge from the lane's own scoring.
const assert = require('assert');
const { capitalForShare, shareForCapital, quadraticUserShare } = require('./lib/curve');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol;

// ── Hand-computed: mid 0.50, competitorQ 500 shares. At S=1, per-side capital for share X = price·cQ·X/(1−X).
//    price = 0.50, cQ = 500. TOTAL = 2× per-side.
//    X=50%:  perSide = 0.50·500·(0.5/0.5)=250 → total 500.
//    X=25%:  perSide = 0.50·500·(0.25/0.75)=83.333… → total 166.667.
//    X=75%:  perSide = 0.50·500·(0.75/0.25)=750 → total 1500.
//    X=90%:  perSide = 0.50·500·(0.90/0.10)=2250 → total 4500.
console.log('curve.test — capital-to-share, mid 0.50, competitorQ 500');
ok('X=50% → total $500',   near(capitalForShare(500, 0.50, 0.50), 500));
ok('X=25% → total $166.667', near(capitalForShare(500, 0.50, 0.25), 166.66666667, 1e-4));
ok('X=75% → total $1500',  near(capitalForShare(500, 0.50, 0.75), 1500));
ok('X=90% → total $4500',  near(capitalForShare(500, 0.50, 0.90), 4500));

// ── Inverse round-trips: shareForCapital(capitalForShare(X)) === X.
for (const X of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const cap = capitalForShare(500, 0.50, X);
  ok(`round-trip share↔capital at X=${X}`, near(shareForCapital(500, 0.50, cap), X, 1e-9));
}

// ── Cross-check against the SHARED LIB: quadraticUserShare with the SAME per-side capital + s=0 (S=1)
//    must return the SAME share. This proves the analysis uses the lane's real scoring, not a parallel one.
//    quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, capitalPerSide, distanceCents).
console.log('cross-check vs lib/rewardScore.quadraticUserShare (s=0 ⇒ S=1):');
for (const X of [0.1, 0.25, 0.5, 0.75]) {
  const perSide = capitalForShare(500, 0.50, X) / 2;               // the per-side capital my curve implies
  const libShare = quadraticUserShare(500, 0.50, 6, 1, perSide, 0); // band 6c, minSize 1 (size well above)
  ok(`lib share == target X=${X} (${(libShare * 100).toFixed(2)}%)`, near(libShare, X, 1e-6));
}

// ── Non-mid price: mid 0.20, cQ 300, X=50% → perSide = 0.20·300·1 = 60 → total 120.
ok('mid 0.20, cQ 300, X=50% → total $120', near(capitalForShare(300, 0.20, 0.50), 120));

// ── Degenerate guards.
ok('X→1 is not representable (returns for X<1 only)', capitalForShare(500, 0.5, 1) === null);
ok('cQ=0 → zero capital holds ~100% (no competition)', capitalForShare(0, 0.5, 0.5) === 0);

console.log(`\ncurve.test: ${n} assertions passed`);
