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

/** L'offset del motore, in centesimi, derivato da un prezzo scelto sul book. Sul tick, mai sotto un
 *  tick, mai oltre il raggio premiante quando il venue ne pubblica uno. null se prezzo o mid mancano. */
export declare function offsetFromPrice(args: {
  price: number | null; mid: number | null;
  tick?: number | null; bandRadiusCents?: number | null;
}): number | null;

export interface SizeScale { readable: boolean; lo: number | null; hi: number | null }
/** 0% = size minima premiante, 100% = massimo acquistabile col capitale a quel prezzo. */
export declare function sizeScale(args: {
  minSize?: number | null; price?: number | null; capitalUsd?: number | null;
}): SizeScale;
/** La size a una percentuale sulla scala; null se la scala non e' leggibile. */
export declare function sizeAtPct(scale: SizeScale | null | undefined, pct: number): number | null;
