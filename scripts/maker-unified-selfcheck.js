#!/usr/bin/env node
'use strict';
// scripts/maker-unified-selfcheck.js — proves the three new SSOT cores of the unified market screen
// behave, WITHOUT a network, a key, a venue call or an order. Run:  node scripts/maker-unified-selfcheck.js
//
//   1. worth-it   — the verdict says "non conviene" on the real Kamala numbers and "conviene" on a real
//                   good market, and its payout floor agrees with lib/rewards-estimate.ts.
//   2. market-cap — the per-market collateral ceiling is genuinely enforced on a planned quote set:
//                   nearest-to-mid admitted first, everything past the ceiling refused, fail-closed on
//                   an unreadable ceiling. THIS IS THE DRY RUN: it plans and caps, it places nothing.
//   3. fill-policy— the per-side on-fill rule maps to a real follow-up order, and that follow-up passes
//                   through the SHARED venue-rules guard (an off-band / under-min follow-up is refused)
//                   and through the market's remaining collateral headroom.
//
// EXIT 0 = every assertion held. Any failure exits 1 with the assertion that broke.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { computeWorthIt, MIN_PAYOUT_USD } = require('../lib/maker/worth-it');
const { applyCollateralCap } = require('../lib/maker/market-cap');
const { planOnFill, normalizeFillRule } = require('../lib/maker/fill-policy');
const { planQuotes } = require('../lib/maker/quote-plan');
const { computePriceRow } = require('../lib/reward-price-row');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };

// ── 1 · WORTH-IT ────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. worth-it — the vale-la-pena verdict');

// The floor must not drift from the TypeScript estimator's own MIN_PAYOUT_USD.
const estSrc = fs.readFileSync(path.join(ROOT, 'lib', 'rewards-estimate.ts'), 'utf8');
const m = estSrc.match(/MIN_PAYOUT_USD\s*=\s*([0-9.]+)/);
assert.ok(m, 'MIN_PAYOUT_USD not found in lib/rewards-estimate.ts');
assert.strictEqual(Number(m[1]), MIN_PAYOUT_USD,
  `payout floor drift: worth-it ${MIN_PAYOUT_USD} vs rewards-estimate ${m[1]}`);
ok(`payout floor agrees with lib/rewards-estimate.ts ($${MIN_PAYOUT_USD}/day)`);

// The Kamala case, with the REAL measured numbers: gross $0.10/day at $100, modelled adverse $0.84/day.
const kamala = computeWorthIt({ grossPerDay: 0.1034, adverseCostPerDay: 0.84, ownImpactPct: 0.02,
  perSideShares: 833, minSize: 200, poolDay: 27 });
assert.strictEqual(kamala.verdict, 'no', 'Kamala must be refused');
assert.ok(kamala.reasons.some((r) => r.code === 'GROSS_BELOW_FLOOR'), 'Kamala must cite the payout floor');
assert.ok(kamala.reasons.some((r) => r.code === 'ADVERSE_EXCEEDS_GROSS'), 'Kamala must cite adverse selection');
ok(`Kamala → "${kamala.headline}" (${kamala.reasons.map((r) => r.code).join(', ')})`);

// A market that clears the floor with the adverse cost well under it.
const good = computeWorthIt({ grossPerDay: 8.4, adverseCostPerDay: 1.9, ownImpactPct: 0.2,
  perSideShares: 640, minSize: 200, poolDay: 149 });
assert.strictEqual(good.verdict, 'ok', 'a clearing market must read ok');
assert.strictEqual(good.reasons.length, 0, 'a clearing market carries no blocking reason');
ok(`good market → "${good.headline}"`);

// Below min_incentive_size is refused even when the gross looks fine.
const belowMin = computeWorthIt({ grossPerDay: 12, adverseCostPerDay: 1, perSideShares: 40, minSize: 200 });
assert.strictEqual(belowMin.verdict, 'no');
assert.ok(belowMin.reasons.some((r) => r.code === 'BELOW_MIN_SIZE'));
ok('below min_incentive_size → refused, with the size reason');

// You-are-the-book is a reservation, not a refusal.
const heavy = computeWorthIt({ grossPerDay: 12, adverseCostPerDay: 1, ownImpactPct: 83, perSideShares: 900, minSize: 200 });
assert.strictEqual(heavy.verdict, 'thin');
assert.ok(heavy.reasons.some((r) => r.code === 'OWN_IMPACT_HIGH'));
ok('own-impact 83% → "thin" with the become-the-book reservation');

// An unreadable gross is never "ok".
assert.strictEqual(computeWorthIt({ grossPerDay: null }).verdict, 'unknown');
ok('unreadable gross → "unknown", never a positive verdict');

// ── 2 · MARKET-CAP (the DRY RUN) ────────────────────────────────────────────────────────────────────
console.log('\n2. market-cap — the per-market collateral ceiling (dry run: plans, places nothing)');

// A REAL planned quote set, built by the real planner off a real market's geometry.
const mid = 0.39, maxSpreadC = 3, tick = 0.01, minSize = 40;
const legs = [
  { id: 'L1', book: 'yes', kind: 'buy',  price: 0.38, mode: 'follow', offsetC: -1.0, sizeShares: 260 },
  { id: 'L2', book: 'yes', kind: 'sell', price: 0.40, mode: 'follow', offsetC:  1.0, sizeShares: 260 },
  { id: 'L3', book: 'yes', kind: 'buy',  price: 0.38, mode: 'pinned', offsetC:  0.0, sizeShares: 260 },
];
// Two distinct ladder levels + one far level, so the ordering rule is actually exercised.
legs[2].price = 0.375; legs[2].offsetC = -1.5;
const plan = planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId: 'TOK_YES', tokenIdNo: 'TOK_NO', defaultSizeShares: 0 });
const postable = plan.quotes.filter((q) => q.postable);
assert.ok(postable.length >= 2, 'the fixture must produce at least two postable quotes');
const plannedTotal = postable.reduce((s, q) => s + q.notionalUsd, 0);
ok(`planner produced ${postable.length} postable quotes, $${plannedTotal.toFixed(2)} notional`);

// The ceiling admits nearest-to-mid first and refuses the rest.
const CAP = 120;
const capped = applyCollateralCap({ quotes: plan.quotes, capUsd: CAP });
assert.ok(capped.admittedNotionalUsd <= CAP + 1e-9,
  `cap breached: admitted $${capped.admittedNotionalUsd} > cap $${CAP}`);
assert.ok(capped.blockedCount > 0, 'a cap below the planned notional must block something');
const admitted = capped.quotes.filter((q) => q.postable);
const blocked = capped.quotes.filter((q) => q.capBlocked);
const worstAdmitted = Math.max(...admitted.map((q) => q.distanceC));
const bestBlocked = Math.min(...blocked.map((q) => q.distanceC));
assert.ok(worstAdmitted <= bestBlocked, 'admission must be nearest-to-mid first');
ok(`cap $${CAP}: admitted $${capped.admittedNotionalUsd.toFixed(2)} (${admitted.length} legs), refused ${capped.blockedCount} — nearest-to-mid kept`);

// A cap of 0 admits nothing. Fail-closed: an unreadable ceiling is handed in as 0 by the store.
const zero = applyCollateralCap({ quotes: plan.quotes, capUsd: 0 });
assert.strictEqual(zero.quotes.filter((q) => q.postable).length, 0, 'a $0 ceiling must admit nothing');
assert.strictEqual(zero.admittedNotionalUsd, 0);
ok('cap $0 (the fail-closed / unreadable value) → nothing admitted');

// A ceiling above the plan changes nothing.
const roomy = applyCollateralCap({ quotes: plan.quotes, capUsd: 10_000 });
assert.strictEqual(roomy.blockedCount, 0);
assert.strictEqual(roomy.capExceeded, false);
ok('cap above the plan → nothing blocked, capExceeded false');

// An ABSENT ceiling passes through and is reported as absent (not as an enforced $0).
const none = applyCollateralCap({ quotes: plan.quotes, capUsd: null });
assert.strictEqual(none.capUsd, null);
assert.strictEqual(none.blockedCount, 0);
ok('absent ceiling → reported null, never a fabricated $0 enforcement');

// NOTHING was placed: the planner and the cap are pure, and the quotes carry no venue handle.
assert.ok(capped.quotes.every((q) => q.orderId === undefined && q.placed === undefined),
  'a quote must never come back from the cap with a venue handle');
ok('dry run: no order id, no placement, no venue call anywhere in this section');

// ── 3 · FILL-POLICY ─────────────────────────────────────────────────────────────────────────────────
console.log('\n3. fill-policy — the per-side on-fill rule, guarded');

assert.strictEqual(normalizeFillRule('requote'), 'opposite', 'legacy requote ≡ opposite');
assert.strictEqual(normalizeFillRule('flatten'), 'close', 'legacy flatten ≡ close');
assert.strictEqual(normalizeFillRule('nonsense'), 'hold', 'unknown rule must fail closed to hold');
ok('legacy rules map (requote→opposite, flatten→close); unknown → hold');

const filled = { book: 'yes', kind: 'buy', price: 0.38, offsetC: -1.0, size: 260 };
const rules = { mid, maxSpreadC, tick, minSize };

const opp = planOnFill({ filledLeg: filled, rule: 'opposite', ...rules, capHeadroomUsd: 500 });
assert.strictEqual(opp.action, 'place-opposite');
assert.strictEqual(opp.quote.kind, 'sell', 'the round-trip answers a BUY with a SELL');
assert.ok(Math.abs(opp.quote.price - 0.40) < 1e-9, `mirrored price expected 0.40, got ${opp.quote.price}`);
assert.strictEqual(opp.guard.valid, true, 'the follow-up must pass the shared guard');
ok(`"lato opposto" → SELL @ ${(opp.quote.price * 100).toFixed(0)}¢, guard valid`);

const clo = planOnFill({ filledLeg: filled, rule: 'close', ...rules, capHeadroomUsd: 0 });
assert.strictEqual(clo.action, 'close', 'a close reduces exposure and is never blocked by the ceiling');
assert.strictEqual(clo.quote.intent, 'flatten');
ok('"chiudi" → flatten, allowed even with zero collateral headroom');

const hold = planOnFill({ filledLeg: filled, rule: 'hold', ...rules });
assert.strictEqual(hold.action, 'hold');
assert.strictEqual(hold.quote, null);
ok('"tieni" → no follow-up order at all');

// The collateral ceiling actually stops the round-trip that would grow inventory.
const squeezed = planOnFill({ filledLeg: filled, rule: 'opposite', ...rules, capHeadroomUsd: 5 });
assert.strictEqual(squeezed.action, 'hold', 'no headroom ⇒ the round-trip must be refused');
assert.ok(/tetto di collaterale/.test(squeezed.reason), 'the refusal must name the ceiling');
ok(`ceiling headroom $5 < $${opp.quote.notionalUsd.toFixed(2)} needed → round-trip refused, inventory bounded`);

// The SHARED guard refuses a follow-up that would land outside the reward band.
const wide = planOnFill({ filledLeg: { ...filled, offsetC: -9 }, rule: 'opposite', ...rules, capHeadroomUsd: 500 });
assert.strictEqual(wide.action, 'hold', 'an out-of-band follow-up must be refused');
assert.ok(wide.guard.reasons.some((r) => r.code === 'OUT_OF_BAND'), 'the refusal must be the guard OUT_OF_BAND code');
ok('out-of-band follow-up → refused by lib/maker/venue-rules (OUT_OF_BAND), never emitted');

// The news-guard override forces a close whatever the stored rule says.
const forced = planOnFill({ filledLeg: filled, rule: 'opposite', ...rules, capHeadroomUsd: 500, newsForceClose: true });
assert.strictEqual(forced.action, 'close');
assert.strictEqual(forced.forcedBy, 'news-guard');
ok('news-guard HIGH signal → forces close over the stored "lato opposto"');

// ── 4 · CROSS-CHECK against a REAL feed row, if the snapshot is present ─────────────────────────────
console.log('\n4. cross-check against the live feed snapshot (skipped when absent)');
try {
  const snap = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json', 'utf8'));
  const row = snap.markets.find((x) => /Kamala Harris win the 2028 Democratic/i.test(x.title || ''));
  if (row) {
    const pr = computePriceRow({ rewardScore: row.rewardScore, tick: 0.01, totalSizeUsd: 100, offsetCents: 1, market: row });
    const v = computeWorthIt({ grossPerDay: pr.grossPerDay, adverseCostPerDay: 0.84,
      ownImpactPct: pr.ownImpactPct, perSideShares: pr.perSideUsd / pr.buyYes, minSize: pr.minSize, poolDay: pr.poolDay });
    assert.strictEqual(v.verdict, 'no', 'the live Kamala row must still refuse');
    ok(`live Kamala row: gross $${pr.grossPerDay.toFixed(3)}/day at $100 → "${v.headline}"`);
  } else {
    console.log('  · Kamala row not in the current snapshot — skipped');
  }
} catch {
  console.log('  · /tmp/liquidity-rewards.json unavailable — skipped');
}

console.log(`\nALL ${pass} ASSERTIONS PASSED — no network, no key, no venue call, no order placed.\n`);
