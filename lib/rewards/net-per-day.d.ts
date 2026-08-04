/** La regola canonica del netto per giorno, condivisa fra l'allocatore (righe del piano e card di
 *  proposta) e il pannello «Ottimizza». Vedi lib/rewards/net-per-day.js.
 *
 *  Un netto esiste solo se un fill è stato OSSERVATO: il motore modella «nessun fill» come costo 0 per
 *  poter ottimizzare, ma un costo modellato a zero non è un costo misurato a zero, e mostrarlo come
 *  netto significa mostrare il lordo con un'altra etichetta. */

/** true solo per un conteggio di fill REALE e positivo. undefined/null/NaN ⇒ false: «non lo so» non è
 *  «ce ne sono». */
export declare function haFillOsservati(fills: number | null | undefined): boolean;

/** Il netto, oppure null quando non è misurabile — MAI il lordo di ripiego. */
export declare function calcNetPerDay(a: {
  fills?: number | null;
  netPerDay?: number | null;
}): number | null;

/** Il lordo: non ha bisogno di fill. null se non è un numero (un lordo non misurabile non è zero). */
export declare function calcGrossPerDay(a: { grossPerDay?: number | null }): number | null;

/** Perché il netto manca: due assenze diverse, che un trattino solo confonderebbe. */
export declare function perchePerNettoAssente(a: {
  fills?: number | null;
  netPerDay?: number | null;
}): null | 'nessun-fill-osservato' | 'non-calcolabile';

/** La spiegazione in chiaro da mostrare accanto al trattino. */
export declare function notaNettoAssente(
  motivo: null | 'nessun-fill-osservato' | 'non-calcolabile',
): string | null;

/** Il testo mostrato al posto di un netto assente — uno solo, per non averne due diversi. */
export declare const NETTO_ASSENTE: string;
