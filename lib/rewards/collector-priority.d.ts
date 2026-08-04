// Type surface for lib/rewards/collector-priority.js — l'elenco dei mercati che il raccoglitore di
// storico prezzi deve tenere sottoscritti perché l'ottimizzatore li ha scelti o valutati meglio.
//
// `writeCollectorPriority` prende un PIANO, mai un elenco scritto a mano: non esiste un modo di
// dichiarare «guarda questo mercato» che non passi da un piano calcolato. E non SOSTITUISCE l'elenco:
// lo unisce a quello di prima, con isteresi — un mercato esce solo dopo RETENTION_MS dall'ultima volta
// che è stato riga del piano o quasi-vincitore. La lettura è deliberatamente tollerante e fallisce verso
// l'elenco VUOTO — un elenco vecchio o rotto vale zero, mai «chissà cosa».

/** Una voce dell'unione mobile: chi è, e quando è stato interessante l'ultima volta. */
export interface CollectorPriorityEntry {
  id: string;
  /** ultima volta che è stato una RIGA del piano, null se non lo è mai stato */
  piano: string | null;
  /** ultima volta che è stato fra i primi TOP_K candidati, null se non lo è mai stato */
  topK: string | null;
  /** ultima volta che è stato interessante per un motivo qualsiasi — è questa che l'isteresi giudica */
  visto: string;
  /** posizione in graduatoria all'ultimo passaggio come quasi-vincitore */
  rank: number | null;
}

export interface CollectorPriorityFile {
  at: string;
  versione: 2;
  scelti: number;
  freschi: number;
  trattenuti: number;
  scaduti: number;
  marketIds: string[];
  mercati: CollectorPriorityEntry[];
  note: string;
}

export interface CollectorPriorityRead {
  marketIds: string[];
  at: string | null;
  ageMs: number | null;
  fresh: boolean;
  reason: string | null;
}

export interface UnioneMobileResult {
  mercati: CollectorPriorityEntry[];
  marketIds: string[];
  /** usciti perché oltre isteresi (o con data illeggibile) */
  scaduti: string[];
  /** dentro solo grazie all'isteresi: non sono né riga né top-K di adesso */
  trattenuti: string[];
  /** esclusi dal tetto — sempre e solo trattenuti, mai mercati di adesso */
  tagliati: string[];
}

export function mercatiDalPiano(
  plan: unknown,
  opts?: { topK?: number },
): { id: string; motivo: 'piano' | 'topK'; rank: number | null }[];

export function priorityFromPlan(plan: unknown, opts?: { max?: number; topK?: number }): string[];

export function unioneMobile(opts: {
  precedenti?: Partial<CollectorPriorityEntry>[];
  freschi?: { id: string; motivo: 'piano' | 'topK'; rank?: number }[];
  nowMs?: number;
  retentionMs?: number;
  max?: number;
}): UnioneMobileResult;

export function writeCollectorPriority(
  plan: unknown,
  opts?: { max?: number; topK?: number; retentionMs?: number; nowMs?: number; file?: string },
): CollectorPriorityFile;

export function readCollectorPriority(
  opts?: { nowMs?: number; maxAgeMs?: number; retentionMs?: number; file?: string },
): CollectorPriorityRead;

export const PRIORITY_FILE: string;
export const MAX_AGE_MS: number;
export const MAX_MARKETS: number;
export const TOP_K: number;
export const RETENTION_MS: number;
