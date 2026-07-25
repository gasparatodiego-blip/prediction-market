'use strict';
// lib/maker/worth-it.js — the "vale la pena?" VERDICT for one reward market at one configured size.
//
// WHY THIS EXISTS: the board and the ticket both showed a gross $/day and left the operator to work out
// whether that number was worth touching. It usually is not. A market whose whole daily pot is $27 and
// whose competing depth is 75k pays cents at a retail size, and the modelled adverse-selection cost on
// the same position is an order of magnitude larger. The number was never wrong; it was never enough.
//
// NO PARALLEL MATH. Every input is computed elsewhere and passed in:
//   grossPerDay        ← lib/reward-price-row.computePriceRow (published quadratic vs the feed's competitorQ)
//   adverseCostPerDay  ← lib/rewards-estimate.estimateReward().adverseSelectionCost (a MODEL, labelled)
//   ownImpactPct       ← computePriceRow.ownImpactPct (your size / real in-band depth)
//   perSideShares/minSize ← the venue's own min_incentive_size
// This module only COMPARES them and names the reason. It computes no reward and no cost of its own.
//
// HONEST-ENGINE: the verdict never publishes a NET number. The adverse cost is a model estimate with a
// 2–5% conservative band (lib/rewards-estimate ADVERSE_FLOOR/ADVERSE_CEIL) — good enough to say "this
// is not worth it", not good enough to print as a net. Callers render net as "—" and show this reason.
//
// FAIL CLOSED on ignorance, but in the honest direction: an unreadable gross is 'unknown' (never 'ok').

// The venue payout floor. MIRRORS lib/rewards-estimate.ts MIN_PAYOUT_USD (line ~38) — Polymarket and
// Kalshi do not pay a sub-$1/day accrual. Duplicated only because that file is TypeScript and this one
// must be require()-able from the node agents; scripts/maker-unified-selfcheck.js asserts they agree.
const MIN_PAYOUT_USD = 1.0;

// Own-impact bands, the SAME thresholds lib/reward-price-row.ownImpactBand uses:
// <5% low (green) · 5–20% mid (amber) · >20% high (red — "you become the book").
const OWN_IMPACT_HIGH_PCT = 20;

const CODES = Object.freeze({
  BELOW_MIN_SIZE: 'BELOW_MIN_SIZE',           // per-side order under min_incentive_size ⇒ earns nothing
  GROSS_BELOW_FLOOR: 'GROSS_BELOW_FLOOR',     // pool too small / too much competing depth for this size
  ADVERSE_EXCEEDS_GROSS: 'ADVERSE_EXCEEDS_GROSS', // modelled adverse cost ≥ the gross it would earn
  OWN_IMPACT_HIGH: 'OWN_IMPACT_HIGH',         // you are most of the book — the share is a ceiling
  UNREADABLE: 'UNREADABLE',                   // gross could not be computed ⇒ no verdict, never "ok"
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function usd(n) { return `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`; }

/**
 * @param {object} args
 *   grossPerDay        expected GROSS reward $/day at the configured size, or null
 *   adverseCostPerDay  modelled adverse-selection cost $/day at the same size, or null
 *   ownImpactPct       your total size as a % of the real in-band depth, or null
 *   perSideShares      shares resting per side at the configured size, or null
 *   minSize            the venue's min_incentive_size in shares, or null
 *   poolDay            the market's daily pot (for the reason text only), or null
 *   floorUsdPerDay     override the payout floor (defaults to MIN_PAYOUT_USD)
 * @returns {{verdict:'ok'|'thin'|'no'|'unknown', worthIt:(boolean|null), headline:string,
 *            reasons:Array<{code:string,detail:string}>, floorUsdPerDay:number}}
 */
function computeWorthIt({
  grossPerDay = null,
  adverseCostPerDay = null,
  ownImpactPct = null,
  perSideShares = null,
  minSize = null,
  poolDay = null,
  floorUsdPerDay = MIN_PAYOUT_USD,
} = {}) {
  const reasons = [];
  const floor = fin(floorUsdPerDay) && floorUsdPerDay > 0 ? floorUsdPerDay : MIN_PAYOUT_USD;

  // 1. Below the venue's min_incentive_size ⇒ the order rests but scores nothing. Checked FIRST because
  //    it invalidates the gross above it: a gross computed for a size that cannot qualify is moot.
  const belowMin = fin(perSideShares) && fin(minSize) ? perSideShares < minSize : null;
  if (belowMin === true) {
    reasons.push({
      code: CODES.BELOW_MIN_SIZE,
      detail: `sotto la size minima del venue: ${Math.round(perSideShares)} quote per lato contro ${Math.round(minSize)} richieste — l'ordine riposa ma non matura premio`,
    });
  }

  if (!fin(grossPerDay)) {
    reasons.push({ code: CODES.UNREADABLE, detail: 'lordo non calcolabile con i dati letti — nessun verdetto (mai "conviene" per assenza di dati)' });
    return { verdict: 'unknown', worthIt: null, headline: 'non valutabile', reasons, floorUsdPerDay: floor };
  }

  // 2. Gross under the venue payout floor ⇒ the accrual likely pays nothing at all.
  if (grossPerDay < floor) {
    reasons.push({
      code: CODES.GROSS_BELOW_FLOOR,
      detail: `lordo ${usd(grossPerDay)}/giorno sotto la soglia di pagamento ${usd(floor)}/giorno`
        + (fin(poolDay) ? ` — il montepremi dell'intero mercato è ${usd(poolDay)}/giorno e la profondità concorrente se lo divide` : ''),
    });
  }

  // 3. The modelled adverse-selection cost swallows the gross. This is the Kamala case: the reward is
  //    real, and it is smaller than what being picked off is modelled to cost on the same position.
  if (fin(adverseCostPerDay) && adverseCostPerDay >= grossPerDay) {
    reasons.push({
      code: CODES.ADVERSE_EXCEEDS_GROSS,
      detail: `costo di adverse selection stimato ${usd(adverseCostPerDay)}/giorno contro un lordo di ${usd(grossPerDay)}/giorno — il netto atteso è negativo (stima modellata, banda 2–5%)`,
    });
  }

  // 4. You would BE the book. Not a refusal — a ceiling warning: the share assumes nobody re-quotes.
  if (fin(ownImpactPct) && ownImpactPct > OWN_IMPACT_HIGH_PCT) {
    reasons.push({
      code: CODES.OWN_IMPACT_HIGH,
      detail: `la tua size è il ${ownImpactPct.toFixed(0)}% della profondità premiante — diventi tu il book, e la quota mostrata è un tetto ottimistico (assume che nessuno ri-quoti)`,
    });
  }

  const blocking = reasons.some((r) =>
    r.code === CODES.BELOW_MIN_SIZE || r.code === CODES.GROSS_BELOW_FLOOR || r.code === CODES.ADVERSE_EXCEEDS_GROSS);
  const verdict = blocking ? 'no' : reasons.length ? 'thin' : 'ok';
  const headline = blocking
    ? 'non conviene'
    : verdict === 'thin'
      ? 'conviene, con una riserva'
      : 'conviene alla size configurata';

  return { verdict, worthIt: verdict === 'ok' || verdict === 'thin', headline, reasons, floorUsdPerDay: floor };
}

module.exports = { computeWorthIt, CODES, MIN_PAYOUT_USD, OWN_IMPACT_HIGH_PCT };
