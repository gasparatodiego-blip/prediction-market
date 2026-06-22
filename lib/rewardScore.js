'use strict';
/**
 * Polymarket quadratic liquidity-reward scoring.
 *
 * Official formula (docs.polymarket.com/market-makers/liquidity-rewards):
 *
 *   S(v, s) = ((v - s) / v)^2            (b = 1 for standard orders)
 *
 *   Q_bids = Σ S(v, |p_i - mid| * 100) * size_i   over qualifying bids
 *   Q_asks = Σ S(v, |p_j - mid| * 100) * size_j   over qualifying asks
 *
 *   Q_min (mid ∈ [0.10, 0.90]):  max(min(Q_bids, Q_asks), max(Q_bids/c, Q_asks/c))
 *   Q_min (mid outside range):   min(Q_bids, Q_asks)   ← must be two-sided
 *
 * Definitions:
 *   v       = rewardsMaxSpread / 2  (half-band in CENTS; orders at |p-mid|*100 ≥ v score 0)
 *   s       = |price - adjustedMid| * 100  (distance from mid in CENTS)
 *   size    = shares (NOT dollars)
 *   c       = 3  (two-sided incentive factor)
 *   b       = 1  (standard in-game multiplier; no special boosts modelled here)
 *
 * Adjusted mid: recomputed using only orders with size ≥ rewardsMinSize after
 * filtering the book. Falls back to plain (bestBid+bestAsk)/2 when no qualifying
 * orders exist on one or both sides.
 *
 * Worked-example validation (mid=0.50, v=3¢):
 *   bid@0.49 s=1: ((3-1)/3)²=4/9≈0.444   ask@0.51 s=1: same
 *   bid@0.48 s=2: ((3-2)/3)²=1/9≈0.111   ask@0.505 s=0.5: ((3-0.5)/3)²≈0.694
 *
 * ESTIMATE ONLY — point-in-time CLOB snapshot; real scoring samples per-minute;
 * competitors re-quote continuously; not a guarantee. No Claude API. No orders placed.
 */

const C_FACTOR = 3; // c in Q_min two-sided formula

/**
 * Score one order.
 * @param {number} s_cents  distance from adjusted mid in cents
 * @param {number} v_cents  half-band in cents (rewardsMaxSpread / 2)
 * @returns {number} 0–1
 */
function scoreOrder(s_cents, v_cents) {
  if (v_cents <= 0 || s_cents >= v_cents) return 0;
  const r = (v_cents - s_cents) / v_cents;
  return r * r;
}

/**
 * Parse and sort raw CLOB order arrays (handles {price,size} and {p,s} formats).
 */
function parseOrders(raw, descending) {
  const parsed = (raw || [])
    .map(o => ({
      price: parseFloat(o.price ?? o.p ?? 0),
      size:  parseFloat(o.size  ?? o.s  ?? 0),
    }))
    .filter(o => o.price > 0 && o.size > 0 && isFinite(o.price) && isFinite(o.size));
  return descending
    ? parsed.sort((a, b) => b.price - a.price)
    : parsed.sort((a, b) => a.price - b.price);
}

/**
 * Size-cutoff-adjusted midpoint.
 * Uses best bid/ask after excluding orders below minSize.
 * This is Polymarket's "size-cutoff-adjusted midpoint" (exact internal formula
 * not published; we approximate by filtering on rewardsMinSize).
 */
function adjustedMid(bids, asks, minSize, fallbackMid) {
  const vBids = bids.filter(b => b.size >= minSize);
  const vAsks = asks.filter(a => a.size >= minSize);
  const bestBid = vBids[0];  // bids sorted desc → [0] = highest
  const bestAsk = vAsks[0];  // asks sorted asc  → [0] = lowest
  if (bestBid && bestAsk) return (bestBid.price + bestAsk.price) / 2;
  if (bestBid) return bestBid.price;
  if (bestAsk) return bestAsk.price;
  return fallbackMid;
}

/**
 * Score one side of the book (bids or asks).
 * Orders below minSize are excluded; orders outside the band score 0.
 */
function scoreSide(orders, mid, v_cents, minSize) {
  let Q = 0;
  for (const o of orders) {
    if (o.size < minSize) continue;
    const s = Math.abs(o.price - mid) * 100;
    const sc = scoreOrder(s, v_cents);
    if (sc > 0) Q += sc * o.size;
  }
  return Q;
}

/**
 * Apply the Q_min formula.
 * mid outside [0.10, 0.90] → fully two-sided (no single-sided credit).
 */
function qMin(Qbids, Qasks, mid) {
  if (mid < 0.10 || mid > 0.90) return Math.min(Qbids, Qasks);
  return Math.max(
    Math.min(Qbids, Qasks),
    Math.max(Qbids / C_FACTOR, Qasks / C_FACTOR),
  );
}

/**
 * Score all existing CLOB orders and return competitor Q values.
 *
 * @param {{ bids: Array, asks: Array }} rawBook  raw CLOB arrays
 * @param {number} maxSpreadCents   rewardsMaxSpread in cents (total band = 2v)
 * @param {number} minSize          rewardsMinSize in shares
 * @param {number} fallbackMid      plain (bestBid+bestAsk)/2 from Gamma metadata
 * @returns {{ Qbids, Qasks, Qmin, mid }}
 */
function scoreBook(rawBook, maxSpreadCents, minSize, fallbackMid) {
  const bids   = parseOrders(rawBook.bids, true);
  const asks   = parseOrders(rawBook.asks, false);
  const v      = maxSpreadCents / 2;
  const mid    = adjustedMid(bids, asks, minSize, fallbackMid);
  const Qbids  = scoreSide(bids, mid, v, minSize);
  const Qasks  = scoreSide(asks, mid, v, minSize);
  const Qmin   = qMin(Qbids, Qasks, mid);
  return { Qbids, Qasks, Qmin, mid };
}

/**
 * Estimate pool share for a capital level (agent24 list estimates).
 *
 * Placement assumption: user posts bid+ask both at mid (score=1, optimal/best-case).
 * Size per side = capital / mid (shares at mid price).
 * ESTIMATE — real placement at the mid is impractical; actual score depends on spread.
 *
 * @param {{ Qmin: number, mid: number }} competitorQ  from scoreBook()
 * @param {number} maxSpreadCents
 * @param {number} minSize
 * @param {number} rewardsDailyRate
 * @param {number} capital  dollars
 * @returns {{ share, grossRewardDay, dayYieldPct }}
 */
function estimateCapitalLevel(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, capital) {
  const { Qmin: Qcompetitors, mid } = competitorQ;
  const price       = Math.max(0.01, Math.min(0.99, mid));
  const size        = capital / price;          // shares per side at mid
  const aboveMin    = size >= minSize;
  const v           = maxSpreadCents / 2;

  // At mid: s=0 → score=1 (((v-0)/v)^2 = 1)
  const userScore   = (aboveMin && v > 0) ? 1.0 : 0;
  const Q_per_side  = userScore * size;

  // Both sides at same distance (0 from mid) → Q_bids = Q_asks
  const Quser       = qMin(Q_per_side, Q_per_side, mid);
  const share       = Quser > 0 ? Quser / (Quser + Qcompetitors) : 0;
  const grossRewardDay = share * rewardsDailyRate;
  const dayYieldPct    = capital > 0 ? (grossRewardDay / capital) * 100 : 0;

  return {
    share:           parseFloat(share.toFixed(6)),
    grossRewardDay:  parseFloat(grossRewardDay.toFixed(4)),
    dayYieldPct:     parseFloat(dayYieldPct.toFixed(3)),
  };
}

module.exports = {
  C_FACTOR,
  scoreOrder,
  parseOrders,
  adjustedMid,
  scoreSide,
  qMin,
  scoreBook,
  estimateCapitalLevel,
};
