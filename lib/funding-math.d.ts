export declare const HOURS_PER_YEAR: number;
export declare const VENUE_FEE_PCT: { cex: number; gateio: number; bitget: number; dex: number; dydx: number; aster: number; paradex: number; edgex: number; grvt: number; lighter: number; extended: number; pacifica: number; apex: number };
export declare function annualize(ratePerInterval: number, intervalHours: number): number;
export declare function venueFeePct(exchange: string): number;
export declare function roundTripFee(shortIsDex: boolean, longIsDex: boolean): number;
export declare function roundTripFeeByVenue(shortVenue: string, longVenue: string): number;
export declare function netApy30d(grossApy: number, totalFeesPct: number): number;
export declare function breakevenDays(grossApy: number, totalFeesPct: number): number;
export declare function spreadStatus(beDays: number): 'HARVEST' | 'CAUTION' | 'MARGINAL';

export declare const SPOT_FEE_PCT: { binance: number; okx: number; bybit: number; gateio: number };
export declare const USDC_M_FEE_PCT: { 'binance-usdc': number; 'bybit-usdc': number; 'bitget-usdc': number };
export declare const PERP_SPOT_ANNUAL_CAP: number;
export declare function spotVenueFeePct(exchange: string): number;
export declare function usdcVenueFeePct(venue: string): number | null;
export declare function roundTripPerpSpotPct(shortVenue: string, spotVenue: string): number;
export interface PerpSpotEstimate {
  capitalPerLeg: number;
  capitalNeeded: number;
  fundingFractionPerDay: number;
  grossPctPerDayNotional: number;
  grossPerDay: number;
  perpFeePct: number;
  spotFeePct: number;
  feesOneTimePct: number;
  feesOneTime: number;
  breakevenDays: number;
  netPerDayAmortized30: number;
  annualizedRunRatePct: number;
  annualizedCapped: boolean;
  netAnnualizedOnCapitalPct: number;
  trailingPositiveSettlements: number;
  flipRisk: boolean;
}
export declare function estimatePerpSpot(input: {
  capitalPerLeg: number;
  fundingPct8h: number;
  shortVenue: string;
  spotVenue: string;
  trailingPositiveSettlements?: number;
}): PerpSpotEstimate;
