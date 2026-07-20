'use strict';

/**
 * carry-filter — pure filter/sort/derive for the Cash & Carry list surface.
 *
 * No React, no fetch, no imports: it is unit-testable in node against real /api/carry
 * rows and is shared VERBATIM by the CashCarryBasis component, so the list the user sees
 * and any measurement of the filter logic can never diverge.
 *
 * HONEST-ENGINE: operates ONLY on fields the API already emits. A row missing a given
 * filter's field is EXCLUDED from that filter (a null annualized cannot clear a min, a
 * null capacity cannot clear a floor) — never fabricated, never treated as zero.
 */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** Direction bucket from the row's real direction string ('contango' | 'backwardation'). */
function directionOf(row) {
  const d = String(row && row.direction != null ? row.direction : '').toLowerCase();
  if (!d) return null;
  return d.includes('backward') ? 'backwardation' : 'contango';
}

/** Derive chip option sets + slider ranges from the LIVE rows (never hardcoded). */
function deriveOptions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const ann = list.map((r) => num(r.annualizedPct)).filter((v) => v != null);
  const cap = list.map((r) => num(r.capacityUsd)).filter((v) => v != null);
  const dte = list.map((r) => num(r.daysToExpiry)).filter((v) => v != null);
  return {
    assets:     uniq(list.map((r) => r.asset)),
    venues:     uniq(list.map((r) => r.venue)),
    directions: uniq(list.map(directionOf)),
    annMax: ann.length ? Math.max(...ann) : 0,
    capMax: cap.length ? Math.max(...cap) : 0,
    dteMin: dte.length ? Math.min(...dte) : 0,
    dteMax: dte.length ? Math.max(...dte) : 0,
  };
}

/** Unconstraining default state, sized to the live ranges. */
function defaultState(opts) {
  const o = opts || {};
  return {
    assets: [],             // empty = all assets
    venues: [],             // empty = all venues
    directions: [],         // empty = both directions
    minAnnualized: 0,
    minCapacity: 0,
    maxDays: typeof o.dteMax === 'number' ? o.dteMax : Infinity,
    expiring30: false,
    aboveRiskFreeOnly: false,
    sortByLowestFee: false,
  };
}

/** Apply every filter. riskFreePct drives the "above risk-free only" toggle. */
function applyFilters(rows, s, riskFreePct) {
  const list = Array.isArray(rows) ? rows : [];
  const st = s || {};
  const rf = typeof riskFreePct === 'number' ? riskFreePct : 4;
  return list.filter((r) => {
    if (st.assets && st.assets.length && !st.assets.includes(r.asset)) return false;
    if (st.venues && st.venues.length && !st.venues.includes(r.venue)) return false;
    if (st.directions && st.directions.length) {
      const d = directionOf(r);
      if (!d || !st.directions.includes(d)) return false;
    }
    if (st.minAnnualized > 0) {
      const a = num(r.annualizedPct);
      if (a == null || a < st.minAnnualized) return false;
    }
    if (st.minCapacity > 0) {
      const c = num(r.capacityUsd);
      if (c == null || c < st.minCapacity) return false;
    }
    if (typeof st.maxDays === 'number' && Number.isFinite(st.maxDays)) {
      const dd = num(r.daysToExpiry);
      if (dd == null || dd > st.maxDays) return false;
    }
    if (st.expiring30) {
      const dd = num(r.daysToExpiry);
      if (dd == null || dd > 30) return false;
    }
    if (st.aboveRiskFreeOnly) {
      const a = num(r.annualizedPct);
      if (a == null || a < rf) return false;
    }
    return true;
  });
}

/** Default sort = net $/day desc; toggle = lowest fee first. Null keys always sort last. */
function sortRows(rows, s) {
  const arr = Array.isArray(rows) ? [...rows] : [];
  const key = (s && s.sortByLowestFee) ? 'feeUsd' : 'netUsdPerDay';
  const dir = (s && s.sortByLowestFee) ? 1 : -1; // fee asc, net desc
  arr.sort((a, b) => {
    const ka = num(a[key]);
    const kb = num(b[key]);
    if (ka == null && kb == null) return 0;
    if (ka == null) return 1;
    if (kb == null) return -1;
    return dir * (ka - kb);
  });
  return arr;
}

module.exports = { directionOf, deriveOptions, defaultState, applyFilters, sortRows };
