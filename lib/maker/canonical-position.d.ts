// Types for lib/maker/canonical-position.js — the canonical description of a resting order.

export type CanonicalSide = 'BID' | 'ASK';

export interface CanonicalPoint {
  side: CanonicalSide;
  /** The price on the YES book, after mirroring a NO-token price (1 − q). */
  yesPrice: number;
  key: string;
  mirrored: boolean;
}

export interface CanonicalPosition {
  side: CanonicalSide;
  yesPrice: number;
  key: string;
  /** Summed shares of every leg resting at this canonical level. */
  sizeShares: number;
  legIds: Array<string | null>;
  legCount: number;
  label: string;
}

export interface CanonicalCollapse {
  key: string;
  label: string;
  legCount: number;
  legIds: Array<string | null>;
}

export interface CanonicalSet {
  positions: CanonicalPosition[];
  collapsed: CanonicalCollapse[];
  undescribable: number;
  hasBid: boolean;
  hasAsk: boolean;
  twoSided: boolean;
}

export declare const SIDES: Readonly<{ BID: 'BID'; ASK: 'ASK' }>;

export function toCanonical(leg: {
  book: 'yes' | 'no';
  kind: 'buy' | 'sell';
  price: number;
}): CanonicalPoint | null;

export function canonicalize(
  legs: Array<{ book: string; kind: string; price: number; size?: number | null; id?: string | null }>,
): CanonicalSet;

export function canonicalLabel(c: CanonicalPoint | null): string;
