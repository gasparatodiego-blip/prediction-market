// Superficie di tipo per lib/maker/mm-quote-math.js — l'aritmetica pura, senza fs, condivisa fra il
// motore e l'anteprima del pannello.
export interface QuoteSide {
  book: 'yes' | 'no'; referenceMid: number;
  price: number | null; priceCents: number | null;
  placeable: boolean; reason: string | null;
  /** null = il venue non pubblica una banda per questo mercato. Mai "true" per comodita'. */
  inBand: boolean | null; bandNote: string | null;
}
export interface QuotePlan {
  ok: boolean; reason: string | null;
  mid: number | null; offsetCents: number | null; tick: number | null;
  yes: QuoteSide | null; no: QuoteSide | null;
}
export declare function planQuotes(args: { mid?: number | null; offsetCents?: number | null; tick?: number | null; bandRadiusCents?: number | null }): QuotePlan;
export declare function decideRetrack(args: {
  mid?: number | null; referenceMid?: number | null; minMoveCents?: number | null;
  lastRepriceAt?: number | null; minIntervalMs?: number; now?: number;
}): { act: boolean; gate: string | null; reason: string; movedCents?: number | null };
export declare function snap(price: number, tick: number): number | null;
