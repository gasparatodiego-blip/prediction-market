#!/usr/bin/env node
'use strict';
// scripts/rewards-realistic-estimate-selfcheck.js — proof that the SECOND $/day figure is honest.
//
//   node scripts/rewards-realistic-estimate-selfcheck.js
//
// Pure assertions. No network, no venue, no key, no order. The pool-trend archive is read from a TEMP
// fixture directory, never from data/history/rewards-poly.
//
// WHAT IT PROVES:
//   1. the corrected figure NEVER exceeds the gross, and is a strict function of declared corrections;
//   2. the placement-score correction is the published quadratic — checked against hand-computed values;
//   3. an EMPTY book (no competing liquidity) is WITHHELD, not shaded down: showing "$67/day for $2" with
//      a discount would still be showing a number the model cannot support;
//   4. a falling pot discounts, a RISING pot does NOT inflate, and an unmeasurable trend applies exactly
//      1.0 while reporting measurable:false;
//   5. adverse selection uses the MEASURED markout where fills exist and a LABELLED assumption where they
//      do not — and the label travels with the number;
//   6. the coverage correction is built on the venue's real once-a-minute sampling, and stays small;
//   7. band exits are MEASURED from real mid samples, and an unmeasurable market gets a stated assumption
//      rather than a free pass (zero exits);
//   8. every correction reports its own factor, kind and note — there is no unnamed fudge anywhere;
//   9. totals exclude withheld rows and COUNT them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RE = require('../lib/rewards/realistic-estimate');
const PT = require('../lib/rewards/pool-trend');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) < eps;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'realistic-'));

// The Michigan row from the real 2026-07-31 allocation, used as the worked example throughout.
const MICH = {
  grossPerDay: 51.20, pot: 400, competitorQ: 4297, mid: 0.065, capitalUsd: 82,
  maxSpreadCents: 4.5, midRows: null, observedFills: 0, measuredCostPerDay: null,
};

// ── 1 · THE PUBLISHED QUADRATIC, CHECKED BY HAND ────────────────────────────────────────────────────
console.log('\n1. the placement score IS the published quadratic S(v,s) = ((v−s)/v)²');
{
  // Band 4.5¢ ⇒ v = 2.25¢.
  ok(near(RE.placementScore(0, 4.5), 1), 'at the mid (s=0) the score is 1 — the ceiling the gross figure assumes');
  ok(near(RE.placementScore(2.25, 4.5), 0), 'at the band edge (s=v) the score is 0 — an order there earns nothing');
  ok(near(RE.placementScore(1, 4.5), ((2.25 - 1) / 2.25) ** 2, 1e-9),
    `one tick off a 4.5¢ band scores ${RE.placementScore(1, 4.5).toFixed(4)} — about 31% of the ceiling, not 100%`);
  ok(near(RE.placementScore(1.125, 4.5), 0.25), 'a quarter of the band off the mid scores exactly 0.25, matching lib/rewardScore\'s "typical" placement');
  ok(RE.placementScore(3, 4.5) === 0, 'beyond the band the score is 0, never negative and never extrapolated');
  ok(RE.placementScore(1, null) === null && RE.placementScore(null, 4.5) === null,
    'an unreadable band or offset returns null — the caller then applies NO correction and says so, rather than assuming 1.0');
}

// ── 2 · THE CORRECTION NEVER INFLATES, AND NAMES ITSELF ─────────────────────────────────────────────
console.log('\n2. the corrected figure is bounded by the gross and every correction is named');
{
  const est = RE.realisticEstimate({ ...MICH, offsetCents: 1 });
  ok(est.realisticPerDay <= est.grossPerDay + 1e-9,
    `corrected $${est.realisticPerDay.toFixed(2)}/g ≤ gross $${est.grossPerDay.toFixed(2)}/g — a "realistic" figure above the theoretical one would be a bug, not a correction`);
  const keys = est.corrections.map((c) => c.key);
  for (const k of ['placement-score', 'pool-trend', 'thin-book', 'coverage-gap', 'adverse-selection'])
    ok(keys.includes(k), `correction "${k}" is present and reported`);
  ok(est.corrections.every((c) => typeof c.note === 'string' && c.note.length > 20 && typeof c.factor === 'number'),
    'every correction carries a factor AND a plain-language note — there is no unnamed multiplier anywhere');
  ok(est.corrections.every((c) => ['derivata', 'misurata', 'assunzione'].includes(c.kind)),
    'every correction declares whether it is derived arithmetic, a measurement, or an assumption');
  const ps = est.corrections.find((c) => c.key === 'placement-score');
  ok(ps.kind === 'derivata' && ps.applied === true,
    'the placement-score correction is DERIVED (algebra on the venue\'s own formula), not a guessed haircut');
}

// ── 3 · THE $67-FOR-$2 CASE IS WITHHELD, NOT SHADED ────────────────────────────────────────────────
console.log('\n3. an empty book is WITHHELD — the case that produced "$67/day on $2 of capital"');
{
  const empty = RE.realisticEstimate({
    grossPerDay: 67, pot: 67, competitorQ: 0, mid: 0.855, capitalUsd: 2,
    offsetCents: 1, maxSpreadCents: 5.5, observedFills: 0,
  });
  ok(empty.unknown === true && empty.realisticPerDay === null,
    'with ZERO competing liquidity in band the corrected figure is WITHHELD (null), not discounted to a smaller but equally unsupported number');
  ok(empty.grossPerDay === 67,
    '…while the GROSS figure is untouched and still returned — the second figure never rewrites the first');
  ok(/fuori dal suo dominio|non esiste/.test(empty.reason),
    '…and the reason says plainly that the share formula was evaluated outside its domain');
  ok(empty.flags.some((f) => f.key === 'empty-book' && f.severity === 'danger'),
    '…with a danger flag, so the row cannot be skimmed past');

  // A THIN but non-empty book is shaded, not withheld — the two cases are genuinely different.
  const thin = RE.realisticEstimate({
    grossPerDay: 50, pot: 50, competitorQ: 5, mid: 0.5, capitalUsd: 100,
    offsetCents: 1, maxSpreadCents: 4.5, observedFills: 0,
  });
  const tb = thin.corrections.find((c) => c.key === 'thin-book');
  ok(thin.unknown === false && tb.applied === true && tb.factor < 1,
    `a thin-but-real book (5 competing shares) is SHADED (×${tb.factor}) rather than withheld — "few others" and "nobody at all" are different facts`);
  ok(thin.flags.some((f) => f.key === 'thin-book'), '…and still flagged, so the thinness is visible on the row');
}

// ── 4 · THE POOL TREND DISCOUNTS BUT NEVER INFLATES ────────────────────────────────────────────────
console.log('\n4. pool trend — discount on a cut, no credit for a rise, 1.0 when unmeasurable');
{
  const dir = path.join(TMP, 'pots');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-07-31T12:00:00Z');
  const mk = (hoursAgo, pool, id) => ({ t: now - hoursAgo * 3_600_000, rows: [{ id, dailyPool: pool }] });
  // FALLING: eight readings at $200 then a cut to $100.
  const falling = [...Array(8)].map((_, i) => mk(40 - i * 4, 200, '0xfall')).concat([mk(1, 100, '0xfall')]);
  // RISING: eight at $100 then a jump to $300.
  const rising = [...Array(8)].map((_, i) => mk(40 - i * 4, 100, '0xrise')).concat([mk(1, 300, '0xrise')]);
  // TOO FEW: two readings only.
  const sparse = [mk(10, 100, '0xsparse'), mk(2, 100, '0xsparse')];
  fs.writeFileSync(path.join(dir, '2026-07-30.json'), JSON.stringify(falling.concat(rising).concat(sparse)));
  fs.writeFileSync(path.join(dir, '2026-07-31.json'), JSON.stringify([]));

  const h = PT.loadPoolHistory(now, { dir });
  ok(h.readable === true, 'the archive is read from the temp fixture, never from the real data/history directory');

  const down = PT.poolTrendFor(h, '0xfall', 100);
  ok(down.measurable === true && down.direction === 'down' && down.discountFactor < 1,
    `a pot cut from $200 to $100 is measured as falling and discounts the estimate (×${down.discountFactor})`);

  const up = PT.poolTrendFor(h, '0xrise', 300);
  ok(up.measurable === true && up.direction === 'up' && up.discountFactor === 1,
    'a pot that ROSE is reported as up but applies ×1 — a recent rise is not banked, because it is not a promise');

  const few = PT.poolTrendFor(h, '0xsparse', 100);
  ok(few.measurable === false && few.discountFactor === 1 && /rilevazioni/.test(few.note),
    'two readings are not a trend: measurable:false, ×1 applied, and the note SAYS it was not measured');

  const missing = PT.poolTrendFor(h, '0xnothere', 50);
  ok(missing.measurable === false && missing.discountFactor === 1,
    'a market with no archived pot history applies no correction — never a silent default');

  // …and it flows through to the estimate.
  const withCut = RE.realisticEstimate({ ...MICH, offsetCents: 1, poolTrend: down });
  const noTrend = RE.realisticEstimate({ ...MICH, offsetCents: 1, poolTrend: null });
  ok(withCut.realisticPerDay < noTrend.realisticPerDay,
    'a market whose pot was cut estimates strictly lower than the same market with no trend data');
  ok(noTrend.corrections.find((c) => c.key === 'pool-trend').measurable === false,
    '…and the no-data case reports measurable:false rather than pretending the pot is stable');
}

// ── 5 · ADVERSE SELECTION: MEASURED WHERE POSSIBLE, LABELLED WHERE NOT ─────────────────────────────
console.log('\n5. adverse selection — a measurement beats a guess, and the guess admits it is one');
{
  const measured = RE.realisticEstimate({ ...MICH, offsetCents: 1, observedFills: 9, measuredCostPerDay: 18.16 });
  const m = measured.corrections.find((c) => c.key === 'adverse-selection');
  ok(m.kind === 'misurata' && near(m.usd, 18.16, 0.01),
    'where the tape produced real fills, the MEASURED 5-minute markout is subtracted ($18.16/g), not a percentage');
  ok(/MISURATO|misurat/i.test(m.note) && /non è una stima|Questo è un dato/.test(m.note),
    '…and the note says explicitly that this one is a measurement');

  const guessed = RE.realisticEstimate({ ...MICH, offsetCents: 1, observedFills: 0, measuredCostPerDay: null });
  const g = guessed.corrections.find((c) => c.key === 'adverse-selection');
  ok(g.kind === 'assunzione' && g.measurable === false,
    'with no observed fills the correction is an ASSUMPTION and is labelled as one');
  ok(/NON è un valore preciso|ordine di grandezza/.test(g.note),
    '…and its note states in plain language that it is an order of magnitude, not a precise value');

  const custom = RE.realisticEstimate({ ...MICH, offsetCents: 1, observedFills: 0, config: { adverseSelectionPct: 40 } });
  const c40 = custom.corrections.find((c) => c.key === 'adverse-selection');
  ok(c40.usd > g.usd && /40%/.test(c40.note),
    'the assumed percentage is configurable and the configured value appears in the note the operator reads');
}

// ── 6 · COVERAGE IS BUILT ON THE VENUE'S REAL SAMPLING CADENCE ─────────────────────────────────────
console.log('\n6. coverage gaps — priced against the venue\'s once-a-minute sampling');
{
  ok(RE.SAMPLES_PER_DAY === 1440,
    'the model uses 1,440 samples/day — Polymarket scores maker liquidity from ONE random sample per minute (docs.polymarket.com/market-makers/liquidity-rewards)');
  const est = RE.realisticEstimate({ ...MICH, offsetCents: 1, refreshesPerDay: 96 });
  const cov = est.corrections.find((c) => c.key === 'coverage-gap');
  ok(cov.factor > 0.98 && cov.factor < 1,
    `even with 96 proactive refreshes/day the coverage cost is ×${cov.factor} — a few seconds out of book, against per-minute sampling, is genuinely small, and the honest answer is to say so rather than inflate it`);
  ok(/1440|1\.440/.test(cov.note) && /minuto/.test(cov.note),
    '…and the note shows the sampling arithmetic instead of asserting a penalty');
}

// ── 7 · BAND EXITS ARE MEASURED FROM REAL MID SAMPLES ──────────────────────────────────────────────
console.log('\n7. time in band — measured from the mid samples, assumed only when unmeasurable');
{
  // A mid that oscillates ±0.5¢ can never push an order out of a ±2.25¢ band at 1¢ offset (tolerance 1.25¢).
  const calm = [...Array(200)].map((_, i) => ({ tsMs: i * 60_000, adjMid: 0.5 + 0.005 * Math.sin(i / 5) }));
  const calmExit = RE.bandExitRate(calm, 4.5, 1);
  ok(calmExit.measurable === true && calmExit.exits === 0,
    'a calm mid produces ZERO measured band exits over 200 samples — the order would simply rest');

  // A mid that walks 5¢ repeatedly must exit.
  const wild = [...Array(200)].map((_, i) => ({ tsMs: i * 60_000, adjMid: 0.5 + 0.05 * Math.sin(i / 3) }));
  const wildExit = RE.bandExitRate(wild, 4.5, 1);
  ok(wildExit.measurable === true && wildExit.exits > 10,
    `a mid swinging ±5¢ produces ${wildExit.exits} measured exits — the tolerance is ${wildExit.toleranceCents}¢ and it is breached repeatedly`);
  ok(wildExit.exitsPerDay > calmExit.exitsPerDay,
    '…so a volatile market is charged more coverage than a calm one, from measurement rather than a volatility knob');

  const none = RE.bandExitRate([], 4.5, 1);
  ok(none.measurable === false, 'no samples ⇒ measurable:false');
  const est = RE.realisticEstimate({ ...MICH, offsetCents: 1, midRows: [] });
  const cov = est.corrections.find((c) => c.key === 'coverage-gap');
  ok(cov.kind === 'assunzione' && /si assumono/.test(cov.note),
    '…and the estimate then applies a STATED assumption rather than the optimistic zero');

  // An order sitting AT the band edge has no tolerance left at all — report that, do not divide by zero.
  const edge = RE.bandExitRate(calm, 4.5, 2.25);
  ok(edge.measurable === false && edge.toleranceCents <= 0,
    'an order at the band edge has zero tolerance — reported honestly instead of producing an infinite exit rate');
}

// ── 8 · THE WORKED EXAMPLE, END TO END ─────────────────────────────────────────────────────────────
console.log('\n8. the worked example — Michigan / Perry Johnson, the row that showed $35/side');
{
  // The gross, recomputed here from the documented formula to prove the module is correcting the RIGHT number.
  const price = 0.065, capital = 82, competitorQ = 4297, pot = 400;
  const size = (capital / 2) / price;
  const shareCeiling = size / (size + competitorQ);
  const gross = pot * shareCeiling;
  ok(near(gross, 51.2, 1.5),
    `the documented formula reproduces the displayed gross: size ${size.toFixed(0)} shares → share ${(shareCeiling * 100).toFixed(2)}% → $${gross.toFixed(2)}/g`);

  const at1 = RE.realisticEstimate({ ...MICH, grossPerDay: gross, offsetCents: 1, observedFills: 0 });
  const at2 = RE.realisticEstimate({ ...MICH, grossPerDay: gross, offsetCents: 2, observedFills: 0 });
  ok(at1.realisticPerDay > at2.realisticPerDay,
    `resting 1¢ off the mid estimates $${at1.realisticPerDay.toFixed(2)}/g against $${at2.realisticPerDay.toFixed(2)}/g at 2¢ — the corrected figure FALLS as the quote widens, which the flat S=1 gross cannot express`);
  ok(at1.realisticPerDay < gross * 0.5,
    `…and both are far below the $${gross.toFixed(2)}/g headline: the theoretical number prices an order sitting exactly on the mid, all day, with no adverse selection`);
}

// ── 9 · TOTALS EXCLUDE WITHHELD ROWS AND COUNT THEM ────────────────────────────────────────────────
console.log('\n9. the total is honest about what it covers');
{
  const t = RE.totalRealistic([
    { grossPerDay: 50, realisticPerDay: 12, unknown: false },
    { grossPerDay: 20, realisticPerDay: 6, unknown: false },
    { grossPerDay: 67, realisticPerDay: null, unknown: true },
  ]);
  ok(t.realisticPerDay === 18 && t.rowsCounted === 2 && t.rowsUnknown === 1,
    'a withheld row is EXCLUDED from the realistic total and COUNTED (2 counted, 1 unknown) — never silently added as zero, never added at its gross');
  // The ratio is rounded to 4 decimals for transport, so compare at that precision — not tighter.
  ok(near(t.ratio, 18 / 70, 1e-4),
    `…and the ratio (${t.ratio}) is computed over the SAME rows on both sides — 18/70, excluding the withheld row from the numerator AND the denominator, so it is a like-for-like comparison`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nrewards realistic-estimate selfcheck: ${checks} assertions passed.`);
console.log('The gross figure is never modified. The second figure applies five NAMED corrections, each');
console.log('reporting its own factor, its kind (calcolo / misurato / assunzione) and a plain-language note,');
console.log('and WITHHOLDS entirely where the share formula would divide by a book that does not exist.');
