// Types for lib/maker/residui-sotto-soglia.js — l'avviso «un residuo sta morendo sotto la soglia».
//
// Non è un gate e non blocca niente: è la superficie che rende visibile una decisione già presa —
// lasciar scadere un residuo non rinnovabile — invece di lasciarla sepolta in righe di log ripetute.

import type { Book } from './manual-order';

export interface ResiduoSottoSoglia {
  type: 'residuo-sotto-soglia';
  /** Quando l'avviso è nato (ISO). */
  at: string;
  marketId: string;
  marketTitle: string | null;
  orderId: string;
  book: Book;
  side: 'BUY' | 'SELL';
  price: number;
  /** La size che resta dopo il fill — quella che non arriva al minimo. */
  sizeRemaining: number;
  /** `min_incentive_size` del mercato: la soglia che il residuo non raggiunge più. */
  minSize: number;
  /** price × sizeRemaining: il capitale fermo su quel residuo. */
  notionalUsd: number | null;
  secondsToExpiry: number | null;
  /** La scadenza come istante (ISO), non come conto alla rovescia congelato nel file. */
  expiresAt: string | null;
  /** Calcolato in lettura: true quando la scadenza prevista è già passata. */
  scaduto?: boolean | null;
}

export function registraResiduiSottoSoglia(
  nuovi: ResiduoSottoSoglia[],
  deps?: { now?: () => number; residuiFile?: string },
): { ok: boolean; written: boolean; count: number; reason: string | null };

export function readResiduiSottoSoglia(
  deps?: { now?: () => number; residuiFile?: string },
): { at: number | null; residui: ResiduoSottoSoglia[]; count: number; capitaleUsd: number | null };

export const RESIDUI_FILE: string;
export const RETENTION_MS: number;
