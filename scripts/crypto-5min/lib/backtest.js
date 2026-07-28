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

// ── PHASE 3: the 4% drawdown rule ───────────────────────────────────────────────
// After a YES entry, if the position is down more than `drawdownPct`, open the OPPOSITE side (NO) at the
// REAL observed ask, sized to offset the loss, from REAL depth. The hedge is full / partial / failed — never
// assumed filled. Because YES was bought at ~0.98 and the trigger means YES has FALLEN (so NO has RISEN),
// the pair always crosses (p + q > 1): the hedge caps the tail but locks a guaranteed crossing loss.
//
// The cycle carries a drawdown observation: cycle.drawdown = { yesMid, noAsk, noDepthUsd } — the observed
// state at the moment the 4% check is made. Absent ⇒ the rule is not evaluable for that cycle (reported).
const { hedgeSizeToOffset, hedgeFill, pairPnl, crossingLossPerPair } = require('./arithmetic');

function replayCycleWithHedge(cycle, cfg = {}) {
  const { drawdownPct = 0.04, sizeUsd = DEFAULTS.sizeUsd } = cfg;
  const base = replayCycle(cycle, cfg);
  if (base.status !== 'entered') return { ...base, hedge: null };

  const dd = cycle.drawdown;
  if (!dd || !fin(dd.yesMid)) return { ...base, hedge: { evaluable: false, reason: 'no drawdown observation' } };

  const lossFrac = (base.fillAsk - dd.yesMid) / base.fillAsk; // (cost − current)/cost
  if (!(lossFrac > drawdownPct)) return { ...base, hedge: { evaluable: true, triggered: false, lossFrac } };

  // triggered: buy NO at the observed ask, sized to offset the full stake, from real depth
  const neededShares = hedgeSizeToOffset(sizeUsd, dd.noAsk);
  const fill = hedgeFill(neededShares, dd.noAsk, dd.noDepthUsd);
  const crossPerPair = crossingLossPerPair(base.fillAsk, dd.noAsk);
  const crossingLoss = crossPerPair == null ? null : crossPerPair * Math.min(base.shares, fill.filledShares);
  const pnl = pairPnl(base.shares, base.fillAsk, fill.filledShares, dd.noAsk, cycle.settlement);
  return {
    ...base,
    pnl, // combined position P&L (overrides the base's unhedged pnl)
    hedge: {
      evaluable: true, triggered: true, lossFrac, noAsk: dd.noAsk, neededShares,
      filledShares: fill.filledShares, status: fill.status, cost: fill.cost, reason: fill.reason,
      crosses: (base.fillAsk + dd.noAsk) >= 1, crossPerPair, crossingLoss,
    },
  };
}

/** Aggregate the drawdown-rule backtest, counting hedge trigger / full / partial / failed and crossing cost. */
function runBacktestWithHedge(cycles, cfg = {}) {
  const results = (cycles || []).map((c) => replayCycleWithHedge(c, cfg));
  const entered = results.filter((r) => r.status === 'entered');
  const triggered = entered.filter((r) => r.hedge && r.hedge.triggered);
  const hedge = {
    triggered: triggered.length,
    filledFull: triggered.filter((r) => r.hedge.status === 'full').length,
    partial: triggered.filter((r) => r.hedge.status === 'partial').length,
    failed: triggered.filter((r) => r.hedge.status === 'failed').length,
    crossedPairs: triggered.filter((r) => r.hedge.crosses).length,
    totalCrossingLoss: triggered.reduce((s, r) => s + (fin(r.hedge.crossingLoss) ? r.hedge.crossingLoss : 0), 0),
    notEvaluable: entered.filter((r) => r.hedge && r.hedge.evaluable === false).length,
  };
  const ordered = [...entered].sort((a, b) => (a.windowEndEpoch || 0) - (b.windowEndEpoch || 0));
  const wins = entered.filter((r) => r.pnl > 0).length;
  const grossPnl = entered.reduce((s, r) => s + r.pnl, 0);
  return {
    cyclesObserved: results.length, entered: entered.length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    wins, losses: entered.length - wins,
    grossPnl: entered.length ? grossPnl : null,
    pnlPerCycle: entered.length ? grossPnl / entered.length : null,
    longestLosingStreak: longestLosingStreak(ordered.map((r) => ({ win: r.pnl > 0 }))),
    maxDrawdown: entered.length ? maxDrawdown(ordered) : null,
    worstCycle: entered.reduce((w, r) => (w == null || r.pnl < w.pnl ? r : w), null),
    hedge, enteredOrdered: ordered,
  };
}

module.exports = { replayCycle, runBacktest, replayCycleWithHedge, runBacktestWithHedge, longestLosingStreak, maxDrawdown, DEFAULTS };
