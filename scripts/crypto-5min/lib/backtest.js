'use strict';
// scripts/crypto-5min/lib/backtest.js — replay the 98c-entry strategy over OBSERVED cycles. Pure functions.
// BACKTEST, not realised P&L. Honest-engine: executable ASK only (never mid); real book DEPTH (our $10
// order must fit); a cycle with no in-range ask or insufficient depth is SKIPPED and COUNTED, never filled;
// unknown settlement excludes+counts the cycle. (The 4% drawdown hedge is added by the drawdown-rule commit.)
//
// A `cycle` is one 5-minute market instance:
//   { marketId, asset, windowEndEpoch, tick,
//     samples: [ { secToExpiry, ask, depthUsd } ],   // observed ASK samples with $ depth at that ask
//     settlement: 'Up' | 'Down' | null }              // null = unknown → excluded + counted

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

const DEFAULTS = { entryLo: 0.98, entryHi: 0.989, windowSec: 47, sizeUsd: 10 };

/**
 * Replay ONE cycle. Returns an entered fill OR a counted skip with a reason.
 * Entry: the FIRST observed sample inside the final `windowSec` seconds whose ASK is in [entryLo, entryHi]
 * AND whose depth at that ask can absorb the full $size. No such sample ⇒ SKIP (reason states which
 * condition failed). Fill is at the observed ask; the position is held to settlement.
 */
function replayCycle(cycle, cfg = {}) {
  const { entryLo, entryHi, windowSec, sizeUsd } = { ...DEFAULTS, ...cfg };
  if (!cycle || !Array.isArray(cycle.samples)) return { status: 'skipped', reason: 'no samples', marketId: cycle && cycle.marketId };
  if (cycle.settlement !== 'Up' && cycle.settlement !== 'Down') return { status: 'skipped', reason: 'settlement unknown', marketId: cycle.marketId };

  const inWindow = cycle.samples.filter((s) => fin(s.secToExpiry) && s.secToExpiry >= 0 && s.secToExpiry <= windowSec);
  if (!inWindow.length) return { status: 'skipped', reason: `no observed ask sample in the final ${windowSec}s`, marketId: cycle.marketId };

  const inRange = inWindow.filter((s) => fin(s.ask) && s.ask >= entryLo && s.ask <= entryHi);
  if (!inRange.length) return { status: 'skipped', reason: `ask never in [${entryLo}, ${entryHi}] in the final ${windowSec}s`, marketId: cycle.marketId };

  // earliest qualifying sample (first fill opportunity), depth must absorb the whole $size
  const sorted = [...inRange].sort((a, b) => b.secToExpiry - a.secToExpiry); // farthest-from-expiry first
  const fillSample = sorted.find((s) => fin(s.depthUsd) && s.depthUsd >= sizeUsd);
  if (!fillSample) return { status: 'skipped', reason: `depth at the 0.98 ask could not absorb $${sizeUsd}`, marketId: cycle.marketId };

  const ask = fillSample.ask;
  const shares = sizeUsd / ask;
  const win = cycle.settlement === 'Up';
  const pnl = win ? shares * (1 - ask) : -shares * ask; // Up: shares pay $1 each; Down: YES worthless
  return {
    status: 'entered', marketId: cycle.marketId, asset: cycle.asset, windowEndEpoch: cycle.windowEndEpoch,
    fillAsk: ask, shares, sizeUsd, secToExpiryAtFill: fillSample.secToExpiry, depthUsd: fillSample.depthUsd,
    settlement: cycle.settlement, win, pnl,
  };
}

/** Longest run of consecutive losses among entered cycles (in the given order). */
function longestLosingStreak(enteredInOrder) {
  let cur = 0, max = 0;
  for (const r of enteredInOrder) { if (!r.win) { cur++; if (cur > max) max = cur; } else cur = 0; }
  return max;
}

/** Max drawdown on cumulative equity (running peak − trough), over entered cycles in order. */
function maxDrawdown(enteredInOrder) {
  let eq = 0, peak = 0, mdd = 0;
  for (const r of enteredInOrder) { eq += r.pnl; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > mdd) mdd = dd; }
  return mdd;
}

/**
 * Run the base backtest over an array of cycles. Aggregates entries, skips (by reason, counted), the P&L
 * distribution, worst single cycle, longest losing streak, and max drawdown. Nothing is assumed filled.
 */
function runBacktest(cycles, cfg = {}) {
  const results = (cycles || []).map((c) => replayCycle(c, cfg));
  const entered = results.filter((r) => r.status === 'entered');
  const skipped = results.filter((r) => r.status === 'skipped');
  const skipReasons = {};
  for (const s of skipped) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;

  const ordered = [...entered].sort((a, b) => (a.windowEndEpoch || 0) - (b.windowEndEpoch || 0));
  const wins = entered.filter((r) => r.win).length;
  const losses = entered.length - wins;
  const grossPnl = entered.reduce((s, r) => s + r.pnl, 0);
  const worst = entered.reduce((w, r) => (w == null || r.pnl < w.pnl ? r : w), null);

  return {
    cyclesObserved: results.length,
    entered: entered.length,
    skipped: skipped.length,
    skipReasons,
    wins, losses,
    winRate: entered.length ? wins / entered.length : null, // null when nothing entered — never a fake 0/0
    grossPnl: entered.length ? grossPnl : null,
    pnlPerCycle: entered.length ? grossPnl / entered.length : null,
    worstCycle: worst,
    longestLosingStreak: longestLosingStreak(ordered),
    maxDrawdown: entered.length ? maxDrawdown(ordered) : null,
    enteredOrdered: ordered,
  };
}

module.exports = { replayCycle, runBacktest, longestLosingStreak, maxDrawdown, DEFAULTS };
