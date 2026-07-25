'use strict';

/**
 * rewards-filter — pure filter/sort/derive for the Liquidity Rewards list surface.
 *
 * No React, no fetch, no imports: it is unit-testable in node against enriched reward
 * rows and is shared VERBATIM by the RewardsUnified component, so the list the user sees
 * and any measurement of the filter logic can never diverge (mirrors lib/carry-filter.js).
 *
 * It operates on ENRICHED rows — plain objects the component builds from each market's
 * REAL rewardScore block (lib/rewards-normalize + lib/rewardScore), so this file never
 * re-derives a number:
 *   { category, venue, poolDayUsd, saturation, apr, capacityUsd, netUsdPerDay, isTrap }
 *   - poolDayUsd   = rewardScore.poolDay     (real reward pool $/day)
 *   - netUsdPerDay = poolDay × refShare      (GROSS reward/day, measured/observed)
 *   - apr          = annualized(net), capped 200% by the honest-engine ceiling
 *   - capacityUsd  = bookDepthAtBand         (real book depth at the reward band)
 *   - saturation   = 1 - refShare            (MEASURED for Polymarket via the published
 *                    quadratic score from the live CLOB book; OBSERVED flat pro-rata for
 *                    Kalshi; null when the book/pool can't be scored — never fabricated)
 *   - isTrap       = flags includes 'TRAP'
 *
 * HONEST-ENGINE: a row missing a given filter's field is EXCLUDED from that filter when the
 * filter is ACTIVE (a null apr cannot clear a min; a null saturation cannot prove it is
 * under a max) — never fabricated, never treated as zero. Sliders at their default
 * (off) position impose no constraint, so null-field rows still show.
 */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** Derive chip option sets + slider ranges from the LIVE enriched rows (never hardcoded). */
function deriveOptions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const pool = list.map((r) => num(r.poolDayUsd)).filter((v) => v != null);
  const apr  = list.map((r) => num(r.apr)).filter((v) => v != null);
  const cap  = list.map((r) => num(r.capacityUsd)).filter((v) => v != null);
  return {
    categories: uniq(list.map((r) => r.category)),
    venues:     uniq(list.map((r) => r.venue)),
    poolMax: pool.length ? Math.max(...pool) : 0,
    aprMax:  apr.length  ? Math.max(...apr)  : 0,
    capMax:  cap.length  ? Math.max(...cap)  : 0,
    // Whether ANY row carries a derived saturation — false means the whole feed is
    // redacted/unmeasured and the saturation filter should render disabled with a note.
    hasSaturation: list.some((r) => num(r.saturation) != null),
  };
}

/** Unconstraining default state. maxSaturationPct = 100 ⇒ competition filter off. */
function defaultState() {
  return {
    categories: [],       // empty = all categories
    venues: [],           // empty = all venues
    minPool: 0,
    maxSaturationPct: 100, // ≤100% = no constraint (off)
    minApr: 0,
    minCapacity: 0,
    hideTrap: false,
    sortByPool: false,     // default sort = net $/day; toggle = reward pool (desc)
    sortDir: 'desc',       // net $/day direction: 'desc' high→low (default) | 'asc' low→high
  };
}

/** Apply every filter on the real/derived enriched fields. */
function applyFilters(rows, s) {
  const list = Array.isArray(rows) ? rows : [];
  const st = s || {};
  return list.filter((r) => {
    if (st.categories && st.categories.length && !st.categories.includes(r.category)) return false;
    if (st.venues && st.venues.length && !st.venues.includes(r.venue)) return false;
    if (st.minPool > 0) {
      const p = num(r.poolDayUsd);
      if (p == null || p < st.minPool) return false;
    }
    // Max pool competition (saturation). Only constrains when the user tightens below
    // 100%; when active, a row whose saturation is unknown cannot prove it is under the
    // cap, so it is excluded (honest — never treated as 0% open).
    if (typeof st.maxSaturationPct === 'number' && st.maxSaturationPct < 100) {
      const sat = num(r.saturation);
      if (sat == null || sat * 100 > st.maxSaturationPct) return false;
    }
    if (st.minApr > 0) {
      const a = num(r.apr);
      if (a == null || a < st.minApr) return false;
    }
    if (st.minCapacity > 0) {
      const c = num(r.capacityUsd);
      if (c == null || c < st.minCapacity) return false;
    }
    if (st.hideTrap && r.isTrap) return false;
    return true;
  });
}

/**
 * Sort the list on the value the engine ALREADY computed (never recomputed here).
 *   - key = reward pool when sortByPool, else net $/day.
 *   - The ▲/▼ arrows are the NET $/DAY direction control: 'asc' low→high, else 'desc'
 *     high→low (default). Reward-pool sort stays descending (its own toggle, no arrows).
 *   - HONEST-ENGINE: a null/withheld key is NOT treated as 0 or ∞ — it is pinned LAST in
 *     BOTH directions, and equal/null rows keep their input order (Array.sort is stable),
 *     so the non-numeric group never interleaves with the numeric run.
 */
function sortRows(rows, s) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  // DEMOTION TIER (honest-engine): a row flagged potTooSmall (its reward pot is below the floor,
  // so a high pool-share of it is not an opportunity — see RewardsUnified POT_DEMOTE_FLOOR_USD) is
  // ranked BELOW every non-demoted row in EVERY sort mode, so a "98% of $11/day" row can never sort
  // above a real-pot row. Its value is NOT rewritten — it is only moved down and labelled. Rows
  // without the flag (other callers) are never demoted. Applied as the primary key; the mode key
  // orders within each tier (Array.sort is stable, so input order breaks ties inside a tier).
  const demoted = (r) => !!(r && r.potTooSmall);
  const tier = (a, b) => (demoted(a) === demoted(b) ? 0 : demoted(a) ? 1 : -1);
  // New terminal sort modes: 'stability' | 'day' | 'expiry'. Falls back to the legacy pool/$-day
  // behaviour when sortMode is absent, so existing callers are unchanged. A null/withheld key is
  // ALWAYS pinned last (never treated as 0 or ∞); Array.sort is stable so ties keep input order.
  const mode = s && s.sortMode;
  if (mode === 'stability' || mode === 'day' || mode === 'expiry') {
    // key + direction per mode. stability: high→low. $/day: high→low (asc flips). expiry: soonest first.
    const key = mode === 'stability' ? 'stabilityScore' : mode === 'expiry' ? 'hoursToResolution' : 'netUsdPerDay';
    const asc = mode === 'expiry' ? true : (s && s.sortDir === 'asc');
    arr.sort((a, b) => {
      const t = tier(a, b);
      if (t !== 0) return t;      // demoted (tiny pot) rows always below non-demoted, every mode
      const ka = num(a[key]);
      const kb = num(b[key]);
      if (ka == null && kb == null) return 0;
      if (ka == null) return 1;   // unmeasured / withheld → last in every mode (incl. stability "—")
      if (kb == null) return -1;
      return asc ? ka - kb : kb - ka;
    });
    return arr;
  }
  const byPool = !!(s && s.sortByPool);
  const key = byPool ? 'poolDayUsd' : 'netUsdPerDay';
  const asc = !byPool && s && s.sortDir === 'asc';
  arr.sort((a, b) => {
    const t = tier(a, b);
    if (t !== 0) return t;        // demoted (tiny pot) rows always below non-demoted
    const ka = num(a[key]);
    const kb = num(b[key]);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1;   // null/withheld pinned last, both directions
    if (kb == null) return -1;
    return asc ? ka - kb : kb - ka;
  });
  return arr;
}

/** Saturation → {pct, band, label} for the bar. null → null (caller hides/disables bar). */
function saturationView(saturation) {
  const s = num(saturation);
  if (s == null) return null;
  const pct = Math.max(0, Math.min(100, s * 100));
  const band = pct >= 70 ? 'red' : pct >= 40 ? 'amber' : 'green';
  const label = pct >= 70 ? 'saturated' : pct >= 40 ? 'filling' : 'open';
  return { pct, band, label };
}

module.exports = { deriveOptions, defaultState, applyFilters, sortRows, saturationView };
