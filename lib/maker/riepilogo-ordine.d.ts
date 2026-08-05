// Tipi per lib/maker/riepilogo-ordine.js — la schermata di verifica pre-invio, in forma di dati.

export interface RigaRiepilogo {
  /** L'etichetta a sinistra. */
  k: string;
  /** Il valore a destra — già formattato, e «N/D» quando il dato non c'è. Mai uno zero di ripiego. */
  v: string;
  /** Una precisazione breve accanto al valore («dal piano», «banda ±2.25¢»). */
  nota?: string | null;
  tono: 'neutro' | 'ok' | 'warn' | 'bad' | 'forte';
  /** Ancoraggio stabile per DOM e test: non cambia se cambia l'etichetta. */
  chiave: string;
}

export interface EsitoControllo {
  testo: 'SÌ' | 'no' | 'non verificabile';
  /** false quando la risposta non si conosce — che NON è «no». */
  noto: boolean;
  valore: boolean | null;
}

export interface Riepilogo {
  righe: RigaRiepilogo[];
  /** I dati essenziali assenti. Vuoto ⇔ `completo`. */
  mancanti: string[];
  /** false ⇒ il pulsante di conferma resta spento. Si somma ai gate, non li sostituisce. */
  completo: boolean;
  notional: number | null;
  incrocia: EsitoControllo;
  inBanda: EsitoControllo;
  lato: string | null;
  marketId: string | null;
}

export declare const ASSENTE: string;

export declare function riepilogoOrdine(a?: {
  title?: string | null;
  marketId?: string | null;
  book?: 'yes' | 'no' | null;
  price?: number | null;
  size?: number | null;
  distanceCents?: number | null;
  bandRadiusCents?: number | null;
  verdict?: { level: string; crosses: boolean; outOfBand: boolean | null; messages: string[] } | null;
  legIdx?: number | null;
  legsTotal?: number | null;
  fonte?: 'piano' | 'digitato';
}): Riepilogo;

export declare function esito(v: boolean | null): EsitoControllo;
export declare function selfcheck(): number;
