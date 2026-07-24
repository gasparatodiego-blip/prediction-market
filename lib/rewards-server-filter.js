'use strict';

/**
 * rewards-server-filter — pure, node-testable filter for the Liquidity Rewards board,
 * applied in the DATA/API layer (app/api/rewards-unified) BEFORE tier redaction.
 *
 * WHY SERVER-SIDE: the old board fetched every row and hid rows in the browser. The free tier
 * has depth/spread redacted to null, so client-side filtering on those fields would be blind.
 * Filtering here — on the real values, before redaction — makes the returned row COUNT correct
 * for every tier, and the payload is genuinely smaller (not fetch-all-and-hide).
 *
 * NO PARALLEL MATH: every scalar a filter reads is derived from the SAME real field the list
 * displays, and each is BALANCE-INDEPENDENT, so the server's value equals the client's at any
 * balance:
 *   - depth (min book depth at touch)  = competitorDepthUsd(m)  — the shown "depth $X", the exact
 *     number lib/liquidity-yield uses as competitorDepth (Qnear + Qopp). Shared via reward-depth-floor.
 *   - competition level                = (1 − rewardScore.refShare) × 100 — the saturation bar value.
 *   - max spread                       = bookSpread × 100 (¢) — the real executable best-ask − best-bid.
 *   - min daily pot                    = dailyPool ($/day) — the real program rate.
 *   - hide thin books                  = a THIN flag stamped by agent24/25.
 *   - venue / category                 = the real fields.
 *
 * HONEST-ENGINE: when a filter is ACTIVE and a row's field is unknown (null), the row CANNOT
 * prove it clears the constraint, so it is EXCLUDED — never treated as 0 or ∞, never fabricated.
 * A filter left at its default imposes no constraint, so null-field rows still show.
 */

const { competitorDepthUsd } = require('./reward-depth-floor');
// Measured band-relative stability, or null when unmeasured. Shared so the server filter, the UI
// cell and the sort all read ONE definition (lib/reward-stability).
const { stabilityOf } = require('./reward-stability');

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The balance-independent scalars each filter reads — derived once, from real fields only. */
function filterScalars(m) {
  const refShare = m && m.rewardScore ? num(m.rewardScore.refShare) : null;
  const spread = num(m && m.bookSpread);
  const flags = m && Array.isArray(m.flags) ? m.flags : [];
  const stab = stabilityOf(m);
  return {
    venue:          m && m.venue,
    category:       (m && m.category) || null,
    poolUsd:        num(m && m.dailyPool),
    depthUsd:       competitorDepthUsd(m),                       // shown "depth", shared math
    competitionPct: refShare == null ? null : (1 - refShare) * 100,
    spreadCents:    spread == null ? null : spread * 100,
    thin:           flags.some((f) => /THIN/i.test(String(f))),
    stabilityScore: stab.known ? stab.score : null,             // null ⇒ unmeasured (never excluded by minStab)
    stability:      stab,                                       // full measurement (label + drivers + reason)
  };
}

/**
 * Parse a URLSearchParams (or a plain object) into a normalized filter state. Unset/blank ⇒ no
 * constraint. Only the six required filters + category are recognized.
 */
function parseRewardFilters(sp) {
  const get = (k) => {
    const v = sp && typeof sp.get === 'function' ? sp.get(k) : sp ? sp[k] : null;
    return v == null || v === '' ? null : String(v);
  };
  const numOr = (k) => {
    const v = get(k);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const venueRaw = (get('venue') || 'all').toLowerCase();
  const venue = venueRaw === 'polymarket' || venueRaw === 'kalshi' ? venueRaw : 'all';
  const cats = get('category');
  const hideThinRaw = get('hideThin');
  return {
    venue,
    categories: cats ? cats.split(',').map((s) => s.trim()).filter(Boolean) : [],
    minPool:            numOr('minPool'),
    minDepth:           numOr('minDepth'),
    maxSpreadCents:     numOr('maxSpread'),
    maxCompetitionPct:  numOr('maxCompetition'),
    hideThin:           hideThinRaw === '1' || hideThinRaw === 'true',
    minStab:            numOr('minStab'),
  };
}

/** True when a market passes every active constraint. */
function passes(m, f) {
  const s = filterScalars(m);
  if (f.venue && f.venue !== 'all' && s.venue !== f.venue) return false;
  if (f.categories && f.categories.length && !f.categories.includes(s.category)) return false;
  if (f.minPool != null && f.minPool > 0) {
    if (s.poolUsd == null || s.poolUsd < f.minPool) return false;
  }
  if (f.minDepth != null && f.minDepth > 0) {
    if (s.depthUsd == null || s.depthUsd < f.minDepth) return false;
  }
  if (f.maxSpreadCents != null) {
    if (s.spreadCents == null || s.spreadCents > f.maxSpreadCents) return false;
  }
  if (f.maxCompetitionPct != null && f.maxCompetitionPct < 100) {
    if (s.competitionPct == null || s.competitionPct > f.maxCompetitionPct) return false;
  }
  if (f.hideThin && s.thin) return false;
  // "Stabilità minima" — the ONE filter that does NOT exclude an unknown-field row. An unmeasured
  // market is not a proven-unstable market; hiding it behind a stability floor would assert
  // something we never measured. Only a row with a KNOWN score BELOW the floor is removed; the
  // unmeasured rows stay visible with an honest "—".
  if (f.minStab != null && f.minStab > 0) {
    if (s.stabilityScore != null && s.stabilityScore < f.minStab) return false;
  }
  return true;
}

function applyRewardFilters(markets, f) {
  const list = Array.isArray(markets) ? markets : [];
  return list.filter((m) => passes(m, f));
}

/**
 * Full-set slider ranges + chip option sets, computed over ALL rows (pre-filter) so tightening
 * one filter never shrinks another's range. Real values only; a range is 0 / a set empty when
 * no row carries that field. hasCompetition drives the competition slider's enabled/disabled state.
 */
function deriveRanges(markets) {
  const list = Array.isArray(markets) ? markets : [];
  const scal = list.map(filterScalars);
  const maxOf = (xs) => (xs.length ? Math.max(...xs) : 0);
  const pools   = scal.map((s) => s.poolUsd).filter((v) => v != null);
  const depths  = scal.map((s) => s.depthUsd).filter((v) => v != null);
  const spreads = scal.map((s) => s.spreadCents).filter((v) => v != null);
  return {
    poolMax:        Math.ceil(maxOf(pools)),
    depthMax:       Math.ceil(maxOf(depths)),
    spreadMaxCents: Math.ceil(maxOf(spreads)),
    categories:     [...new Set(scal.map((s) => s.category).filter(Boolean))].sort(),
    venues:         [...new Set(scal.map((s) => s.venue).filter(Boolean))].sort(),
    hasCompetition: scal.some((s) => s.competitionPct != null),
    // Stability slider is a fixed 0–100 scale; hasStability drives whether ANY row carries a measured
    // score (false ⇒ the whole feed is unmeasured/redacted and the cell renders "—" everywhere).
    stabMax:        100,
    hasStability:   scal.some((s) => s.stabilityScore != null),
  };
}

module.exports = { filterScalars, parseRewardFilters, applyRewardFilters, deriveRanges };
