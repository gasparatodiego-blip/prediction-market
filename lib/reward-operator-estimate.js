'use strict';

/**
 * reward-operator-estimate — the ONE per-operator "what would I actually earn per day?" number
 * the Liquidity Rewards list leads with. It is NOT the pot (the whole prize every maker shares);
 * it is a single maker's MODELLED share of that pot — a "stima", never an observed payout.
 *
 * NO PARALLEL MATH (honest-engine). This module does not re-derive a share. It reads the share the
 * shared quadratic scorer already produced:
 *   agent24/25  →  lib/rewardScore.js  quadraticUserShare / flatUserShare  →  rewards-normalize.js
 *   stamps  rewardScore.refShare  = a REWARD_REF_CAPITAL ($1,000) maker's pool share, scored on the
 *   live CLOB book with Polymarket's published formula S(v,s) = ((v−s)/v)², Qmin two-sided, using the
 *   market's real min_incentive_size (rewardScore.minSize) and max_incentive_spread (maxSpreadCents).
 * The estimated $/day is therefore simply  poolDay × refShare  — two fields the shared lib produced,
 * multiplied. The same number backs the saturation bar (which already reads refShare), so the headline
 * and the "competition" context can never disagree.
 *
 * THE ASSUMPTIONS ARE EXPLICIT AND FIXED (surfaced in the UI, never hidden):
 *   - ASSUMED_ORDER_SIZE_USD — the order the estimate is priced for. It MUST equal REWARD_REF_CAPITAL
 *     in lib/rewards-normalize.js, because refShare is scored at exactly that capital. We do not invent
 *     a size: each row reports the refCapital the feed actually used, and this constant is only the
 *     copy/fallback for the always-visible disclosure.
 *   - ASSUMED_PLACEMENT_SCORE — the distance-from-midpoint the estimate assumes: a "typical" farming
 *     placement a quarter of the reward band off the size-cutoff-adjusted mid, i.e. s = v/2 of the
 *     half-band, which scores S = ((v−s)/v)² = 0.25. Tighter (nearer the mid) would score more and is
 *     impractical to hold; wider scores less. This is the same placement rewards-normalize used to
 *     compute refShare, so this module and the feed agree by construction.
 *
 * HONEST-ENGINE WITHHOLDING: when the book could not be scored (no pool, or refShare null because the
 * competitor Q could not be recovered / the order is below the venue min size / the book is empty), the
 * estimate is UNKNOWN → the caller renders "—" and keeps the pot as the visible figure. Never zero,
 * never fabricated.
 *
 * GROSS accrual only: this is the reward program's stated pot rate times your modelled share. It does
 * NOT net inventory P&L when your resting orders fill — that is a separate cost, excluded everywhere.
 */

// MUST equal REWARD_REF_CAPITAL in lib/rewards-normalize.js (refShare is scored at this capital).
const ASSUMED_ORDER_SIZE_USD = 1000;

// Typical placement quadratic score: a quarter of the reward band off the mid ⇒ S = ((v−s)/v)² = 0.25.
const ASSUMED_PLACEMENT_SCORE = 0.25;

// Human copy for the always-visible disclosure (Italian, sentence case — matches the surface).
const ASSUMED_PLACEMENT_LABEL = 'su entrambi i lati, a un quarto della banda dal punto medio';

function fin(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * The per-operator estimated reward for one market's rewardScore block.
 *
 * @param {{ poolDay?: number|null, refShare?: number|null, refCapital?: number|null }|null|undefined} rewardScore
 * @returns {{ estUsdPerDay: number|null, share: number|null, assumedOrderSizeUsd: number, unknown: boolean }}
 */
function estimatedOperatorSharePerDay(rewardScore, opts) {
  const rs = rewardScore || null;
  const pool = rs ? rs.poolDay : null;
  const share = rs ? rs.refShare : null;
  const size = rs && fin(rs.refCapital) ? rs.refCapital : ASSUMED_ORDER_SIZE_USD;
  // No pool or no scored share ⇒ withhold; the caller shows "—" and keeps the pot visible.
  if (!fin(pool) || !fin(share)) {
    return { estUsdPerDay: null, share: null, assumedOrderSizeUsd: size, unknown: true,
      capitalCapUsd: null, cappedCapitalUsd: null, capitalCapped: false, capNote: null };
  }

  // ── THE ASSUMED CAPITAL IS CAPPED BY REAL IN-BAND DEPTH ──────────────────────────────────────────
  // refShare is scored for a $1,000 maker. In a book holding $618 of qualifying in-band depth that
  // produces "you take 99% of the pot" — arithmetically right and operationally meaningless: at that
  // size you ARE the book and the competitor Q the share was divided by describes nothing you would
  // face. Cap the assumed capital at the measured depth and RESCALE the share exactly.
  //
  // The rescale is algebra on the published quadratic, not a new model. share = Qu/(Qu+Qc) with Qu
  // proportional to capital, so at capital ratio r the share becomes r·share / (r·share + (1−share)).
  // No new constant, no second estimate.
  const depth = opts && fin(opts.inBandDepthUsd) && opts.inBandDepthUsd >= 0 ? opts.inBandDepthUsd : null;
  if (depth != null && depth < size && size > 0) {
    const r = depth / size;
    const capped = (r * share) / (r * share + (1 - share));
    return {
      estUsdPerDay: pool * capped,
      share: capped,
      assumedOrderSizeUsd: size,
      unknown: false,
      capitalCapUsd: depth,
      cappedCapitalUsd: depth,
      capitalCapped: true,
      capNote: `stima limitata dalla profondità in banda: nel book ci sono $${Math.round(depth)} di liquidità premiante, quindi la quota è calcolata su $${Math.round(depth)} e non sui $${Math.round(size)} di riferimento`,
    };
  }

  return { estUsdPerDay: pool * share, share, assumedOrderSizeUsd: size, unknown: false,
    capitalCapUsd: depth, cappedCapitalUsd: size, capitalCapped: false, capNote: null };
}

/**
 * The same estimate priced at a REAL capital instead of the feed's $1,000 reference.
 *
 * WHY THIS EXISTS. refShare is scored for a $1,000 maker. Showing that figure to an operator whose proxy
 * holds $100 is not a conservative approximation — it overstates by roughly an order of magnitude, because
 * the share is a share of a pot and shrinks with the capital behind it. The operator board therefore
 * prices every displayed $/day at the balance actually read on-chain.
 *
 * NO SECOND MODEL. The rescale is the one already implemented and documented above, in the depth cap:
 * share = Qu/(Qu+Qc) is proportional to capital, so at capital ratio r the share becomes
 * r·share/(r·share + (1−share)). This function only chooses WHICH capital to hand to it — the MINIMUM of
 * the operator's capital and the book's measured in-band depth, so an order larger than the book it would
 * sit in is still priced against the book that exists.
 *
 * Pure and browser-safe (no I/O), so the server aggregation and the client console call the identical
 * function and cannot drift apart.
 *
 * @param {object|null} rewardScore    the feed's scored block
 * @param {number|null} capitalUsd     the operator's real capital; null/≤0 ⇒ unknown, never a default
 * @param {number|null} inBandDepthUsd measured in-band depth, when known
 * @returns {{ estUsdPerDay:number|null, share:number|null, capitalUsd:number|null, depthLimited:boolean, unknown:boolean, reason:string|null }}
 */
function estimateAtCapital(rewardScore, capitalUsd, inBandDepthUsd) {
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  // An unreadable capital is NOT silently replaced by the $1,000 reference: that substitution is exactly
  // the overstatement this function exists to remove. Unknown in, unknown out.
  if (!finite(capitalUsd)) {
    return { estUsdPerDay: null, share: null, capitalUsd: null, depthLimited: false, unknown: true,
      reason: 'capitale reale non leggibile — nessuna stima viene calcolata su un capitale ipotetico' };
  }
  if (capitalUsd <= 0) {
    return { estUsdPerDay: 0, share: 0, capitalUsd: 0, depthLimited: false, unknown: false,
      reason: 'capitale disponibile pari a zero: nessun premio maturabile' };
  }
  const depthLimited = finite(inBandDepthUsd) && inBandDepthUsd >= 0 && inBandDepthUsd < capitalUsd;
  const priced = depthLimited ? inBandDepthUsd : capitalUsd;
  const est = estimatedOperatorSharePerDay(rewardScore, { inBandDepthUsd: priced });
  if (est.unknown) {
    return { estUsdPerDay: null, share: null, capitalUsd: priced, depthLimited, unknown: true,
      reason: 'il book non è scorabile (pool o quota non recuperabili)' };
  }
  return {
    estUsdPerDay: est.estUsdPerDay,
    share: est.share,
    capitalUsd: priced,
    depthLimited,
    unknown: false,
    reason: depthLimited
      ? `stima limitata dalla profondità in banda: nel book ci sono $${Math.round(inBandDepthUsd)} di liquidità premiante, meno del tuo capitale`
      : null,
  };
}

module.exports = {
  ASSUMED_ORDER_SIZE_USD,
  ASSUMED_PLACEMENT_SCORE,
  ASSUMED_PLACEMENT_LABEL,
  estimatedOperatorSharePerDay,
  estimateAtCapital,
};
