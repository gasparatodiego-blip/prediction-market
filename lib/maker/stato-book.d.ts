// Tipi per lib/maker/stato-book.js — il verdetto «questo prezzo è live?», calcolato una volta sola.

export interface StatoBook {
  /** IL VERDETTO. Tutte le scritte discendono da qui: se è false, nessuna etichetta dice «live». */
  live: boolean;
  tono: 'ok' | 'warn' | 'bad';
  /** La scritta della testata: «book live» | «book non live» | «book NON live» | «collegamento…» */
  badge: string;
  /** La scritta accanto al mid e sopra l'order book. Nomina la fonte quando il verdetto è no. */
  freschezza: string;
  /** Chi ha prodotto il numero — «feed agent34», «Gamma», … Mai la parola «live». */
  fonte: string;
  /** Perché il verdetto è quello che è. Va nel `title` del badge, ed è quello che i test leggono. */
  motivo: string;
}

export declare function statoBook(a?: {
  source?: string | null;
  live?: boolean | null;
  ageMs?: number | null;
  freshMaxMs?: number;
  lease?: 'idle' | 'asking' | 'held' | 'failed' | string;
  connecting?: boolean;
  letto?: boolean;
  erroreLettura?: boolean;
}): StatoBook;

export declare function nomeFonte(source: string | null): string;
export declare function etaLeggibile(ms: number | null): string;
export declare function fermoDa(ms: number | null): string;
export declare function selfcheck(): number;
