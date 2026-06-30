// lib/honest-display.ts — shared honest-engine display rule for annualized/derived rates.
//
// Any surface that projects a measured rate (a daily yield, a 30-day-amortized
// funding spread, etc.) out to %/yr must run it through here. Never print a raw
// annualized number above the cap as if it were a guaranteed yield.
export const APY_CAP = 200; // %/yr — ceiling for any annualized/derived rate shown to a user
export const APY_CAP_LABEL = '>200%/yr · run-rate, not guaranteed';

export function isOverApyCap(annualPct: number): boolean {
  return annualPct > APY_CAP;
}

// Shared capital basis for the landing "live inside" rows — every row's $/day
// figure is shown per this many dollars deployed, so a visitor can compare
// rows directly instead of mentally converting between different capital tiers.
export const LANDING_CAPITAL_BASIS = 1000; // $

/** Linearly re-express a $/day figure measured at one capital tier at another.
 *  Valid wherever the measured rate is ~proportional to capital (funding-spread
 *  $/day and reward $/day both are, at the tiers this page reads). */
export function scaleToCapitalBasis(
  amountAtCapital: number,
  fromCapital: number,
  toCapital: number = LANDING_CAPITAL_BASIS,
): number {
  if (fromCapital <= 0) return 0;
  return amountAtCapital * (toCapital / fromCapital);
}
