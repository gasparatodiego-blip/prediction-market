/** Le righe dei DUE piani della tab «Ottimizza» in una mappa sola: `plan` («Calcola») e `autoPlan`
 *  («Cerca la combinazione migliore», che rende le card di proposta). Vedi lib/rewards/righe-piano.js:
 *  leggerne uno solo teneva invisibile il bottone «+ Metti in coda» per chi arrivava dal percorso
 *  normale. `autoPlan` vince dove un mercato sta in entrambi. */
export declare function righePerId<T = unknown>(a: {
  plan?: { rows?: T[] } | null;
  autoPlan?: { rows?: T[] } | null;
}): Map<string, T>;

/** Il bottone «+ Metti in coda» si può mostrare su questa card? Serve una riga di piano da cui
 *  prendere prezzo e size. */
export declare function puoAndareInCoda(a: { righe?: Map<string, unknown>; marketId?: string }): boolean;
