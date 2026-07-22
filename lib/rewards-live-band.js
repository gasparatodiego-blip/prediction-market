'use strict';
// lib/rewards-live-band.js — pure math for the live band + per-leg follow/pinned
// targets + drift. SSOT shared by agent34 (server drift), /api/rewards/legs, the
// detail UI, and scripts/news-guard-selfcheck.js. No I/O, no new magic constants:
// the band radius is the existing maxSpread/2 convention and the in-band test is
// the existing |price - mid|*100 <= radius. Reward-forgone is NEVER computed here —
// it comes from the market's already-computed rewardScore (see lib/news-guard).
//
// Definitions (cents unless noted; price is a probability 0..1):
//   bandRadiusC = maxSpreadC / 2            — half the reward band, in cents
//   in-band     ⇔ |price - mid| * 100 <= bandRadiusC
//   offsetC     = signed (price - mid) * 100 captured WHEN THE LEG WAS PLACED
//   follow target = mid + offsetC/100       — tracks mid live, keeps the same gap
//   pinned target = the leg's literal price  — does not move
//   drift       = (actualPrice - targetPrice) * 100, signed cents

function round(n, dp) { const f = 10 ** dp; return Math.round(n * f) / f; }

/** Band geometry around a mid. Returns null radius when the market has no band. */
function bandFromMid(mid, maxSpreadC) {
  if (mid == null || !(maxSpreadC > 0)) return { mid: mid ?? null, bandRadiusC: null, bandLo: null, bandHi: null };
  const r = maxSpreadC / 2;
  return { mid, bandRadiusC: r, bandLo: mid - r / 100, bandHi: mid + r / 100 };
}

/** Existing in-band test: is `price` within the reward band around `mid`? */
function inBand(price, mid, maxSpreadC) {
  if (price == null || mid == null || !(maxSpreadC > 0)) return false;
  return Math.abs(price - mid) * 100 <= maxSpreadC / 2;
}

/** Signed distance-to-mid in cents, for seeding a follow leg's offset at placement. */
function seedOffsetC(price, mid) {
  if (price == null || mid == null) return 0;
  return round((price - mid) * 100, 3);
}

/**
 * A follow leg's offset can exceed the band radius — then its target sits OUTSIDE
 * the band and it can NEVER earn. Surfaced so the UI states that plainly rather
 * than silently accepting it. Returns null when the band is unknown (never a
 * fabricated verdict).
 */
function offsetExceedsBand(offsetC, maxSpreadC) {
  if (!(maxSpreadC > 0) || offsetC == null) return null;
  return Math.abs(offsetC) > maxSpreadC / 2 + 1e-9;
}

/**
 * Target price for a leg given the live mid.
 *   follow → mid + offsetC/100 (tracks mid)
 *   pinned → the literal price (ignores mid)
 * Returns null when the input needed for that mode is missing (never invented).
 */
function legTarget(leg, mid) {
  if (leg.mode === 'pinned') return leg.price != null ? leg.price : null;
  if (mid == null) return null;                       // follow needs a live mid
  const off = Number(leg.offsetC) || 0;
  return round(mid + off / 100, 6);
}

/**
 * Full live status of a leg against the current mid + band. Everything a drift
 * detector or the UI needs, with honest nulls where the live book/band is unknown.
 * NEVER produces a reward number — that is layered on from rewardScore by callers.
 */
function legStatus(leg, mid, maxSpreadC, now) {
  const target = legTarget(leg, mid);
  const inBandNow = inBand(leg.price, mid, maxSpreadC);          // where the quote ACTUALLY rests
  const targetInBand = target != null ? inBand(target, mid, maxSpreadC) : null;
  const driftC = (target != null && leg.price != null) ? round((leg.price - target) * 100, 3) : null;
  // A follow leg with |offset| > radius, or a pinned leg resting outside the band,
  // can never earn — its target is structurally outside the band.
  const neverEarns = leg.mode === 'follow'
    ? offsetExceedsBand(leg.offsetC, maxSpreadC)
    : (maxSpreadC > 0 && leg.price != null ? !inBand(leg.price, mid, maxSpreadC) && !inBand(target, mid, maxSpreadC) : null);
  return {
    book: leg.book, kind: leg.kind, price: leg.price, mode: leg.mode, offsetC: leg.offsetC,
    mid: mid ?? null,
    bandRadiusC: maxSpreadC > 0 ? maxSpreadC / 2 : null,
    targetPrice: target,
    driftC,                       // signed cents: actual - target
    absDriftC: driftC != null ? Math.abs(driftC) : null,
    inBandNow,                    // is the resting quote earning right now?
    targetInBand,                 // would the target earn?
    neverEarns,
    ts: now ?? null,
  };
}

module.exports = { bandFromMid, inBand, seedOffsetC, offsetExceedsBand, legTarget, legStatus, round };
