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
// ── CANONICAL INTERNAL UNITS (the ONE representation; everything else converts at the edge) ──────────
//
//     price     dollars per share, 0 < p < 1        (a YES share pays $1 if YES resolves)
//     size      SHARES                              (never dollars — the venue sizes orders in shares)
//     notional  price × size, in dollars            (the collateral a resting BUY commits)
//
// Why it has to be stated: the operator thinks in dollars ("I want $1,000 working"), the venue thinks in
// shares (min_incentive_size is 100 SHARES, an order is 200 SHARES), and the reward quadratic weights
// SHARES. Mixing them silently is how a panel shows one number and a bot posts another.
//
// THE CONVERSION HAPPENS EXACTLY HERE, ONCE: perSideShares = perSideUsd / buyYes. Every consumer — the
// market panel, the list row, and the sizing agent35 persists on the leg — reads that one field instead
// of dividing again. Function arguments state their unit in the name (totalSizeUsd, perSideUsd,
// perSideShares, minSize is shares); anything called `size` inside the reward math is shares, per
// lib/rewardScore.js ("size = shares (NOT dollars)").
//
// CONVENTIONS (stated explicitly, surfaced in the UI):
//   • scoringMid = rewardScore.mid = the size-cutoff-adjusted mid (orders with size ≥ minSize). This is
//     the ONE mid all reward math keys off; the plain (bestBid+bestAsk)/2 is used NOWHERE here.
//   • "Your size" is the TOTAL notional deployed across BOTH sides. quadraticUserShare treats capital as
//     PER SIDE, so perSideUsd = totalUsd / 2 is what actually feeds the score. The UI labels the control
//     as a total and states the per-side split.
//   • Eligible band radius = v = maxSpreadCents cents — la semiampiezza ufficiale, da lib/banda-premiante
//     (docs: «Max spread from midpoint»). An order at exactly the radius scores 0. The rail spans
//     mid ± 2× that radius so the eligible band keeps filling only the CENTRE of the drawing: se il
//     binario coincidesse con la banda, un ordine fuori banda non avrebbe dove essere disegnato.

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

  // Band geometry (SSOT: lib/banda-premiante via rewards-live-band). bandRadiusC = v = maxSpread;
  // il binario disegnato è 2× la banda, così la banda ne occupa il centro e resta spazio per mostrare
  // un ordine che ne è uscito.
  const band        = bandFromMid(mid, maxSpreadCents);
  const bandRadiusC = band.bandRadiusC;
  const railRadiusC = fin(bandRadiusC) ? bandRadiusC * 2 : null;

  // Offset magnitude off the mid (a distance, so ≥ 0). null ⇒ we can't place / draw markers.
  const off = fin(offsetCents) ? Math.max(0, offsetCents) : null;

  // Posted prices on the YES token: maker BID = mid − off, maker ASK = mid + off.
  //
  // FAIL CLOSED ON AN UNKNOWN TICK. The tick is the venue's price grid; without it we cannot know which
  // prices are placeable, and the venue rejects anything off-grid. So an unreadable tick yields NO price
  // at all (null → the caller renders "—") rather than a raw, unsnapped number that looks placeable and
  // is not. Never assume 0.01: this venue really runs 0.1 / 0.01 / 0.001 / 0.0001 markets.
  //
  // The snap is RECORDED, not silent: buyYesRaw/sellYesRaw keep the pre-snap target and snappedByC says
  // how far the grid moved it, so the operator can see the venue grid acting on their offset.
  const buyYesRaw  = (mid != null && off != null) ? mid - off / 100 : null;
  const sellYesRaw = (mid != null && off != null) ? mid + off / 100 : null;
  const buyYes  = tk && buyYesRaw  != null ? snapToTick(buyYesRaw, tk)  : null;
  const sellYes = tk && sellYesRaw != null ? snapToTick(sellYesRaw, tk) : null;
  const snappedByC = (buyYes != null && buyYesRaw != null && sellYes != null && sellYesRaw != null)
    ? Math.max(Math.abs(buyYes - buyYesRaw), Math.abs(sellYes - sellYesRaw)) * 100
    : null;
  // APPLIED offset — the ACTUAL distance (cents) the posted price sits from the mid AFTER the tick snap.
  // The operator requests `off`; the venue grid can only place at a tick, so the applied offset can differ
  // (e.g. 1.5c requested on a 0.01 grid → 1c or 2c applied). The row must state it — "richiesto 1,5c →
  // applicato 1c" — never round silently. bid/ask are reported separately because an off-grid mid can snap
  // them to different distances. offsetSnapped is true whenever either applied offset differs from requested.
  const appliedOffsetBidC = (buyYes != null && mid != null) ? +(Math.abs(mid - buyYes) * 100).toFixed(4) : null;
  const appliedOffsetAskC = (sellYes != null && mid != null) ? +(Math.abs(sellYes - mid) * 100).toFixed(4) : null;
  const offsetSnapped = off != null && (
    (appliedOffsetBidC != null && Math.abs(appliedOffsetBidC - off) > 1e-4) ||
    (appliedOffsetAskC != null && Math.abs(appliedOffsetAskC - off) > 1e-4)
  );
  const tickUnknownReason = tk == null
    ? 'tick del mercato non leggibile: senza la griglia dei prezzi del venue non si può dire quale prezzo è valido, quindi non ne viene proposto nessuno'
    : null;
  // Buy NO ≡ sell YES at (mid+off): the NO-token buy price = 1 − (YES sell price). Same order.
  const buyNo = (sellYes != null) ? Number((1 - sellYes).toFixed(6)) : null;

  // Are the posted orders inside the reward band? (SSOT inBand → radius = maxSpread.)
  const bidInBand = (buyYes  != null) ? inBand(buyYes,  mid, maxSpreadCents) : null;
  const askInBand = (sellYes != null) ? inBand(sellYes, mid, maxSpreadCents) : null;
  const anyOutOfBand = bidInBand === false || askInBand === false;

  // Expected GROSS $/day at the user's TOTAL size + chosen offset, via the published quadratic against
  // the feed's real competitorQ. perSideUsd = total/2 (quadraticUserShare capital is PER SIDE). When the
  // offset is beyond the band OR the per-side order is below min_size, quadraticUserShare returns 0 —
  // i.e. the number shown is already the DEGRADED case, not the both-sides-valid case (spec B3).
  const total = fin(totalSizeUsd) && totalSizeUsd > 0 ? totalSizeUsd : null;
  const perSideUsd = total != null ? total / 2 : null;
  // THE dollar→share conversion (see CANONICAL INTERNAL UNITS above). Priced off the BUY price actually
  // being posted, not off the mid, so notional round-trips exactly. Null whenever either input is null —
  // no price ⇒ no share count, never a guessed one.
  // EACH SIDE IS SIZED AT ITS OWN PRICE. The operator's budget is in dollars, so "$1,000 totale" has to
  // mean $500 committed on each side — not the same SHARE count on both, which at buyYes 0.42 / buyNo
  // 0.56 would commit $500 on YES and $669 on NO and quietly overspend the stated budget by a third.
  const perSideShares = (perSideUsd != null && buyYes != null && buyYes > 0)
    ? +(perSideUsd / buyYes).toFixed(4)
    : null;
  const perSideSharesNo = (perSideUsd != null && buyNo != null && buyNo > 0)
    ? +(perSideUsd / buyNo).toFixed(4)
    : null;
  const notionalPerSideUsd = (perSideShares != null && buyYes != null)
    ? +(perSideShares * buyYes).toFixed(4)
    : null;
  const notionalPerSideNoUsd = (perSideSharesNo != null && buyNo != null)
    ? +(perSideSharesNo * buyNo).toFixed(4)
    : null;
  const notionalTotalUsd = (notionalPerSideUsd != null && notionalPerSideNoUsd != null)
    ? +(notionalPerSideUsd + notionalPerSideNoUsd).toFixed(4)
    : null;
  // ── THE ESTIMATE'S CAPITAL IS CAPPED BY REAL IN-BAND DEPTH ────────────────────────────────────────
  // The quadratic will happily report a 99% pool share for $1,000 posted into a book holding $618 of
  // qualifying in-band depth. That number is arithmetically right and operationally meaningless: at that
  // size you ARE the book, and the competitor Q the share was divided by no longer describes anything
  // you would actually face. So the CAPITAL THE ESTIMATE ASSUMES is capped at the measured in-band
  // depth. The operator's configured size is untouched — sizing is their decision, this caps only what
  // the modelled share is priced for, and says so when it binds.
  //
  // FAIL CLOSED: depth we could not read gives no estimate at all ("—"), never an uncapped one.
  const eligibleDepthUsd = market ? competitorDepthUsd(market) : null;
  const depthReadable = fin(eligibleDepthUsd) && eligibleDepthUsd >= 0;
  const estimateCapitalUsd = (total != null && depthReadable) ? Math.min(total, eligibleDepthUsd) : null;
  const capitalCapped = estimateCapitalUsd != null && total != null && estimateCapitalUsd < total;
  const estimatePerSideUsd = estimateCapitalUsd != null ? estimateCapitalUsd / 2 : null;

  let share = null, grossPerDay = null, dayYieldPct = null;
  if (estimateCapitalUsd != null && off != null && competitorQ != null && mid != null && fin(maxSpreadCents) && minSize != null) {
    share = quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, estimatePerSideUsd, off);
    if (share != null && poolDay != null) {
      grossPerDay = poolDay * share;
      // Yield is against the capital that actually produced it — the capped figure, not the requested one.
      dayYieldPct = estimateCapitalUsd > 0 ? (grossPerDay / estimateCapitalUsd) * 100 : null;
    }
  }
  const capNote = !depthReadable
    ? 'profondità in banda non leggibile: senza sapere quanta liquidità premiante c\'è davvero nel book non si può stimare una quota, quindi non ne viene mostrata nessuna'
    : capitalCapped
      ? `stima limitata dalla profondità in banda: nel book ci sono $${Math.round(eligibleDepthUsd)} di liquidità premiante, quindi la quota è calcolata su $${Math.round(estimateCapitalUsd)} e non sui $${Math.round(total)} impostati`
      : null;

  // Own-impact = your TOTAL size / reward-eligible depth (both sides in-band USD). Chip band by %.
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
    // Pre-snap targets + how far the venue grid moved them — the snap is explicit, never silent.
    buyYesRaw, sellYesRaw, snappedByC: snappedByC != null ? +snappedByC.toFixed(4) : null,
    // Applied offset (cents) after the snap + whether the grid moved it off the requested distance.
    appliedOffsetBidC, appliedOffsetAskC, offsetSnapped,
    bidInBand, askInBand, anyOutOfBand, tickKnown: tk != null, tickUnknownReason,
    // capital + $ (A4/A5). perSideShares is THE dollar→share conversion for this row — computed once,
    // here, from the price actually being posted, so the panel, the list row and the size persisted on
    // the leg for agent35 are the same number rather than three independent divisions.
    totalSizeUsd: total, perSideUsd, perSideShares, perSideSharesNo,
    notionalPerSideUsd, notionalPerSideNoUsd, notionalTotalUsd,
    share, grossPerDay, dayYieldPct,
    // The capacity cap on the ESTIMATE (never on the operator's own sizing).
    estimateCapitalUsd, capitalCapUsd: depthReadable ? eligibleDepthUsd : null, capitalCapped, capNote,
    // own-impact (A5)
    ownImpactPct, ownImpactBand: impactBand, eligibleDepthUsd: fin(eligibleDepthUsd) ? eligibleDepthUsd : null,
    // ceiling caveat: >20% impact ⇒ the share is an optimistic ceiling (assumes no competitor re-quotes)
    shareIsCeiling: impactBand === 'high',
  };
}

module.exports = { computePriceRow, snapToTick, ownImpactBand };
