// Types for lib/maker/venue-rules.js — the shared venue-rules validator (Part B1–B3).

export type ReasonCode =
  | 'OFF_TICK'
  | 'OUT_OF_BAND'
  | 'BELOW_MIN_SIZE'
  | 'PRICE_OUT_OF_RANGE'
  | 'RULES_UNREADABLE';

// The validator is fail-closed: any missing/null rule → RULES_UNREADABLE. So the INPUT type is
// deliberately permissive (nullable fields welcome); the check happens at runtime, not in the types.
export interface VenueRules {
  tick?: number | null;
  scoringMid?: number | null;
  maxSpreadCents?: number | null;
  minSize?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
}

export interface Quote {
  side?: 'BUY' | 'SELL';
  price?: number | null;
  size?: number | null;
}

export interface Reason {
  code: ReasonCode;
  detail: string;
  leg?: 'bid' | 'ask';
}

export interface QuoteVerdict {
  valid: boolean;
  reasons: Reason[];
}

export interface PairVerdict {
  valid: boolean;
  degraded: boolean;
  both: boolean;
  bid: QuoteVerdict;
  ask: QuoteVerdict;
  weakerSide: 'bid' | 'ask' | 'both' | null;
  reasons: Reason[];
  note: string;
}

export const CODES: Record<ReasonCode, ReasonCode>;
export function validateQuote(rules: Partial<VenueRules> | null | undefined, quote: Partial<Quote> | null | undefined): QuoteVerdict;
export function validateQuotePair(
  rules: Partial<VenueRules> | null | undefined,
  bid: Partial<Quote> | null | undefined,
  ask: Partial<Quote> | null | undefined,
): PairVerdict;
/** Separa i motivi BLOCCANTI da quelli solo dichiarati. Con allowOutOfBand:true il codice OUT_OF_BAND
 *  scende da bloccante ad `advisories` (non viene mai perso); ogni altro codice resta bloccante. */
export function splitVerdict(
  verdict: QuoteVerdict | null | undefined,
  opts?: { allowOutOfBand?: boolean },
): { valid: boolean; reasons: Reason[]; advisories: Reason[]; outOfBand: boolean };
export function isOnTick(price: number, tick: number): boolean;
export function rulesReadable(rules: unknown): boolean;

/** The furthest tick-snapped prices that still QUALIFY, probed through validateQuote itself (never a
 *  second band formula). Unreadable rules ⇒ readable:false with null bounds. */
export function inBandPriceBounds(rules: Partial<VenueRules> | null | undefined): {
  readable: boolean;
  lo: number | null;
  hi: number | null;
  tick: number | null;
};
