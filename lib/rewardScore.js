'use strict';
const { raggioBandaCents } = require('./banda-premiante');
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
 *   v       = rewardsMaxSpread  (SEMIAMPIEZZA in CENTS — la SSOT è lib/banda-premiante; i docs la
 *             definiscono «Max spread from midpoint», cioè la distanza massima DAL MID, non la
 *             larghezza totale. Ordini a |p-mid|*100 ≥ v valgono 0. La banda intera è 2v.)
 *   s       = |price - adjustedMid| * 100  (distance from mid in CENTS)
 *   size    = shares (NOT dollars)
 *   c       = 3  (two-sided incentive factor)
 *   b       = 1  (standard in-game multiplier)
 *
 * Adjusted mid: recomputed using only orders with size ≥ rewardsMinSize.
 *
 * FORMULA VERIFICATION:
 *   Test book: bids=[0.49×100, 0.48×100] asks=[0.51×100, 0.505×100] v=3¢ minSize=1
 *   adjustedMid = (bestBid + bestAsk) / 2 = (0.49 + 0.505) / 2 = 0.4975
 *   Qbids = S(0.75¢)*100 + S(1.75¢)*100 = 0.5625*100 + 0.1736*100 = 56.25 + 17.36 = 73.61
 *   Qasks = S(1.25¢)*100 + S(0.75¢)*100 = 0.3403*100 + 0.5625*100 = 34.03 + 56.25 = 90.28
 *   Qmin(73.61, 90.28, 0.4975) = max(min(73.61,90.28), max(73.61/3,90.28/3))
 *                               = max(73.61, max(24.54, 30.09)) = 73.61 ✓
 *   NOTE: prior claim of 111.11 was wrong (traced to: Qbids with size=200 and no qMin applied).
 *   The Polymarket docs show the formula steps but do not state a specific Q_min value
 *   for their worked example — there is no official reference number to match against.
 *
 * Placement scenarios for capital-level estimates (two-sided, symmetric):
 *   typical  s = v/2      → S = 0.25  — realistic farming position (quarter-way to band edge)
 *   high     s = 0.1¢     → S ≈ ((v-0.1)/v)²  — near-mid floor (impractical to hold continuously)
 *   low      s = 0.8·v    → S = 0.04  — outer band (tightest competition point, worst score)
 *   atMid    s = 0        → S = 1.0   — theoretical ceiling; real orders cannot sit at mid
 *
 * ESTIMATE ONLY — point-in-time CLOB snapshot; real scoring samples per-minute;
 * competitors re-quote continuously; not a guarantee. No Claude API. No orders placed.
 */

const C_FACTOR = 3;

// LP reward disbursements are paid from the reward pool in USDC with no platform fee deducted.
// Polymarket CLOB maker fee = 0% (documented). Polygon gas ≈ $0 (negligible).
// The 2% settlement winFee in lib/fees.ts applies to RESOLVED winning positions, not to rewards.
const POLYMARKET_REWARD_FEE_RATE = 0;

function scoreOrder(s_cents, v_cents) {
  if (v_cents <= 0 || s_cents >= v_cents) return 0;
  const r = (v_cents - s_cents) / v_cents;
  return r * r;
}

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

function adjustedMid(bids, asks, minSize, fallbackMid) {
  const vBids   = bids.filter(b => b.size >= minSize);
  const vAsks   = asks.filter(a => a.size >= minSize);
  const bestBid = vBids[0];
  const bestAsk = vAsks[0];
  if (bestBid && bestAsk) return (bestBid.price + bestAsk.price) / 2;
  if (bestBid) return bestBid.price;
  if (bestAsk) return bestAsk.price;
  return fallbackMid;
}

function scoreSide(orders, mid, v_cents, minSize) {
  let Q = 0;
  for (const o of orders) {
    if (o.size < minSize) continue;
    const s  = Math.abs(o.price - mid) * 100;
    const sc = scoreOrder(s, v_cents);
    if (sc > 0) Q += sc * o.size;
  }
  return Q;
}

function qMin(Qbids, Qasks, mid) {
  if (mid < 0.10 || mid > 0.90) return Math.min(Qbids, Qasks);
  return Math.max(
    Math.min(Qbids, Qasks),
    Math.max(Qbids / C_FACTOR, Qasks / C_FACTOR),
  );
}

function scoreBook(rawBook, maxSpreadCents, minSize, fallbackMid) {
  const bids  = parseOrders(rawBook.bids, true);
  const asks  = parseOrders(rawBook.asks, false);
  const v     = raggioBandaCents(maxSpreadCents);
  const mid   = adjustedMid(bids, asks, minSize, fallbackMid);
  const Qbids = scoreSide(bids, mid, v, minSize);
  const Qasks = scoreSide(asks, mid, v, minSize);
  const Qmin  = qMin(Qbids, Qasks, mid);
  return { Qbids, Qasks, Qmin, mid };
}

/**
 * Estimate pool share across three placement scenarios for a capital level.
 *
 * All scenarios assume the user posts symmetrically on BOTH sides at the same distance.
 *
 * Placement scenarios (two-sided, s_bid = s_ask = s):
 *   typical  s = v/2    → S = 0.25  — HEADLINE: realistic farming position
 *   high     s = 0.1¢   → S ≈ 0.91  — near-mid floor (optimistic bound)
 *   low      s = 0.8·v  → S = 0.04  — outer band (pessimistic bound)
 *   atMid    s = 0      → S = 1.0   — ceiling only, for comparison output
 *
 * @param {{ Qmin: number, mid: number }} competitorQ  from scoreBook()
 * @param {number} maxSpreadCents   rewardsMaxSpread in cents (total band = 2v)
 * @param {number} minSize          rewardsMinSize in shares
 * @param {number} rewardsDailyRate
 * @param {number} capital          dollars
 * @returns {{ typical, high, low, atMid, aboveMin, share, grossRewardDay, dayYieldPct }}
 */
function estimateCapitalLevelRange(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, capital) {
  const { Qmin: Qcompetitors, mid } = competitorQ;
  const price    = Math.max(0.01, Math.min(0.99, mid));
  const size     = capital / price;
  const aboveMin = size >= minSize;
  const v        = raggioBandaCents(maxSpreadCents);

  function atDist(s_cents) {
    const sc = scoreOrder(s_cents, v);
    if (!aboveMin || sc === 0) {
      return { score: 0, share: 0, grossRewardDay: 0, dayYieldPct: 0, netRewardDay: 0, netYieldPct: 0 };
    }
    const Qu_side        = sc * size;
    const Qu             = qMin(Qu_side, Qu_side, mid);
    const share          = Qu / (Qu + Qcompetitors);
    const grossRewardDay = share * rewardsDailyRate;
    const dayYieldPct    = capital > 0 ? (grossRewardDay / capital) * 100 : 0;
    const netRewardDay   = grossRewardDay * (1 - POLYMARKET_REWARD_FEE_RATE);
    const netYieldPct    = capital > 0 ? (netRewardDay / capital) * 100 : 0;
    return {
      score:          parseFloat(sc.toFixed(4)),
      share:          parseFloat(share.toFixed(6)),
      grossRewardDay: parseFloat(grossRewardDay.toFixed(4)),
      dayYieldPct:    parseFloat(dayYieldPct.toFixed(3)),
      netRewardDay:   parseFloat(netRewardDay.toFixed(4)),
      netYieldPct:    parseFloat(netYieldPct.toFixed(3)),
    };
  }

  const typical = atDist(v / 2);                         // S = 0.25
  const high    = atDist(Math.min(0.1, v * 0.04));       // 0.1¢ floor, or 4% of v if tiny band
  const low     = atDist(v * 0.8);                       // S = 0.04
  const atMid   = atDist(0);                             // S = 1.0, ceiling only

  return {
    aboveMin,
    typical,
    high,
    low,
    atMid,
    // headline aliases — all callers that read .share/.netRewardDay get the typical number
    share:          typical.share,
    grossRewardDay: typical.grossRewardDay,
    dayYieldPct:    typical.dayYieldPct,
    netRewardDay:   typical.netRewardDay,
    netYieldPct:    typical.netYieldPct,
  };
}

// Thin backward-compat wrapper — returns same shape as before, headline = typical.
function estimateCapitalLevel(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, capital) {
  return estimateCapitalLevelRange(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, capital);
}

// ── Real-path share helpers (browser-safe; used by the Liquidity Rewards list) ──
//
// Recover the REAL quadratic competitor score Q_min that produced a level's share.
// This is the EXACT algebraic inverse of estimateCapitalLevelRange's typical (s=v/2)
// placement — it re-uses the SAME published S(v,s), so the returned Q is the very
// number agent24 measured from the live CLOB book (which it computes but does not
// persist), not a new estimate. Any of the capital tiers recovers the same Q; we try
// the mid tier first for numerical headroom. Returns null when no tier is scoreable
// (below-min / empty book / degenerate share) — competition is then genuinely
// unmeasurable and the caller shows "—", never a fabricated value.
function recoverCompetitorQ(levels, mid, maxSpreadCents, minSize) {
  if (!levels || mid == null || !(maxSpreadCents > 0)) return null;
  const v     = raggioBandaCents(maxSpreadCents);
  const price = Math.max(0.01, Math.min(0.99, mid));
  const scTyp = scoreOrder(v / 2, v);                 // S at the typical placement (s=v/2)
  if (scTyp <= 0) return null;
  for (const C of [5000, 500, 50000]) {
    const lv    = levels[String(C)];
    const share = lv && typeof lv.share === 'number' ? lv.share : 0;
    if (!(share > 0 && share < 1)) continue;          // 0 or 1 → not invertible
    const size  = C / price;
    if (size < (minSize || 0)) continue;
    const QuSide = scTyp * size;
    const Qu     = qMin(QuSide, QuSide, mid);
    if (Qu <= 0) continue;
    return Qu * (1 - share) / share;                  // Q_competitors (exact)
  }
  return null;
}

// userShare for a chosen capital + placement distance against a KNOWN competitor Q,
// via the published quadratic S(v,s). Pure; no constants. Returns null if competitorQ
// is unknown, 0 if the order is below the venue min size.
function quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, capital, distanceCents) {
  if (competitorQ == null || !(competitorQ >= 0) || mid == null || !(maxSpreadCents > 0)) return null;
  const v     = raggioBandaCents(maxSpreadCents);
  const price = Math.max(0.01, Math.min(0.99, mid));
  const size  = capital / price;
  if (size < (minSize || 0)) return 0;
  const sc    = scoreOrder(Math.max(0, distanceCents), v);
  const QuSide = sc * size;
  const Qu    = qMin(QuSide, QuSide, mid);
  const denom = Qu + competitorQ;
  return denom > 0 ? Qu / denom : (Qu > 0 ? 1 : 0);
}

// Kalshi OBSERVED flat pro-rata: share = userSize / (userSize + competitorShares).
// competitorQ here is the limiting side's qualifying SIZE in shares (no proximity
// weight — Kalshi publishes no band/formula; this mirrors agent25's observed model).
function flatUserShare(competitorShares, mid, capital) {
  if (competitorShares == null || !(competitorShares >= 0) || mid == null) return null;
  const price    = Math.max(0.01, Math.min(0.99, mid));
  const userSize = capital / price;
  const denom    = userSize + competitorShares;
  return denom > 0 ? userSize / denom : (userSize > 0 ? 1 : 0);
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
  estimateCapitalLevelRange,
  recoverCompetitorQ,
  quadraticUserShare,
  flatUserShare,
};
