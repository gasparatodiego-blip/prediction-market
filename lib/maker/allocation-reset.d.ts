// Tipi per lib/maker/allocation-reset.js — «Esegui allocazione» come RESET, non come somma.

export interface ResetRow {
  marketId: string; book: 'yes' | 'no'; side?: 'BUY' | 'SELL';
  price: number; size: number; title?: string;
}

export interface ResetOrderRef {
  marketId: string; orderId: string;
  price: number | null; size: number | null; book: string | null;
  reason?: string | null;
}

export interface ResetLogEntry {
  at: string; fase: string; evento: string;
  [k: string]: unknown;
}

export interface AllocationResetReport {
  ok: boolean;
  at: string;
  latencyMs: number;
  /** true ⇒ nulla è stato cancellato, scritto o inviato: solo il referto di cosa accadrebbe. */
  preview: boolean;
  /** null se la sequenza è arrivata in fondo; altrimenti la fase che l'ha fermata. */
  stoppedBy: 'list-failed' | 'cancel-failed' | 'enable-failed' | null;
  reason: string | null;
  log: ResetLogEntry[];
  inventario?: { abilitatiPrima: string[]; trackingPrima: string[]; nelPiano: string[]; gestiti: string[] };
  cancellazione?: { daCancellare: ResetOrderRef[]; cancellati: ResetOrderRef[] | number; falliti: ResetOrderRef[] | number; simulata?: boolean };
  spegnimento?: { tracking: unknown[]; abilitati: unknown[]; simulato?: boolean };
  accensione?: { markets: unknown[]; simulato?: boolean };
  piazzamento?: Record<string, unknown> | null;
  lettureFallite?: Array<{ marketId: string; error: string }>;
}

export declare const RESET_SOURCE: string;

export declare function runAllocationReset(
  args?: { rows?: ResetRow[]; userId?: string; dryRunOnly?: boolean },
  deps?: Record<string, unknown>,
): Promise<AllocationResetReport>;
