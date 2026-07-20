'use strict';

/**
 * carry-display — presentation transforms for the Cash & Carry (basis) card surface.
 *
 * DELIBERATELY THIN. Everything that already exists elsewhere is imported, not restated:
 *
 *   - basis / net-of-fee annualized  → agent19-basis (the measured source of truth)
 *   - APY cap + label                → lib/honest-display via carry-optimize.loadApyCap()
 *   - risk-free reference            → lib/carry-optimize.RISK_FREE_PCT
 *   - capacity min(legs) + binding   → lib/carry-optimize (capacityUsd, capacityBoundBy)
 *
 * Only two things are genuinely new here, because nothing else computes them:
 *   1. net $/day at a stated capital basis (the tab's PRIMARY metric)
 *   2. convergence progress toward settlement (the fill bar)
 *
 * Re-deriving basis, the APY cap, or the binding leg in this file would create a second
 * math path that could disagree with the agent — the split-brain the honest engine exists
 * to prevent — so this module refuses to own any of them.
 */

const { RISK_FREE_PCT } = require('./carry-optimize');

const CARRY_CAPITAL_BASIS = 1000;   // $ deployed — house convention, matches the landing rows
const DAYS_PER_YEAR       = 365;

/**
 * Net $/day for `capitalUsd` deployed, from the agent's net annualized FRACTION.
 *
 * This is the tab's primary number precisely because it is small and honest: at the
 * measured 2026-07-20 ceiling of 4.06%/yr, $1,000 deployed earns ~$0.11/day. Leading with
 * "4.06%/yr" instead would dress the same figure up as something it is not.
 *
 * @param {number|null} netAnnualizedFraction e.g. 0.0406 for 4.06%/yr
 * @returns {number|null} null when input is not finite — never 0 standing in for unknown.
 */
function netUsdPerDay(netAnnualizedFraction, capitalUsd = CARRY_CAPITAL_BASIS) {
  if (typeof netAnnualizedFraction !== 'number' || !Number.isFinite(netAnnualizedFraction)) return null;
  return (netAnnualizedFraction * capitalUsd) / DAYS_PER_YEAR;
}

/**
 * Convergence progress toward settlement.
 *
 * `tenorDays` is NOT the contract's listed life. No venue in this pipeline publishes a
 * listing date, so that number does not exist in our data and inventing it would be
 * fabrication. It is instead daysToExpiry at OUR FIRST RECORDED OBSERVATION of the
 * contract (from data/history/basis). That denominator is fully traceable, rises
 * monotonically, and reaches exactly 100% at expiry — so the bar is honest provided the
 * caption says "since first observed", which it does.
 *
 * @returns {{elapsedDays:number, tenorDays:number, fraction:number}|null}
 *   null when there is no first observation — the caller must render "—", not a guess.
 */
function convergence(tenorDays, daysToExpiry) {
  if (typeof tenorDays !== 'number' || typeof daysToExpiry !== 'number') return null;
  if (!Number.isFinite(tenorDays) || !Number.isFinite(daysToExpiry) || tenorDays <= 0) return null;
  const elapsed = Math.max(0, tenorDays - daysToExpiry);
  return {
    elapsedDays: Math.round(elapsed),
    tenorDays:   Math.round(tenorDays),
    fraction:    Math.max(0, Math.min(1, elapsed / tenorDays)),
  };
}

/** true when this carry earns less than simply holding T-bills. */
function isBelowRiskFree(annualizedPct) {
  return typeof annualizedPct === 'number' && Number.isFinite(annualizedPct) && annualizedPct < RISK_FREE_PCT;
}

module.exports = {
  CARRY_CAPITAL_BASIS, DAYS_PER_YEAR,
  RISK_FREE_PCT,          // re-exported from carry-optimize so callers have one import
  netUsdPerDay, convergence, isBelowRiskFree,
};
