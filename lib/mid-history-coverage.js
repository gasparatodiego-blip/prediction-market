'use strict';
// lib/mid-history-coverage.js — the ONE definition of the coverage header every mid-history backtest
// MUST print. The mid-history journal (agent34) only covers the markets agent34 subscribes to (bounded
// by SUBSCRIPTION_CAP), a SUBSET of the full rewards universe. A result computed from it therefore
// describes that subset, not the whole lane — and must SAY SO. This function is the single place that
// language lives, so no backtest can silently present a partial-coverage result as representative.
//
// A backtest computes `coveredMarketCount` from the journal slice it analyses (distinct marketId) and
// reads `universeMarketCount` from the coverage manifest agent34 writes at collection time
// (data/mid-history-coverage.json), then calls coverageHeader() and prints headerLines VERBATIM before
// any result.
//
// HONEST-ENGINE / FAIL-HONEST: an unknown universe size does NOT default to 100% coverage. Unknown →
// coverageFraction null, and the result is treated as partial AND below-half (the cautious direction),
// so a missing denominator can never let a result read as full-coverage.

const COVERAGE_FULL_THRESHOLD = 0.5; // below this ⇒ print the explicit "subscribed subset only" statement

function coverageHeader({ coveredMarketCount, universeMarketCount, at = null } = {}) {
  const covered = Number.isFinite(coveredMarketCount) && coveredMarketCount >= 0 ? Math.floor(coveredMarketCount) : null;
  const universe = Number.isFinite(universeMarketCount) && universeMarketCount > 0 ? Math.floor(universeMarketCount) : null;
  const fraction = (covered != null && universe != null) ? covered / universe : null;
  const coveragePct = fraction != null ? Math.round(fraction * 1000) / 10 : null;
  // Unknown denominator ⇒ treat as partial AND below-half (never assume full coverage).
  const partial = (covered != null && universe != null) ? covered < universe : true;
  const belowHalf = fraction != null ? fraction < COVERAGE_FULL_THRESHOLD : true;

  const headerLines = [];
  // The denominator is the COLLECTABLE rewards universe (Kalshi's US-only markets are excluded — see
  // agent34 writeCoverageManifest / Phase 2), so the copy says "collectable", never "full".
  headerLines.push(
    `COVERAGE: ${covered == null ? '—' : covered} of ${universe == null ? '—' : universe} collectable rewards-universe markets` +
    (coveragePct != null ? ` — ${coveragePct}% of the collectable universe` : ' — collectable universe size unknown'),
  );
  if (partial) {
    headerLines.push(
      'PARTIAL COVERAGE: this result covers only the markets agent34 subscribes to and is NOT representative of the whole rewards lane.',
    );
  }
  let subsetOnly = null;
  if (belowHalf) {
    subsetOnly = (covered != null && universe != null)
      ? `Coverage is below 50% — this result describes ONLY the subscribed subset (${covered} of ${universe} markets), not the rewards lane.`
      : 'Coverage is below 50% (or its denominator is unknown) — this result describes ONLY the subscribed subset, not the rewards lane.';
    headerLines.push(subsetOnly);
  }

  return {
    coveredMarketCount: covered,
    universeMarketCount: universe,
    coverageFraction: fraction,
    coveragePct,
    partial,
    belowHalf,
    representative: !partial,   // only a FULL-coverage result may be called representative of the lane
    at,
    headerLines,
    subsetOnly,
  };
}

module.exports = { coverageHeader, COVERAGE_FULL_THRESHOLD };
