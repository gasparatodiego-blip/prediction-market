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

// ── CROSSING ARITHMETIC (the 4% drawdown rule) ──────────────────────────────────
// The base holds YES at p. The drawdown rule opens the OPPOSITE side (NO) at the observed ask q. Holding
// both, at settlement EXACTLY one side pays $1/share, so each matched YES+NO pair costs (p+q) and returns
// exactly $1 — a locked outcome independent of Up/Down. If p+q > 1 the pair is a GUARANTEED loss of (p+q−1),
// and NO price path can recover it. This is the SAME self-cross constraint the maker refuses at arming time:
// lib/maker/inventory-guard.js → findSelfMatches() blocks any BUY YES + BUY NO whose prices sum to ≥ $1.
// We CITE that guard (and exercise it in the tests); we do not reimplement the gate here.

/** Guaranteed loss per matched YES+NO pair when the two legs cross ($ per pair). 0 when p+q ≤ 1. */
function crossingLossPerPair(p, q) {
  if (!(fin(p) && fin(q))) return null;
  return Math.max(0, +(p + q - 1).toFixed(12));
}

/** True when buying YES at p and NO at q crosses (p + q ≥ 1) — the pair costs ≥ $1 for a $1 payout. */
function crosses(p, q) { return fin(p) && fin(q) ? +(p + q).toFixed(12) >= 1 : null; }

/**
 * NO shares whose Down payout net-offsets the FULL $size YES stake ("sized to offset the loss"): on Down a
 * NO share nets (1 − q), so n·(1 − q) = size ⇒ n = size/(1 − q). This is the operator's rule; note it makes
 * the Up outcome a guaranteed loss (the NO premium paid), which the head-to-head measures.
 */
function hedgeSizeToOffset(sizeUsd, noAsk) {
  if (!(fin(sizeUsd) && fin(noAsk) && noAsk < 1)) return null;
  return sizeUsd / (1 - noAsk);
}

/** Fill the hedge against REAL NO-side depth ($). full / partial / failed — never assume it filled. */
function hedgeFill(neededShares, noAsk, noDepthUsd) {
  if (!(fin(neededShares) && neededShares > 0 && fin(noAsk) && noAsk > 0)) return { status: 'failed', filledShares: 0, cost: 0, reason: 'bad inputs' };
  const need$ = neededShares * noAsk;
  if (!fin(noDepthUsd) || noDepthUsd <= 0) return { status: 'failed', filledShares: 0, cost: 0, reason: 'no NO-side depth' };
  if (noDepthUsd >= need$) return { status: 'full', filledShares: neededShares, cost: need$, reason: null };
  const filled = noDepthUsd / noAsk;
  return { status: 'partial', filledShares: filled, cost: noDepthUsd, reason: `depth $${noDepthUsd.toFixed(2)} < needed $${need$.toFixed(2)}` };
}

/** Combined P&L at settlement of yShares YES @ yAsk + nShares NO @ nAsk. */
function pairPnl(yShares, yAsk, nShares, nAsk, settlement) {
  if (settlement === 'Up') return yShares * (1 - yAsk) - nShares * nAsk;      // YES pays $1/sh, NO worthless
  if (settlement === 'Down') return nShares * (1 - nAsk) - yShares * yAsk;    // NO pays $1/sh, YES worthless
  return null;
}

module.exports = {
  breakEvenWinRate, evPerShare, evPerCycle, requiredWinRateToBeat,
  crossingLossPerPair, crosses, hedgeSizeToOffset, hedgeFill, pairPnl,
};
