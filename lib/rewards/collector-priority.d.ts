// Type surface for lib/rewards/collector-priority.js — l'elenco dei mercati che il raccoglitore di
// storico prezzi deve tenere sottoscritti perché l'ottimizzatore li ha scelti o valutati meglio.
//
// `writeCollectorPriority` prende un PIANO, mai un elenco scritto a mano: non esiste un modo di
// dichiarare «guarda questo mercato» che non passi da un piano calcolato. La lettura è deliberatamente
// tollerante e fallisce verso l'elenco VUOTO — un elenco vecchio o rotto vale zero, mai «chissà cosa».

export interface CollectorPriorityFile {
  at: string;
  scelti: number;
  marketIds: string[];
  note: string;
}

export interface CollectorPriorityRead {
  marketIds: string[];
  at: string | null;
  ageMs: number | null;
  fresh: boolean;
  reason: string | null;
}

export function priorityFromPlan(plan: unknown, opts?: { max?: number }): string[];

export function writeCollectorPriority(
  plan: unknown,
  opts?: { max?: number; nowMs?: number; file?: string },
): CollectorPriorityFile;

export function readCollectorPriority(
  opts?: { nowMs?: number; maxAgeMs?: number; file?: string },
): CollectorPriorityRead;

export const PRIORITY_FILE: string;
export const MAX_AGE_MS: number;
export const MAX_MARKETS: number;
