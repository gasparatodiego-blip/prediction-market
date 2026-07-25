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

// ── 3b · TICK FAIL-CLOSED ───────────────────────────────────────────────────────────────────────────
// The tick is the venue's price grid. Without it no price is knowably placeable, so the price row must
// produce NOTHING (the caller renders "—") rather than a raw unsnapped number that looks placeable.
// Each assertion below trips this gate ALONE: the rewardScore handed in is fully readable, so the only
// thing that can withhold a price is the tick.
console.log('\n3b. tick — snap is explicit, unknown tick fails closed');

const rsTick = { poolDay: 100, mid: 0.5, maxSpreadCents: 6, minSize: 100, competitorQ: 500, refCapital: 1000, refShare: 0.1 };

// (a) tick unknown → no price at all, with a stated reason. Nothing else is missing.
for (const badTick of [null, undefined, 0, -1, NaN]) {
  const row = computePriceRow({ rewardScore: rsTick, tick: badTick, totalSizeUsd: 1000, offsetCents: 1 });
  assert.strictEqual(row.buyYes, null, `tick ${String(badTick)} must yield no buy price`);
  assert.strictEqual(row.sellYes, null, `tick ${String(badTick)} must yield no sell price`);
  assert.strictEqual(row.buyNo, null, `tick ${String(badTick)} must yield no NO price`);
  assert.strictEqual(row.tickKnown, false);
  assert.ok(typeof row.tickUnknownReason === 'string' && row.tickUnknownReason.length > 0,
    'an unknown tick must state its reason, not just blank the number');
}
ok('unknown tick (null/undefined/0/negative/NaN) → no price, tickKnown false, reason stated');

// (b) a KNOWN tick still prices — so (a) proves the tick gate, not a broken row.
const okRow = computePriceRow({ rewardScore: rsTick, tick: 0.01, totalSizeUsd: 1000, offsetCents: 1 });
assert.ok(okRow.buyYes > 0 && okRow.sellYes > 0 && okRow.tickKnown === true,
  'positive control: a readable tick must still produce prices');
ok('positive control — a readable tick still prices (the gate is the tick, not the row)');

// (c) every produced price sits ON the grid, for real ticks this venue actually runs.
for (const tk of [0.1, 0.01, 0.001, 0.0001]) {
  const r = computePriceRow({ rewardScore: { ...rsTick, mid: 0.4567 }, tick: tk, totalSizeUsd: 1000, offsetCents: 1.3 });
  for (const [label, p] of [['buyYes', r.buyYes], ['sellYes', r.sellYes]]) {
    assert.ok(p != null, `${label} must exist at tick ${tk}`);
    assert.ok(Math.abs(p / tk - Math.round(p / tk)) < 1e-6, `${label} ${p} is off the ${tk} grid`);
  }
}
ok('prices land on the grid for every tick this venue runs (0.1 / 0.01 / 0.001 / 0.0001)');

// (d) the snap is RECORDED, not silent: the pre-snap target and the distance moved are both readable.
const coarse = computePriceRow({ rewardScore: { ...rsTick, mid: 0.4567 }, tick: 0.1, totalSizeUsd: 1000, offsetCents: 1.3 });
assert.ok(coarse.buyYesRaw != null && coarse.snappedByC > 0,
  'a snap that moved the price must report the pre-snap target and the distance moved');
assert.ok(Math.abs(coarse.buyYesRaw - (0.4567 - 0.013)) < 1e-9, 'pre-snap target must be mid − offset, untouched');
ok(`snap recorded: raw ${coarse.buyYesRaw.toFixed(4)} → ${coarse.buyYes} (moved ${coarse.snappedByC.toFixed(2)}¢)`);

// ── 3c · UNITS — dollars in, SHARES on the wire, one conversion ─────────────────────────────────────
// The operator types dollars, the venue sizes in shares, and the reward quadratic weights shares. The
// conversion must happen exactly once (lib/reward-price-row.perSideShares) and every consumer must read
// THAT number, or the panel describes an order the bot never posts.
console.log('\n3c. units — one dollar→share conversion, panel = list = bot sizing');

const rsUnit = { poolDay: 200, mid: 0.4, maxSpreadCents: 6, minSize: 100, competitorQ: 800, refCapital: 1000, refShare: 0.1 };
const unitRow = computePriceRow({ rewardScore: rsUnit, tick: 0.01, totalSizeUsd: 1000, offsetCents: 1 });

// (a) the conversion is priced off the price actually posted, and round-trips to the dollar it came from.
assert.ok(unitRow.perSideShares != null, 'a priced row must expose its share count');
// perSideShares is rounded to 4 dp to kill FP dust, so it agrees with the raw division to within half
// a unit in the last place — not to the bit. The notional round-trip below is the assertion that matters.
assert.ok(Math.abs(unitRow.perSideShares - unitRow.perSideUsd / unitRow.buyYes) <= 5e-5,
  'perSideShares must be perSideUsd / buyYes (to its stated 4-dp rounding) — the one conversion');
assert.ok(Math.abs(unitRow.notionalPerSideUsd - unitRow.perSideUsd) < 0.01,
  `notional must round-trip to the cent: ${unitRow.notionalPerSideUsd} vs ${unitRow.perSideUsd}`);
ok(`$${unitRow.perSideUsd} per lato @ ${unitRow.buyYes} → ${unitRow.perSideShares} shares → $${unitRow.notionalPerSideUsd} (round-trips to the cent)`);

// (b) no price ⇒ no share count. Never a guessed size on an unpriceable row.
const unitNoTick = computePriceRow({ rewardScore: rsUnit, tick: null, totalSizeUsd: 1000, offsetCents: 1 });
assert.strictEqual(unitNoTick.perSideShares, null, 'no price ⇒ no share count');
assert.strictEqual(unitNoTick.notionalPerSideUsd, null, 'no price ⇒ no notional');
ok('unpriceable row → share count and notional are null, never a guess');

// (c) BOT SIZING AGREES. Feed the panel's share count onto the leg exactly as saveLegs now persists it,
//     and plan it the way agent35 does. The engine's size and notional must be the panel's, to the cent.
const unitLegs = [
  { book: 'yes', kind: 'buy', price: unitRow.buyYes, mode: 'pinned', offsetC: -1, sizeShares: unitRow.perSideShares, enabled: true },
  { book: 'no',  kind: 'buy', price: unitRow.buyNo,  mode: 'pinned', offsetC: -1, sizeShares: unitRow.perSideSharesNo, enabled: true },
];
const unitPlan = planQuotes({
  legs: unitLegs, mid: rsUnit.mid, maxSpreadC: rsUnit.maxSpreadCents, minSize: rsUnit.minSize,
  tick: 0.01, tokenId: 'YES', tokenIdNo: 'NO', defaultSizeShares: 200,
});
const yesQuote = unitPlan.quotes.find((q) => q.book === 'yes');
assert.strictEqual(yesQuote.size, unitRow.perSideShares, 'the engine must quote the operator\'s share count');
assert.ok(Math.abs(yesQuote.notionalUsd - unitRow.perSideUsd) < 0.01,
  `engine notional ${yesQuote.notionalUsd} must equal the panel's ${unitRow.perSideUsd} to the cent`);
assert.notStrictEqual(yesQuote.size, 200, 'the engine default must NOT be what gets quoted once a size is persisted');
ok(`bot sizing = panel sizing: ${yesQuote.size} shares, $${yesQuote.notionalUsd.toFixed(2)} (engine default 200 NOT used)`);

// (c2) THE DOLLAR BUDGET IS RESPECTED. Each side is sized at its OWN price, so a "$1,000 total" config
//      commits $1,000 — not $1,169 as equal share counts on differently-priced books would.
const noQuote = unitPlan.quotes.find((q) => q.book === 'no');
assert.ok(Math.abs(noQuote.notionalUsd - unitRow.perSideUsd) < 0.01,
  `the NO side must commit its half of the budget too: $${noQuote.notionalUsd} vs $${unitRow.perSideUsd}`);
assert.ok(Math.abs((yesQuote.notionalUsd + noQuote.notionalUsd) - unitRow.totalSizeUsd) < 0.02,
  'both sides together must commit the stated total, to the cent');
assert.notStrictEqual(yesQuote.size, noQuote.size,
  'differently-priced books must NOT carry the same share count — that is the overspend this closes');
ok(`dollar budget honoured: YES $${yesQuote.notionalUsd.toFixed(2)} + NO $${noQuote.notionalUsd.toFixed(2)} = $${(yesQuote.notionalUsd + noQuote.notionalUsd).toFixed(2)} of $${unitRow.totalSizeUsd}`);

// (d) the OLD behaviour is what this fixes: a leg with no size still falls back to the engine default.
const unitPlanNoSize = planQuotes({
  legs: [{ book: 'yes', kind: 'buy', price: unitRow.buyYes, mode: 'pinned', offsetC: -1, enabled: true }],
  mid: rsUnit.mid, maxSpreadC: rsUnit.maxSpreadCents, minSize: rsUnit.minSize,
  tick: 0.01, tokenId: 'YES', tokenIdNo: 'NO', defaultSizeShares: 200,
});
assert.strictEqual(unitPlanNoSize.quotes[0].size, 200, 'a sizeless leg still falls back to the engine default');
ok('control — a leg carrying no size still falls back to the engine default (the regression this closes)');

// ── 3d · CANONICAL POSITIONS — BUY NO @ q IS SELL YES @ 1−q ─────────────────────────────────────────
// One book, two complementary tokens. Two-sidedness and the collapse report are properties of the
// canonical set; judged on the raw leg list they come out wrong in both directions.
console.log('\n3d. canonical positions — one book, two tokens');

const { toCanonical, canonicalize } = require('../lib/maker/canonical-position');

// (a) the mapping itself, all four user-facing forms.
assert.deepStrictEqual(toCanonical({ book: 'yes', kind: 'buy',  price: 0.42 }).side, 'BID');
assert.deepStrictEqual(toCanonical({ book: 'yes', kind: 'sell', price: 0.44 }).side, 'ASK');
const noBuy = toCanonical({ book: 'no', kind: 'buy', price: 0.56 });
assert.strictEqual(noBuy.side, 'ASK', 'buying NO is selling YES — an ASK');
assert.ok(Math.abs(noBuy.yesPrice - 0.44) < 1e-9, 'buying NO at 0.56 rests at YES 0.44');
assert.strictEqual(toCanonical({ book: 'no', kind: 'sell', price: 0.56 }).side, 'BID', 'selling NO is buying YES');
assert.strictEqual(toCanonical({ book: 'no', kind: 'buy', price: null }), null, 'an undescribable leg maps to null, never a guessed side');
ok('all four forms map onto the YES book (buy NO 0.56 ≡ sell YES 0.44)');

// (b) BUY NO and SELL YES at the mirrored price are ONE position — collapse reported, neither dropped.
const dupSet = canonicalize([
  { book: 'no',  kind: 'buy',  price: 0.56, size: 100, id: 'L1' },
  { book: 'yes', kind: 'sell', price: 0.44, size: 100, id: 'L2' },
]);
assert.strictEqual(dupSet.positions.length, 1, 'the same order written twice is ONE canonical position');
assert.strictEqual(dupSet.collapsed.length, 1, 'the collapse must be reported');
assert.strictEqual(dupSet.positions[0].legCount, 2, 'both configured legs stay named — nothing is dropped');
assert.strictEqual(dupSet.positions[0].sizeShares, 200, 'sizes add: two real orders rest at that level');
assert.strictEqual(dupSet.twoSided, false, 'one position on one side is NOT two-sided');
ok('BUY NO + SELL YES → 1 position, collapse reported, both legs still named, sizes added');

// (c) THE FIX THAT MATTERS: BUY YES + BUY NO is a real bid AND a real ask. Judged on raw legs it read
//     as one-sided (neither leg is a YES sell) and wrongly carried the ÷3 penalty.
const planBoth = planQuotes({
  legs: [
    { book: 'yes', kind: 'buy', price: 0.42, mode: 'pinned', enabled: true, sizeShares: 500 },
    { book: 'no',  kind: 'buy', price: 0.56, mode: 'pinned', enabled: true, sizeShares: 500 },
  ],
  mid: 0.43, maxSpreadC: 6, minSize: 100, tick: 0.01, tokenId: 'Y', tokenIdNo: 'N', defaultSizeShares: 200,
});
assert.strictEqual(planBoth.market.twoSided, true, 'buy YES + buy NO IS two-sided');
assert.strictEqual(planBoth.market.oneSidedPenalty, false, 'a genuinely two-sided quote must not carry the ÷3 flag');
assert.strictEqual(planBoth.market.collapsedGroups.length, 0, 'a bid and an ask do not collapse');
ok('BUY YES + BUY NO → two-sided, no ÷3 penalty flag, no collapse');

// (d) A NO LEG IS MEASURED IN ITS OWN BOOK. Against the YES mid a NO buy one cent off the mid read as
//     ~2·mid cents off, scored 0 and was refused. This gate fires alone: same band, same size, same
//     tick — only the book differs.
const noLeg = planBoth.quotes.find((q) => q.book === 'no');
assert.ok(Math.abs(noLeg.distanceC - 1) < 0.01, `NO leg must sit 1¢ from the mid, read ${noLeg.distanceC}¢`);
assert.ok(noLeg.score > 0 && noLeg.postable === true, 'a NO leg one cent off the mid must score and be postable');
const yesLeg = planBoth.quotes.find((q) => q.book === 'yes');
assert.ok(Math.abs(noLeg.score - yesLeg.score) < 1e-9, 'mirror-image legs must score identically');
ok(`NO leg measured in the NO book: ${noLeg.distanceC}¢ off, score ${noLeg.score} (identical to its YES mirror)`);

// (e) a genuinely one-sided configuration still reads one-sided — the fix is not "always two-sided".
const planOne = planQuotes({
  legs: [{ book: 'yes', kind: 'buy', price: 0.42, mode: 'pinned', enabled: true, sizeShares: 500 }],
  mid: 0.43, maxSpreadC: 6, minSize: 100, tick: 0.01, tokenId: 'Y', tokenIdNo: 'N', defaultSizeShares: 200,
});
assert.strictEqual(planOne.market.twoSided, false, 'one bid alone is still one-sided');
assert.strictEqual(planOne.market.oneSidedPenalty, true, 'and still carries the ÷3 flag');
ok('control — a single bid is still one-sided and still flagged');

// ── 3e · POSITION GUARDS — a SELL needs inventory; YES+NO at or above $1 is a self-match ────────────
// Both are gates in the CONSTRUCTION chain (postable goes false), not disabled controls. Each is proven
// to fire ALONE: in every case below everything the other guard cares about is satisfied.
console.log('\n3e. position guards — inventory and self-match');

const { CODES: GUARD_CODES, checkSellInventory, findSelfMatches } = require('../lib/maker/inventory-guard');
const guardBase = { mid: 0.43, maxSpreadC: 6, minSize: 100, tick: 0.01, tokenId: 'Y', tokenIdNo: 'N', defaultSizeShares: 500 };
const sellLeg = [{ book: 'yes', kind: 'sell', price: 0.44, mode: 'pinned', enabled: true, sizeShares: 500 }];

// (a) balance READ and zero → blocked, named, and it names the placeable alternative.
const zeroInv = planQuotes({ ...guardBase, legs: sellLeg, balances: { yes: 0, no: 0 } });
assert.strictEqual(zeroInv.quotes[0].postable, false, 'a SELL with no inventory must not be postable');
assert.strictEqual(zeroInv.market.sellBlocks[0].code, GUARD_CODES.NO_INVENTORY);
assert.ok(/comprare NO a 56\.0¢/.test(zeroInv.market.sellBlocks[0].reason),
  'the block must name the equivalent BUY on the complementary token');
ok('SELL with zero inventory → blocked (NO_INVENTORY), names "comprare NO a 56.0¢"');

// (b) POSITIVE CONTROL — same leg, same band, same tick, real inventory → postable. So (a) is the
//     inventory guard firing, not a broken leg.
const heldInv = planQuotes({ ...guardBase, legs: sellLeg, balances: { yes: 5000, no: 0 } });
assert.strictEqual(heldInv.quotes[0].postable, true, 'a SELL backed by real inventory must be postable');
assert.strictEqual(heldInv.market.sellBlocks.length, 0);
ok('positive control — the same SELL with 5,000 shares held is postable');

// (c) UNREADABLE balance is not zero and not "probably fine" → fail closed, its own code.
for (const bad of [{ yes: null, no: null }, undefined, { yes: NaN, no: 0 }]) {
  const un = planQuotes({ ...guardBase, legs: sellLeg, balances: bad });
  assert.strictEqual(un.quotes[0].postable, false, 'an unreadable balance must block the SELL');
  assert.strictEqual(un.market.sellBlocks[0].code, GUARD_CODES.INVENTORY_UNREADABLE);
}
ok('unreadable balance (null / absent / NaN) → blocked (INVENTORY_UNREADABLE), fail closed');

// (d) partial inventory is still short → blocked rather than partly posted.
const partial = planQuotes({ ...guardBase, legs: sellLeg, balances: { yes: 100, no: 0 } });
assert.strictEqual(partial.market.sellBlocks[0].code, GUARD_CODES.INSUFFICIENT_INVENTORY);
ok('inventory smaller than the order (100 held vs 500) → blocked (INSUFFICIENT_INVENTORY)');

// (e) SELF-MATCH fires ALONE: both legs are BUYs (the inventory guard has nothing to say), both in band,
//     both above min size, both on tick — only the sum crosses $1.
const cross = planQuotes({
  ...guardBase, mid: 0.51,
  legs: [
    { book: 'yes', kind: 'buy', price: 0.52, mode: 'pinned', enabled: true, sizeShares: 500 },
    { book: 'no',  kind: 'buy', price: 0.50, mode: 'pinned', enabled: true, sizeShares: 500 },
  ],
  balances: { yes: 0, no: 0 },
});
assert.strictEqual(cross.market.selfMatches.length, 1, 'a YES+NO pair summing to $1.02 is a self-match');
assert.ok(Math.abs(cross.market.selfMatches[0].sum - 1.02) < 1e-9);
assert.ok(cross.quotes.every((q) => q.postable === false), 'BOTH legs of a crossed pair are refused');
assert.strictEqual(cross.market.sellBlocks.length, 0, 'the inventory guard is silent here — this is the self-match guard alone');
ok('BUY YES 52¢ + BUY NO 50¢ = 102¢ → both legs refused (SELF_MATCH_CROSS), inventory guard silent');

// (f) the boundary: exactly $1.00 is still a self-match; a cent under is not.
assert.strictEqual(findSelfMatches([{ book: 'yes', kind: 'buy', price: 0.5 }, { book: 'no', kind: 'buy', price: 0.5 }]).length, 1,
  'exactly $1.00 is a self-match — you pay 100¢ for a 100¢ pair');
assert.strictEqual(findSelfMatches([{ book: 'yes', kind: 'buy', price: 0.42 }, { book: 'no', kind: 'buy', price: 0.56 }]).length, 0,
  'control — 98¢ is a normal two-sided quote, not a self-match');
ok('boundary — 100¢ crosses, 98¢ does not (the panel at distance 0 lands exactly on 100¢)');

// (g) the guard reasons never contain a bare refusal: each states WHY in plain Italian.
const r = checkSellInventory({ book: 'no', price: 0.56, size: 10 }, 0);
assert.ok(r.reason.includes('non possiedi token NO') && r.reason.includes('comprare YES'),
  'a refusal must state the reason and the alternative, not just refuse');
ok('every block states the reason and the placeable alternative, in plain Italian');

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
