// Dichiarazioni per lib/maker/utilizzo-capitale.js — la misura di quanto capitale sta lavorando.
// Il modulo è puro: nessuna lettura, nessuna rete. Gli ingressi arrivano già letti dal chiamante, e
// un ingresso mancante produce `leggibile:false`, mai uno zero.

export interface MisuraUtilizzo {
  /** false quando anche UNA sola delle tre voci non è leggibile: allora nessun numero è pubblicato. */
  leggibile: boolean;
  motivo: string;
  capitaleTotaleUsd: number | null;
  impegnatoUsd: number | null;
  liberoUsd: number | null;
  frazione: number | null;
  pct: number | null;
  target: number;
  targetPct: number;
  raggiunto: boolean | null;
  /** Quanto manca, in DOLLARI: è la sola forma in cui la misura si traduce in un'azione. */
  deficitUsd: number | null;
}

export function misuraUtilizzo(a?: {
  saldoUsd?: number | null;
  ordiniARiposoUsd?: number | null;
  posizioniUsd?: number | null;
  target?: number;
  motivoDeficit?: string | null;
}): MisuraUtilizzo;

export function formattaUtilizzo(u: MisuraUtilizzo | null | undefined): string;

/** Somma prezzo × size residua. Un ordine illeggibile rende ignoto il TOTALE, non lo sottostima. */
export function nozionaleARiposo(ordini: unknown): number | null;

/** Valore al prezzo corrente. Una posizione senza prezzo rende ignoto il totale. */
export function valorePosizioni(posizioni: unknown): number | null;

export function leggiTarget(env?: Record<string, string | undefined>): number;

export const TARGET_UTILIZZO: number;
