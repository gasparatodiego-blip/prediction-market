'use strict';
// lib/reward-price-row.js — PRICE-FIRST row computations for the Liquidity Rewards board (Part A).
//
// Pure, node + browser importable. NO PARALLEL MATH (honest-engine):
//   • posted prices are derived from the SCORING mid + the user's offset;
//   • share/$ come from the published Polymarket quadratic (lib/rewardScore.quadraticUserShare)
//     against the SAME competitorQ the feed already carries — never a new estimate;
//   • band geometry comes from the SSOT (lib/rewards-live-band.bandFromMid / inBand).
// Any unreadable input → null (the caller renders "—"); never a fabricated number, never a 0 stand-in.
//
// CONVENTIONS (stated explicitly, surfaced in the UI):
//   • scoringMid = rewardScore.mid = the size-cutoff-adjusted mid (orders with size ≥ minSize). This is
//     the ONE mid all reward math keys off; the plain (bestBid+bestAsk)/2 is used NOWHERE here.
//   • "Your size" is the TOTAL notional deployed across BOTH sides. quadraticUserShare treats capital as
//     PER SIDE, so perSideUsd = totalUsd / 2 is what actually feeds the score. The UI labels the control
//     as a total and states the per-side split.
//   • Eligible band radius = maxSpreadCents / 2 cents (rewardScore uses v = maxSpread/2, and the SSOT
//     inBand tests |price − mid|·100 ≤ maxSpread/2). An order at exactly the radius scores 0. The rail
//     spans mid ± maxSpreadCents cents (2× the band radius) so the eligible band fills its centre.

const { quadraticUserShare } = require('./rewardScore');
const { bandFromMid, inBand } = require('./rewards-live-band');
const { competitorDepthUsd } = require('./reward-depth-floor');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// Snap to the market's tick (nearest), clamp to the postable range [tick, 1−tick]. null if tick unknown.
function snapToTick(price, tick) {
  if (!fin(price) || !(tick > 0)) return null;
  const dp = (String(tick).split('.')[1] || '').length;
  let s = Number((Math.round(price / tick) * tick).toFixed(dp));
  const lo = Number(tick.toFixed(dp));
  const hi = Number((1 - tick).toFixed(dp));
  if (s < lo) s = lo;
  if (s > hi) s = hi;
  return s;
}

// Own-impact band thresholds (spec A5): <5% green, 5–20% amber, >20% red ("you become the book").
function ownImpactBand(pct) {
  if (!fin(pct)) return null;
  if (pct < 5) return 'low';
  if (pct <= 20) return 'mid';
  return 'high';
}

/**
 * The price-first view of one reward market at a chosen TOTAL size + offset.
 *
 * @param {object} args
 *   rewardScore  { poolDay, mid, maxSpreadCents, minSize, competitorQ, refCapital, refShare } | null
 *   tick         market tick size (0.01 / 0.001 / …) | null
 *   totalSizeUsd TOTAL deployed across both sides (null/empty ⇒ every $ figure is null)
 *   offsetCents  posting offset from mid, in cents (null ⇒ no posted prices / no rail)
 *   market       the full normalized market row (for competitorDepthUsd) — optional
 * @returns a flat object; unknown fields are null.
 */
function computePriceRow({ rewardScore, tick, totalSizeUsd, offsetCents, market } = {}) {
  const rs = rewardScore || null;
  const mid            = rs && fin(rs.mid) ? rs.mid : null;
  const maxSpreadCents = rs && fin(rs.maxSpreadCents) ? rs.maxSpreadCents : null;
  const minSize        = rs && fin(rs.minSize) ? rs.minSize : null;
  const competitorQ    = rs && fin(rs.competitorQ) ? rs.competitorQ : null;
  const poolDay        = rs && fin(rs.poolDay) ? rs.poolDay : null;
  const tk             = fin(tick) && tick > 0 ? tick : null;

  // Band geometry (SSOT). bandRadiusC = maxSpread/2; rail is 2× that (mid ± maxSpread cents).
  const band        = bandFromMid(mid, maxSpreadCents);
  const bandRadiusC = band.bandRadiusC;
  const railRadiusC = fin(maxSpreadCents) ? maxSpreadCents : null;

  // Offset magnitude off the mid (a distance, so ≥ 0). null ⇒ we can't place / draw markers.
  const off = fin(offsetCents) ? Math.max(0, offsetCents) : null;

  // Posted prices on the YES token: maker BID = mid − off, maker ASK = mid + off. Tick-snapped so we
  // never display an off-tick price (when tick is unknown we keep the raw derived price, flagged).
  const buyYesRaw  = (mid != null && off != null) ? mid - off / 100 : null;
  const sellYesRaw = (mid != null && off != null) ? mid + off / 100 : null;
  const buyYes  = tk && buyYesRaw  != null ? snapToTick(buyYesRaw, tk)  : buyYesRaw;
  const sellYes = tk && sellYesRaw != null ? snapToTick(sellYesRaw, tk) : sellYesRaw;
  // Buy NO ≡ sell YES at (mid+off): the NO-token buy price = 1 − (YES sell price). Same order.
  const buyNo = (sellYes != null) ? Number((1 - sellYes).toFixed(6)) : null;

  // Are the posted orders inside the reward band? (SSOT inBand → radius = maxSpread/2.)
  const bidInBand = (buyYes  != null) ? inBand(buyYes,  mid, maxSpreadCents) : null;
  const askInBand = (sellYes != null) ? inBand(sellYes, mid, maxSpreadCents) : null;
  const anyOutOfBand = bidInBand === false || askInBand === false;

  // Expected GROSS $/day at the user's TOTAL size + chosen offset, via the published quadratic against
  // the feed's real competitorQ. perSideUsd = total/2 (quadraticUserShare capital is PER SIDE). When the
  // offset is beyond the band OR the per-side order is below min_size, quadraticUserShare returns 0 —
  // i.e. the number shown is already the DEGRADED case, not the both-sides-valid case (spec B3).
  const total = fin(totalSizeUsd) && totalSizeUsd > 0 ? totalSizeUsd : null;
  const perSideUsd = total != null ? total / 2 : null;
  let share = null, grossPerDay = null, dayYieldPct = null;
  if (total != null && off != null && competitorQ != null && mid != null && fin(maxSpreadCents) && minSize != null) {
    share = quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, perSideUsd, off);
    if (share != null && poolDay != null) {
      grossPerDay = poolDay * share;
      dayYieldPct = total > 0 ? (grossPerDay / total) * 100 : null; // %/day; == grossPerDay/total·100 by construction
    }
  }

  // Own-impact = your TOTAL size / reward-eligible depth (both sides in-band USD). Chip band by %.
  const eligibleDepthUsd = market ? competitorDepthUsd(market) : null;
  let ownImpactPct = null;
  if (total != null && fin(eligibleDepthUsd) && eligibleDepthUsd > 0) {
    ownImpactPct = (total / eligibleDepthUsd) * 100;
  }
  const impactBand = ownImpactBand(ownImpactPct);

  return {
    // real inputs (A1)
    scoringMid: mid, maxSpreadCents, minSize, competitorQ, poolDay, tick: tk,
    // band geometry (A3)
    bandRadiusC, railRadiusC, bandLo: band.bandLo, bandHi: band.bandHi,
    // posted prices (A2)
    offsetCents: off, buyYes, sellYes, buyNo, sellYesForNoIdentity: sellYes,
    bidInBand, askInBand, anyOutOfBand, tickKnown: tk != null,
    // capital + $ (A4/A5)
    totalSizeUsd: total, perSideUsd,
    share, grossPerDay, dayYieldPct,
    // own-impact (A5)
    ownImpactPct, ownImpactBand: impactBand, eligibleDepthUsd: fin(eligibleDepthUsd) ? eligibleDepthUsd : null,
    // ceiling caveat: >20% impact ⇒ the share is an optimistic ceiling (assumes no competitor re-quotes)
    shareIsCeiling: impactBand === 'high',
  };
}

module.exports = { computePriceRow, snapToTick, ownImpactBand };
