/**
 * Borrow cost for the SHORT-SPOT leg of a REVERSE cash & carry.
 *
 * Normal (contango) carry is buy-spot / short-future: nothing is borrowed, so the only
 * cost is fees. REVERSE carry — for backwardation, where the future trades BELOW spot —
 * is sell-spot / buy-future, and selling spot you do not own means BORROWING it. That
 * borrow accrues interest for the whole hold, which is a real, often dominant cost.
 *
 * Quoting a reverse carry without it would overstate the return, so this module exists
 * to make sure the number is either included or the row is not called cashable.
 *
 * ── SOURCE PROVENANCE (read this before trusting the number) ─────────────────
 * Binance's DOCUMENTED margin endpoints are auth-gated and return -2014 without a key:
 *   /sapi/v1/margin/interestRateHistory
 *   /sapi/v1/margin/crossMarginData
 * The rates here come from `bapi`, Binance's UNDOCUMENTED internal web endpoint. It
 * responds unauthenticated and returns real per-asset, per-VIP-tier daily rates, but it
 * is not a published API: it carries no compatibility guarantee and can change shape or
 * vanish without notice.
 *
 * So it is tagged UNDOCUMENTED_PUBLIC, never OFFICIAL_PUBLIC_API — the same distinction
 * lib/quote-risk and data/venue-fees-official.json draw. A reverse row priced off this
 * is honest about where its cost estimate came from, and a consumer can down-weight it.
 * VIP 0 is used: the worst tier any account gets, so the cost is not understated.
 */

const BAPI_URL = 'https://www.binance.com/bapi/margin/v1/public/margin/vip/spec/list-all';

const SOURCE = {
  url: BAPI_URL,
  provenance: 'UNDOCUMENTED_PUBLIC',
  tier: 'VIP 0',
  note: 'Binance internal bapi endpoint — responds unauthenticated but is not a published '
      + 'API and carries no compatibility guarantee. The documented /sapi margin rate '
      + 'endpoints require an API key. VIP 0 is the worst tier, so the cost is not understated.',
};

/**
 * Parse the bapi payload into { ASSET: { dailyRate, annualizedPct } }.
 * Anything unparseable is omitted rather than defaulted — a missing borrow rate must
 * surface as UNKNOWN, never as zero, because zero would imply free shorting.
 */
function parseBorrowRates(payload) {
  const out = {};
  const rows = payload && payload.data;
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const asset = r && r.assetName;
    const specs = r && r.specs;
    if (!asset || !Array.isArray(specs)) continue;
    const vip0 = specs.find(s => String(s.vipLevel) === '0');
    if (!vip0) continue;
    const daily = parseFloat(vip0.dailyInterestRate);
    if (!Number.isFinite(daily) || daily < 0) continue;
    out[asset] = {
      dailyRate: daily,
      annualizedPct: daily * 365 * 100,
      borrowLimit: parseFloat(vip0.borrowLimit) || null,
    };
  }
  return out;
}

/**
 * Price a reverse cash & carry.
 *
 * Backwardation basis is negative (future below spot); selling spot and buying the
 * future captures its magnitude as the future converges UP to spot at expiry. Against
 * that sits the borrow cost for the whole hold, plus the same round-trip taker fees the
 * forward carry pays.
 *
 * Returns cashable:false with an explicit reason whenever the number cannot be stood
 * behind — missing borrow rate, or a net that does not clear zero. A reverse row is
 * never presented as cashable on an incomplete cost picture.
 *
 * @param {number} executableBasisPct  negative for backwardation
 * @param {number} daysToExpiry
 * @param {number} feePct              round-trip taker fee (same table as forward carry)
 * @param {object|null} borrow         { annualizedPct } for the borrowed asset, or null
 */
function priceReverseCarry({ executableBasisPct, daysToExpiry, feePct, borrow }) {
  if (!(daysToExpiry > 0) || !Number.isFinite(executableBasisPct)) {
    return { cashable: false, reason: 'MISSING_INPUTS', grossAnnualizedPct: null,
             borrowAnnualizedPct: null, netAnnualizedPct: null };
  }

  // Magnitude of the backwardation, annualized — what convergence pays back.
  const grossAnnualizedPct = Math.abs(executableBasisPct) * 365 / daysToExpiry * 100;
  const feeAnnualizedPct   = (feePct ?? 0) * 365 / daysToExpiry * 100;

  if (!borrow || !Number.isFinite(borrow.annualizedPct)) {
    return {
      cashable: false,
      reason: 'BORROW_COST_UNKNOWN',
      grossAnnualizedPct,
      feeAnnualizedPct,
      borrowAnnualizedPct: null,
      netAnnualizedPct: null,   // deliberately null, NOT gross — an unpriced cost is not zero
      label: 'Signal only — borrow cost for the short-spot leg is not priceable, so no net is shown.',
    };
  }

  const borrowAnnualizedPct = borrow.annualizedPct;
  const netAnnualizedPct = grossAnnualizedPct - borrowAnnualizedPct - feeAnnualizedPct;

  return {
    cashable: netAnnualizedPct > 0,
    reason: netAnnualizedPct > 0 ? null : 'NEGATIVE_AFTER_BORROW',
    grossAnnualizedPct,
    feeAnnualizedPct,
    borrowAnnualizedPct,
    netAnnualizedPct,
    label: netAnnualizedPct > 0
      ? null
      : `Signal only — the ${grossAnnualizedPct.toFixed(2)}%/yr backwardation does not cover the `
      + `${borrowAnnualizedPct.toFixed(2)}%/yr cost of borrowing spot to short it `
      + `(plus ${feeAnnualizedPct.toFixed(2)}%/yr fees). Net ${netAnnualizedPct.toFixed(2)}%/yr.`,
  };
}

module.exports = { BAPI_URL, SOURCE, parseBorrowRates, priceReverseCarry };
