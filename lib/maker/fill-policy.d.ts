// Types for lib/maker/fill-policy.js — the per-side on-fill rule the maker actually reads.
export type FillRule = 'close' | 'opposite' | 'hold';
export type FillAction = 'close' | 'place-opposite' | 'hold';

export interface FillFollowUpQuote {
  book: 'yes' | 'no';
  kind: 'buy' | 'sell';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  offsetC: number | null;
  notionalUsd: number;
  intent: 'flatten' | 'round-trip';
}

export interface FillPlan {
  action: FillAction;
  rule: FillRule;
  appliedRule: FillRule;
  quote: FillFollowUpQuote | null;
  guard: { valid: boolean; reasons: Array<{ code: string; detail: string }> } | null;
  reason: string;
  forcedBy: string | null;
}

export function normalizeFillRule(v: unknown): FillRule;
export function oppositeKind(kind: 'buy' | 'sell'): 'buy' | 'sell';
export function planOnFill(args: {
  filledLeg: { book: 'yes' | 'no'; kind: 'buy' | 'sell'; price?: number | null; offsetC?: number | null; size?: number | null };
  rule?: unknown;
  mid?: number | null;
  maxSpreadC?: number | null;
  tick?: number | null;
  minSize?: number | null;
  capHeadroomUsd?: number | null;
  newsForceClose?: boolean;
}): FillPlan;

export const RULES: readonly FillRule[];
export const DEFAULT_RULE: FillRule;
