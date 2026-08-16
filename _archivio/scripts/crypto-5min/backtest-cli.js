#!/usr/bin/env node
'use strict';
// scripts/crypto-5min/backtest-cli.js — PHASE 1 arithmetic + PHASE 2 base-strategy backtest over whatever
// REAL observed data exists. BACKTEST, not realised P&L. Public keyless REST only; places nothing.
//
// There is no source for the required intra-window ASK + DEPTH samples (see discover-cli.js): agent34 does
// not collect these markets, prices-history is mid/last at ≥1-min fidelity, and the book is gone after
// expiry. So every candidate cycle is built with an EMPTY sample set and is SKIPPED and COUNTED — never
// filled from mid, never with a widened window. The machinery is proven by backtest.test.js on synthetic
// cycles; here it is run on real candidates to show the honest realised outcome (0 entered).

const { breakEvenWinRate, evPerCycle, requiredWinRateToBeat, crossingLossPerPair, hedgeSizeToOffset, pairPnl } = require('./lib/arithmetic');
const { runBacktest, runBacktestWithHedge } = require('./lib/backtest');
const { findFiveMinMarkets, structure } = require('./lib/discovery');

const MIN_ANNUALISE_CYCLES = 200; // below this the sample cannot see the 1-in-50 tail this profile produces

const PRICE = 0.98, SIZE = 10, RISK_FREE = 4.0, CYCLES_PER_DAY = 288;
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(4));

// Settlement from Gamma's outcomePrices ("[1,0]" ⇒ Up won, "[0,1]" ⇒ Down). Unresolved ⇒ null.
function settlementOf(m) {
  let op; try { op = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; } catch { return null; }
  if (!Array.isArray(op) || op.length < 2) return null;
  const up = Number(op[0]), dn = Number(op[1]);
  if (up === 1 && dn === 0) return 'Up';
  if (up === 0 && dn === 1) return 'Down';
  return null; // still trading / disputed / unknown
}

async function main() {
  console.log('═'.repeat(78));
  console.log('PHASE 1 — ARITHMETIC BEFORE THE BACKTEST (buy YES at 0.98, $10)');
  console.log('═'.repeat(78));
  console.log(`  break-even win rate = entry price = ${(breakEvenWinRate(PRICE) * 100).toFixed(2)}%  (win +$0.02/share, lose −$0.98/share)`);
  console.log(`  payoff asymmetry: one loss (−0.98/sh) erases ${(0.98 / 0.02).toFixed(0)} wins (+0.02/sh) — a 49:1 negative skew`);
  console.log(`  EV/cycle at a 99% win rate: ${money(evPerCycle(0.99, PRICE, SIZE))}  ·  at break-even (98%): ${money(evPerCycle(0.98, PRICE, SIZE))}`);
  const wReq = requiredWinRateToBeat(RISK_FREE, CYCLES_PER_DAY, SIZE, PRICE);
  console.log(`  win rate to beat ~${RISK_FREE}% risk-free @ ${CYCLES_PER_DAY} cycles/day: ${(wReq * 100).toFixed(6)}% — essentially just above 98% (the huge cycle count makes the extra margin negligible)`);

  console.log('\n' + '═'.repeat(78));
  console.log('PHASE 2 — BASE 98c ENTRY BACKTEST over real observed data');
  console.log('═'.repeat(78));
  const { markets } = await findFiveMinMarkets();
  // Build one candidate cycle per discovered market. There is NO ask/depth source at 47s resolution, so the
  // sample set is EMPTY for every cycle (we refuse to substitute mid or widen the window).
  const cycles = markets.map((m) => {
    const s = structure(m);
    return { marketId: s.conditionId, asset: (s.question || '').match(/^(\w+)/)?.[1] || '—', windowEndEpoch: s.windowEndEpoch, tick: s.tickSize, samples: [], settlement: settlementOf(m) };
  });
  const R = runBacktest(cycles, { entryLo: 0.98, entryHi: 0.989, windowSec: 47, sizeUsd: SIZE });
  console.log(`  candidate cycles observed: ${R.cyclesObserved}`);
  console.log(`  ENTERED: ${R.entered}   SKIPPED: ${R.skipped}`);
  console.log('  skip reasons (each counted):');
  for (const [reason, count] of Object.entries(R.skipReasons)) console.log(`    ${count} × ${reason}`);
  console.log(`  win rate: ${R.winRate == null ? '— (nothing entered — never a fake 0/0)' : (R.winRate * 100).toFixed(1) + '%'}`);
  console.log(`  gross P&L: ${money(R.grossPnl)}   ·   P&L per cycle: ${money(R.pnlPerCycle)}`);
  console.log('  DISTRIBUTION (worst cycle / longest losing streak / max drawdown):');
  console.log(`    worst single cycle: ${R.worstCycle ? money(R.worstCycle.pnl) : '—'}`);
  console.log(`    longest losing streak: ${R.entered ? R.longestLosingStreak : '—'}`);
  console.log(`    max drawdown on cumulative equity: ${money(R.maxDrawdown)}`);
  console.log('\n  → 0 cycles could be entered: no source provides the executable ask + depth inside the final 47s.');
  console.log('    The mean is uninformative on this negative-skew profile anyway — but here there is no sample to');
  console.log('    take a mean of. Machinery verified by backtest.test.js (synthetic cycles, hand-computed).');

  // ── PHASE 3 — the 4% drawdown rule ──
  console.log('\n' + '═'.repeat(78));
  console.log('PHASE 3 — 4% DRAWDOWN RULE (open the opposite side, sized to offset, at the real ask)');
  console.log('═'.repeat(78));
  const H = runBacktestWithHedge(cycles, { entryLo: 0.98, entryHi: 0.989, windowSec: 47, sizeUsd: SIZE, drawdownPct: 0.04 });
  console.log(`  entered: ${H.entered}   ·   hedge triggered: ${H.hedge.triggered} (full ${H.hedge.filledFull} / partial ${H.hedge.partial} / failed ${H.hedge.failed}) · crossed pairs: ${H.hedge.crossedPairs} · total crossing loss ${money(H.hedge.totalCrossingLoss || 0)}`);
  console.log('  CROSSING ARITHMETIC (worked pair): base YES @ 0.98; a 4% drawdown means YES has FALLEN, so NO has RISEN.');
  console.log(`    hedging then buys NO at the observed ask (e.g. 0.06). YES 0.98 + NO 0.06 = 1.04 → the pair costs 104¢ for a payout of exactly 100¢:`);
  console.log(`    guaranteed loss ${money(crossingLossPerPair(0.98, 0.06))}/pair. Sized to offset the $${SIZE} stake, NO = ${SIZE}/(1−0.06) = ${hedgeSizeToOffset(SIZE, 0.06).toFixed(3)} shares:`);
  console.log(`      Down → ${money(pairPnl(SIZE / 0.98, 0.98, hedgeSizeToOffset(SIZE, 0.06), 0.06, 'Down'))} (offsets the stake exactly)   ·   Up → ${money(pairPnl(SIZE / 0.98, 0.98, hedgeSizeToOffset(SIZE, 0.06), 0.06, 'Up'))} (the NO premium is now a certain loss)`);
  console.log('  ANSWER: the rule CAPS the −$10 tail but RECOVERS NOTHING — the crossing (p+q>1) is a locked loss, and');
  console.log('    sizing to offset Down turns the likely Up into a guaranteed −$0.43. Same self-cross the maker refuses');
  console.log('    at arming: lib/maker/inventory-guard.js → findSelfMatches (cited; exercised in hedge.test.js).');
  console.log(`  HEAD-TO-HEAD (Phase 2 vs Phase 3): both entered ${R.entered} vs ${H.entered} cycles over real data — neither is measurable; the difference is UNDETERMINED on observed data. The arithmetic says Phase 3 has WORSE EV (a certain small loss every Up vs a variable one).`);

  // ── PHASE 4 — verdict ──
  console.log('\n' + '═'.repeat(78));
  console.log('PHASE 4 — HONEST VERDICT');
  console.log('═'.repeat(78));
  const entered = R.entered;
  if (entered < MIN_ANNUALISE_CYCLES) {
    console.log(`  REFUSING TO ANNUALISE. Entered cycles ${entered} < ${MIN_ANNUALISE_CYCLES} threshold.`);
    console.log('  Threshold reasoning: at a required 98% win rate the losing outcome is ~1 in 50; a high win rate over a');
    console.log('  handful of cycles is EXACTLY the shape this strategy shows before its first large loss lands. Below a');
    console.log('  few hundred cycles you cannot distinguish 98.0% (break-even) from a profitable rate, so any annualised');
    console.log('  figure would be a fabrication. Here entered = 0, so there is nothing to annualise at all.');
  }
  console.log('  NOT MODELLED: fees, gas, slippage beyond observed depth, the chance 0.98 was QUOTED but not FILLABLE,');
  console.log('  settlement disputes, and that NO ORDER WAS EVER PLACED (backtest, not realised P&L). The venue geoblocks');
  console.log('  placement from this operator’s jurisdiction, so none of this is currently executable.');
  console.log('  VERDICT: UNRUNNABLE — no historical order-book/ask/depth exists at 47-second resolution for these markets.');

  module.exports.__result = { base: R, hedge: H };
}
if (require.main === module) main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
module.exports = { settlementOf, main };
