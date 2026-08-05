// Tipi per lib/maker/motivi-blocco.js — perché il pulsante di invio è spento, in forma di dati.

export interface MotivoBlocco {
  /** Ancoraggio stabile per DOM e test. */
  chiave: string;
  /** Il testo del gate, non una riscrittura: è lo stesso che decide il blocco. */
  testo: string;
  /** Cosa fare per sbloccarlo, quando una risposta esiste. */
  azione: string | null;
}

export interface Blocco {
  motivi: MotivoBlocco[];
  /** Definito COME `motivi.length === 0`: non è una seconda condizione da tenere allineata. */
  puoInviare: boolean;
}

export declare function motiviBlocco(a?: {
  problemiBloccanti?: Array<{ key: string; text: string; blocking?: boolean }>;
  busy?: boolean;
  trkBusy?: boolean;
  riepilogoCompleto?: boolean;
  mancanti?: string[];
}): Blocco;

export declare const AZIONI: Record<string, string>;
export declare function selfcheck(): number;
