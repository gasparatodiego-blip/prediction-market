// Superficie di tipo per lib/maker/mm-tracking.js — il motore di market making a due lati.
export interface QuoteSide {
  book: 'yes' | 'no';
  referenceMid: number;
  price: number | null;
  priceCents: number | null;
  placeable: boolean;
  reason: string | null;
  /** null = il venue non pubblica una banda per questo mercato. Mai "true" per comodita'. */
  inBand: boolean | null;
  bandNote: string | null;
}
export interface QuotePlan {
  ok: boolean; reason: string | null;
  mid: number | null; offsetCents: number | null; tick: number | null;
  yes: QuoteSide | null; no: QuoteSide | null;
}
export declare const TRACKING_SOURCE: string;
/** L'orologio del motore di tracking, in millisecondi. */
export declare const TRACKING_POLL_MS: number;
/** Oltre questa età del mid il motore mette il mercato IN PAUSA. Il pannello mostra la stessa soglia. */
export declare const MID_STALE_PAUSE_SEC: number;
export declare function planQuotes(args: { mid?: number | null; offsetCents?: number | null; tick?: number | null; bandRadiusCents?: number | null }): QuotePlan;
export declare function decideRetrack(args: {
  mid?: number | null; referenceMid?: number | null; minMoveCents?: number | null;
  lastRepriceAt?: number | null; minIntervalMs?: number; now?: number;
}): { act: boolean; gate: string | null; reason: string; movedCents?: number | null };
export declare function snap(price: number, tick: number): number | null;
export declare function runTrackingCycle(deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
export declare function emptyMarketState(): Record<string, unknown>;
