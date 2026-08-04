/** La coda di conferme della tab «Ottimizza»: decide SE avanzare, non piazza mai.
 *  Vedi lib/rewards/coda-piazzamento.js. */
export type EsitoPiazzamento = {
  marketId: string; legIdx: number; legTotal: number; at: number;
  book?: 'yes' | 'no'; price?: number; size?: number; sent?: boolean;
};
export type VoceEsito = { marketId: string; nome: string; esito: 'piazzato' | 'saltato'; capitale: number };

export declare function esitoUtilizzabile(e: unknown): boolean;
export declare function decidiAvanzamento(a: {
  coda?: string[]; esito?: EsitoPiazzamento | null; ultimoAt?: number | null;
}): { avanza: boolean; motivo: string };
export declare function avanza(a: {
  coda?: string[]; esiti?: VoceEsito[]; come?: 'piazzato' | 'saltato'; nome?: string | null; capitale?: number;
}): { coda: string[]; esiti: VoceEsito[] };
export declare function metti(a: { coda?: string[]; marketId?: string }): string[];
export declare function riepilogo(esiti?: VoceEsito[]): {
  trattati: number; piazzati: number; saltati: number; capitaleUsd: number;
};
