'use strict';
// scripts/crypto-5min/lib/arithmetic.js — the arithmetic the backtest rests on, computed BEFORE any data.
// Pure functions, no I/O. (The crossing/hedge arithmetic is added by the drawdown-rule commit.)

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Break-even win rate for buying YES at `price`: a win pays (1 − price), a loss pays −price. Zero expected
 * value ⇒ w·(1−p) − (1−w)·p = 0 ⇒ w = p. So at 0.98 you must win 98% of the time just to break even, and
 * the payoff is 49:1 against you (lose 0.98 to win 0.02).
 */
function breakEvenWinRate(price) { return fin(price) ? price : null; }

/** Expected value PER SHARE at a given win rate: w·(1−p) − (1−w)·p = w − p (dollars/share). */
function evPerShare(winRate, price) { return (fin(winRate) && fin(price)) ? winRate - price : null; }

/** Expected value PER CYCLE for a $size position (shares = size/price): (size/price)·(w − p). */
function evPerCycle(winRate, price, sizeUsd) {
  if (!(fin(winRate) && fin(price) && price > 0 && fin(sizeUsd))) return null;
  return (sizeUsd / price) * (winRate - price);
}

/**
 * Win rate needed to beat `riskFreePct` %/yr, given cyclesPerDay repetitions reusing the same $size capital.
 * annual = evPerCycle · cyclesPerDay · 365 / size = (1/p)(w−p)·cyclesPerDay·365. Solve for w.
 * With a huge cycle count the required margin above break-even is vanishingly small — the binding constraint
 * is essentially w > p (98%).
 */
function requiredWinRateToBeat(riskFreePct, cyclesPerDay, sizeUsd, price) {
  if (!(fin(riskFreePct) && fin(cyclesPerDay) && cyclesPerDay > 0 && fin(price) && price > 0)) return null;
  return price + (riskFreePct / 100) * price / (cyclesPerDay * 365);
}

module.exports = { breakEvenWinRate, evPerShare, evPerCycle, requiredWinRateToBeat };
