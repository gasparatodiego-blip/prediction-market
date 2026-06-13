export declare const HOURS_PER_YEAR: number;
export declare const VENUE_FEE_PCT: { cex: number; dex: number };
export declare function annualize(ratePerInterval: number, intervalHours: number): number;
export declare function roundTripFee(shortIsDex: boolean, longIsDex: boolean): number;
export declare function netApy30d(grossApy: number, totalFeesPct: number): number;
export declare function breakevenDays(grossApy: number, totalFeesPct: number): number;
export declare function spreadStatus(beDays: number): 'HARVEST' | 'CAUTION' | 'MARGINAL';
