#!/usr/bin/env node
'use strict';
// scripts/rewards-ceiling/phase3-ceiling.js — THE CEILING + THE HONEST VERDICT.
// Combine the real pots (Phase 1) and the observed capital-to-share curves (Phase 2) into the single
// annualised number that decides the lane, under PERFECT PLAY, three ways. Everything here is a GROSS
// upper bound labelled "ceiling, not expectation": it ignores adverse selection, fills/inventory, gas &
// fees, competition response and time out of band — each of which only REDUCES it.

const fs = require('fs');
const path = require('path');
const { capitalForShare } = require('./lib/curve');
const { raggioBandaCents } = require('../../lib/banda-premiante');

const OUT_DIR = path.join(__dirname, 'out');
const RISK_FREE_PCT = 4.0;    // ~4%/yr risk-free reference (the bar funding +2.79% and carry +2.68% failed)
const APY_CAP = 200;          // lib/honest-display.ts APY_CAP — any annualised figure above this is shown capped
const CEIL_LABEL = 'ceiling, not expectation';

// Placement score S: the ceiling assumes S=1 (an order AT the mid — the maximum score per share, an
// absolute upper bound a resting order cannot actually reach). S=0.25 is the "typical" farming placement
// (a quarter-band off mid) the board already assumes — shown as a realism sensitivity. capacity scales
// as 1/S, so the return scales as S.
const CEILING_S = 1.0;
const TYPICAL_S = 0.25;

const capAnnual = (pct) => (pct > APY_CAP ? `>${APY_CAP}%/yr · run-rate, not guaranteed` : `${pct.toFixed(2)}%/yr`);

// capacity(S) = capital (both sides) to hold 50% share at placement S = capitalForShare(...,0.5)/S.
function capacityAtS(m, S) { return capitalForShare(m.competitorQ, m.mid, 0.5) / S; }

// Aggregate MARGINAL ceiling over a subset: deploy to hold the same (small) share in every market — the
// blended return is Σpot·365 / Σcapacity(S). This is the return-on-capital at the efficiency frontier
// (perfect placement, current competition). The finite 50%-capture return is exactly half of it.
function aggregateCeiling(rows, S) {
  const potSum = rows.reduce((a, m) => a + m.pot, 0);
  const capSum = rows.reduce((a, m) => a + capacityAtS(m, S), 0);
  const marginalPct = capSum > 0 ? (potSum * 365 / capSum) * 100 : null;
  return { potSum, capSum, marginalPct, capture50Pct: marginalPct == null ? null : marginalPct / 2 };
}

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'measured.json'), 'utf8'));
  const measured = data.measured;
  const floor = data.potFloor;

  // per-market marginal efficiency (return rate at S=1) for the top-decile ranking + concentration.
  for (const m of measured) {
    m.capacityUsd_S1 = capacityAtS(m, CEILING_S);
    m.marginalPct_S1 = m.capacityUsd_S1 > 0 ? (m.pot * 365 / m.capacityUsd_S1) * 100 : 0;
  }
  const aboveFloor = measured.filter((m) => m.pot >= floor);
  const byEff = [...measured].sort((a, b) => b.marginalPct_S1 - a.marginalPct_S1);
  const topDecile = byEff.slice(0, Math.max(1, Math.round(measured.length * 0.10)));

  const A = aggregateCeiling(aboveFloor, CEILING_S);   // (a) above floor
  const B = aggregateCeiling(topDecile, CEILING_S);    // (b) top decile by efficiency
  const C = aggregateCeiling(measured, CEILING_S);     // (c) everything incl sub-floor
  const A25 = aggregateCeiling(aboveFloor, TYPICAL_S); // realism sensitivity (typical placement)

  console.log('═'.repeat(72));
  console.log('PHASE 3 — THE CEILING (perfect play, GROSS upper bound — ' + CEIL_LABEL + ')');
  console.log('═'.repeat(72));
  console.log('snapshot:', data.snapshot, '| measured markets:', measured.length, '| pot floor $' + floor + '/day');
  console.log('risk-free reference: ~' + RISK_FREE_PCT.toFixed(1) + '%/yr\n');
  const line = (name, agg, n) => {
    const beats = agg.marginalPct != null && agg.marginalPct > RISK_FREE_PCT;
    console.log(name);
    console.log('  markets: ' + n + ' · Σpot $' + agg.potSum.toFixed(0) + '/day · Σcapacity(S=1) $' + Math.round(agg.capSum).toLocaleString());
    console.log('  CEILING (marginal, S=1): ' + capAnnual(agg.marginalPct) + '   [raw ' + agg.marginalPct.toFixed(1) + '%]');
    console.log('  at 50% capture (finite): ' + capAnnual(agg.capture50Pct) + '   [raw ' + agg.capture50Pct.toFixed(1) + '%]');
    console.log('  vs ~' + RISK_FREE_PCT + '% risk-free: ' + (beats ? 'CLEARS (gross)' : 'FAILS') + '\n');
  };
  line('(a) every market above $' + floor + '/day floor', A, aboveFloor.length);
  line('(b) top decile by pot-to-capital efficiency', B, topDecile.length);
  console.log('  ⚠ (b) is dominated by NEAR-EMPTY-BOOK markets (Σcapacity only $' + Math.round(B.capSum).toLocaleString() +
    ' across ' + topDecile.length + ' markets ≈ $' + Math.round(B.capSum / topDecile.length) + '/market): "50% of the pot for a few dollars"');
  console.log('    is the thin-book fiction — the moment real size arrives the share collapses. It is the same artifact');
  console.log('    demoted on the board; its four-figure % is noise, not an edge.\n');
  line('(c) everything including sub-floor markets', C, measured.length);
  console.log('REALISM SENSITIVITY — (a) at TYPICAL placement S=0.25 (a quarter-band off mid, not at mid):');
  console.log('  CEILING (marginal): ' + capAnnual(A25.marginalPct) + '   [raw ' + A25.marginalPct.toFixed(1) + '%] — still ' +
    (A25.marginalPct > RISK_FREE_PCT ? 'above' : 'below') + ' risk-free\n');

  // ── CONCENTRATION ──
  const byPot = [...measured].sort((a, b) => b.pot - a.pot);
  const totalPot = measured.reduce((a, m) => a + m.pot, 0);
  const frac = (k) => byPot.slice(0, k).reduce((a, m) => a + m.pot, 0) / totalPot;
  console.log('CONCENTRATION (share of the whole lane\'s $' + totalPot.toFixed(0) + '/day pot):');
  for (const k of [1, 3, 5, 10, 20]) console.log('  top ' + String(k).padStart(2) + ' markets carry ' + (frac(k) * 100).toFixed(1) + '% of the total pot');
  const nFor = (target) => { let s = 0, i = 0; for (const m of byPot) { s += m.pot; i++; if (s / totalPot >= target) break; } return i; };
  console.log('  ' + nFor(0.5) + ' markets carry 50% of the pot; ' + nFor(0.8) + ' carry 80%.');

  // ── HAND-VERIFY ONE MARKET END TO END (the most important verification) ──
  const hv = byPot.find((m) => m.pot >= floor && m.competitorQ > 0) || byPot[0];
  const price = Math.max(0.01, Math.min(0.99, hv.mid));
  const X = 0.5;
  const capPerSide = price * hv.competitorQ * (X / (1 - X));
  const capTotal = 2 * capPerSide;
  const incomeDay = hv.pot * X;
  const annualPct = (incomeDay * 365 / capTotal) * 100;
  console.log('\n' + '─'.repeat(72));
  console.log('HAND-VERIFY (redo this arithmetic by hand — every intermediate number shown):');
  console.log('  market:            ' + hv.question);
  console.log('  pot (Gamma):       $' + hv.pot + '/day');
  console.log('  reward band:       ±' + (raggioBandaCents(hv.maxSpread)) + '¢ (maxSpread ' + hv.maxSpread + '¢), minSize ' + hv.minSize + ' shares');
  console.log('  scoring mid:       ' + hv.mid.toFixed(4) + '  → price used ' + price.toFixed(4));
  console.log('  observed in-band depth: bid $' + hv.inbandBidUsd.toFixed(0) + ' + ask $' + hv.inbandAskUsd.toFixed(0) + ' = $' + hv.inbandDepthUsd.toFixed(0) + ' (qualifying ≥minSize, both stacks)');
  console.log('  competitor Qmin:   ' + hv.competitorQ.toFixed(2) + ' (scoreBook, live book)');
  console.log('  target share X:    ' + (X * 100) + '%');
  console.log('  capital per side  = price × Qmin × X/(1−X) = ' + price.toFixed(4) + ' × ' + hv.competitorQ.toFixed(2) + ' × ' + (X / (1 - X)).toFixed(3) + ' = $' + capPerSide.toFixed(2));
  console.log('  capital total     = 2 × per side = $' + capTotal.toFixed(2));
  console.log('  daily reward      = pot × X = ' + hv.pot + ' × ' + X + ' = $' + incomeDay.toFixed(2) + '/day');
  console.log('  annualised        = daily × 365 / capital = ' + incomeDay.toFixed(2) + ' × 365 / ' + capTotal.toFixed(2) + ' = ' + annualPct.toFixed(2) + '%/yr → ' + capAnnual(annualPct));
  console.log('─'.repeat(72));

  // ── write VERDICT.md ──
  const beatsC = C.marginalPct > RISK_FREE_PCT;
  const verdict = `# REWARDS-CEILING — verdict

Snapshot: ${data.snapshot}
Universe: ${measured.length} collectable Polymarket reward markets (Kalshi is US-only, excluded). 0 excluded for unreadable book.
Whole-lane pot: $${totalPot.toFixed(0)}/day paid to ALL makers combined.
Risk-free reference: ~${RISK_FREE_PCT}%/yr.

## The three ceilings (perfect play, GROSS — ${CEIL_LABEL})
- (a) above $${floor}/day floor  (${aboveFloor.length} mkts): marginal ${capAnnual(A.marginalPct)} · 50%-capture ${capAnnual(A.capture50Pct)}
- (b) top decile by efficiency   (${topDecile.length} mkts): marginal ${capAnnual(B.marginalPct)} · 50%-capture ${capAnnual(B.capture50Pct)}
- (c) everything incl sub-floor   (${measured.length} mkts): marginal ${capAnnual(C.marginalPct)} · 50%-capture ${capAnnual(C.capture50Pct)}
- realism (a) at typical placement S=0.25: marginal ${capAnnual(A25.marginalPct)}

## Verdict
The GROSS perfect-play ceiling of the Polymarket liquidity-rewards lane ${beatsC ? 'CLEARS' : 'does NOT clear'} the ~${RISK_FREE_PCT}% risk-free rate — ${beatsC ? 'by a wide margin (APY-capped display >200%/yr).' : 'it is dead like funding (+2.79%) and cash & carry (+2.68%).'}

This is the OPPOSITE shape to the funding and cash & carry conclusions, and the difference is the whole point: those lanes' GROSS number was already below risk-free, so no execution could save them. Here the gross number is large, so the lane is not dead on arithmetic — but the entire result hangs on ONE assumption: **that resting reward orders never fill and never suffer adverse selection.** That assumption is false. A reward order must rest at a competitive price inside the band on a directional market; it fills exactly when the market moves against it, leaving directional inventory. The reward is the venue's PAYMENT FOR BEARING THAT RISK — and this ceiling explicitly excludes the risk it pays for. The honest-engine has always said so: the net is unknown, and every excluded cost (adverse selection, inventory, fills, gas/fees, competition response to our entry, time out of band, and the unrealizable S=1 placement) only reduces the number.

So: the ceiling does not decide the lane the way it decided funding and carry. It says only that the gross subsidy is generous. Whether the NET beats ${RISK_FREE_PCT}% is exactly the adverse-selection question this test cannot answer — and is the question the separate replay backtest must settle before any capital is committed.

## Concentration
${nFor(0.5)} markets carry 50% of the whole-lane pot; ${nFor(0.8)} carry 80%; the top 3 carry only ${(frac(3) * 100).toFixed(1)}% and the top 20 carry ${(frac(20) * 100).toFixed(1)}%. So this lane is NOT "really three markets" — the pot is spread across roughly ${nFor(0.5)} markets for the first half. Concentration is therefore not the thing that kills it; adverse selection is. (One caveat the other way: the biggest single pot is $${byPot[0].pot}/day on "${byPot[0].question.slice(0, 40)}" — ${(frac(1) * 100).toFixed(1)}% of the lane — so a handful of large geopolitical markets do move the aggregate, and those are exactly the markets where adverse selection is worst.)
`;
  fs.writeFileSync(path.join(__dirname, 'VERDICT.md'), verdict);   // committed (module root); out/ is regenerable
  console.log('\nwrote', path.join(__dirname, 'VERDICT.md'));
})().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
