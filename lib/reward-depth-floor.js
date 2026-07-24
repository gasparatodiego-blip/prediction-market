'use strict';

/**
 * reward-depth-floor — the "depth at touch" sanity floor for liquidity-reward rows.
 *
 * THE ARTIFACT THIS SUPPRESSES
 *   A reward row's net $/day is pool × share, where share = deployed/(competitorDepth + deployed)
 *   (see lib/liquidity-yield.ts). When the real in-band book depth a maker dilutes against
 *   (competitorDepth) is a tiny-but-nonzero number, share collapses to ~100% and the $/day
 *   equals almost the WHOLE pool — the known "+$47.54/day CASHABLE = 1736%/yr" Polymarket
 *   figure came from a book with only a few dollars of resting depth. That is not an
 *   opportunity, it is thin-book noise: the moment any maker arrives the share compresses.
 *
 *   The 2%/day sanity cap (lib/reward-gating.ts REWARD_SANITY_CAP_PCT) only FLAGS such a row.
 *   This floor SUPPRESSES it — the actual mechanism producing the artifact is the depth, so we
 *   gate on the depth directly.
 *
 * HONEST-ENGINE
 *   - A suppressed row is HIDDEN, never rewritten toward a "corrected" number. We drop it; we
 *     never fabricate a smaller $/day for it.
 *   - We only suppress a row whose depth is a REAL finite number strictly below the floor. A
 *     null/missing depth is NOT "below the floor" — that row is unknown and already renders "—".
 *   - The floor is configurable via REWARD_DEPTH_TOUCH_FLOOR_USD (default $25). It is the single
 *     source of truth for both agent24 (Polymarket scan) and lib/rewards-normalize (the /tmp
 *     board the API serves). agent24 is a plain Node script and requires this module directly;
 *     lib/reward-gating.ts re-exports the constant for TS consumers.
 */

const DEFAULT_DEPTH_AT_TOUCH_FLOOR_USD = 25;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The active floor: env override REWARD_DEPTH_TOUCH_FLOOR_USD (≥0) or the $25 default. */
function depthFloorUsd() {
  const raw = process.env.REWARD_DEPTH_TOUCH_FLOOR_USD;
  const v = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DEPTH_AT_TOUCH_FLOOR_USD;
}

/**
 * The two-sided in-band qualifying depth a maker's share dilutes against — the SAME number
 * lib/liquidity-yield computeLiquidityYield uses as `competitorDepth` and the list shows as
 * "depth". Near side = bookDepthAtBand; on Polymarket (two-sided reward) the opposite (NO)
 * side is added, matching the client's `Q + Qopp`. Returns null when the near-side depth is
 * missing (unknown, never fabricated).
 */
function competitorDepthUsd(m) {
  const near = num(m && m.bookDepthAtBand);
  if (near == null) return null;
  const opp = m && m.venue === 'polymarket'
    ? num(m.sides && m.sides.no && m.sides.no.bookDepthAtBand)
    : 0;
  return near + (opp == null ? 0 : opp);
}

/**
 * True when a real, finite depth is strictly below the floor. Null/NaN depth ⇒ false (we do
 * not suppress on missing data — that path renders "—" elsewhere).
 */
function belowDepthFloor(depthUsd, floor) {
  const d = num(depthUsd);
  if (d == null) return false;
  const f = Number.isFinite(floor) ? floor : depthFloorUsd();
  return d < f;
}

module.exports = {
  DEFAULT_DEPTH_AT_TOUCH_FLOOR_USD,
  depthFloorUsd,
  competitorDepthUsd,
  belowDepthFloor,
};
