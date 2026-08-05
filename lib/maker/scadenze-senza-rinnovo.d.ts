// Types for lib/maker/scadenze-senza-rinnovo.js — l'avviso «un ordine gestito è morto di scadenza».
//
// Non è un gate e non blocca niente: rende visibile un ESITO che prima non produceva alcun evento. Il 5
// agosto 2026 due gambe su Eric Barlow sono sparite dal venue alle 21:03:09 — nessuna cancellazione,
// nessun fill, nessuna riga — e il capitale che portavano è tornato libero senza che nessuno lo sapesse.

import type { Book } from './manual-order';

export interface ScadenzaSenzaRinnovo {
  type: 'scaduto-senza-rinnovo';
  /** Quando l'assenza è stata constatata (ISO). È da qui che si conta la finestra di visibilità. */
  at: string;
  marketId: string;
  marketTitle: string | null;
  orderId: string;
  book: Book;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  /** Quanto era già stato eseguito: quella posizione segue la sua uscita, e non c'entra con l'avviso. */
  sizeMatched: number | null;
  /** price × size: il capitale che quell'ordine impegnava e che adesso è libero. */
  notionalUsd: number | null;
  /** L'istante di morte pubblicato dal venue (ISO), già corretto per i 60s di ritiro anticipato. */
  expiresAt: string | null;
  /**
   * Il gate che ha fermato il rinnovo quando era DOVUTO. `null` non significa «non lo sappiamo»: significa
   * che il rinnovo non è mai stato valutato prima della scadenza, che è un'informazione diversa.
   */
  bloccoGate: string | null;
  bloccoReason?: string | null;
  bloccoAt?: string | null;
  /** L'ultimo TTL visto e l'ultima volta che l'ordine è stato osservato vivo: servono a giudicare da soli. */
  ultimaTtlSec?: number | null;
  ultimaVista?: string | null;
}

export function registraScadenzeSenzaRinnovo(
  nuovi: ScadenzaSenzaRinnovo[],
  deps?: { now?: () => number; scadenzeFile?: string },
): { ok: boolean; written: boolean; count: number; reason: string | null };

export function readScadenzeSenzaRinnovo(
  deps?: { now?: () => number; scadenzeFile?: string },
): { at: number | null; scadenze: ScadenzaSenzaRinnovo[]; count: number; capitaleUsd: number | null };

export const SCADENZE_FILE: string;
export const RETENTION_MS: number;
