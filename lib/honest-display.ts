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
