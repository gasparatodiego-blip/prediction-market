// Types for lib/maker/risk-classifier.js — la classificazione Safe/Risk condivisa.
//
// Come in operator-board.d.ts, ogni verdetto è NULLABILE di proposito: null significa «non giudicabile»
// e non va mai collassato su false. Un chiamante che tratta `outOfBand: null` come «in banda» rimette
// dentro esattamente la bugia che questi tipi esistono per impedire.

/** Ciò che il classificatore sa leggere. Tutti i campi sono opzionali: quello che manca non viene
 *  indovinato, e la regola che lo usava non si pronuncia. */
export interface RiskSubject {
  marketId?: string | null;

  // Banda: o il verdetto già pronto del board, o prezzo + estremi.
  price?: number | null;
  bandLo?: number | null;
  bandHi?: number | null;
  inBand?: boolean | null;
  outOfBand?: boolean | null;

  // Scadenza: la prima sorgente leggibile vince, in quest'ordine.
  minutesToClose?: number | null;
  hoursToResolution?: number | null;
  endDate?: string | null;

  // Freschezza: idem.
  dataAgeSec?: number | null;
  midAgeSec?: number | null;
  newestTsMs?: number | null;

  /** Già deciso da lib/maker/top-of-book.js. Mai calcolato qui. */
  onTop?: boolean | null;

  restingNotionalUsd?: number | null;
  notionalUsd?: number | null;
}

export interface RiskVerdict {
  /** Vero se almeno un flag MISURATO è scattato. Le incognite non lo alzano. */
  isRisk: boolean;
  /** Le etichette da mostrare, nell'ordine: banda, scadenza, stale, primo sul book. */
  flags: string[];
  /** Ciò che non si è potuto misurare. Non è rischio, ma non è nemmeno via libera. */
  unknowns: string[];
  /** False solo sotto il pavimento di tradabilità del venue: il venue rifiuterebbe l'ordine. */
  tradable: boolean;
  minutesToClose: number | null;
  dataAgeSec: number | null;
  outOfBand: boolean | null;
}

export interface RiskOptions {
  nowMs?: number;
  /** Override della soglia di scadenza. Il profilo Risk passa il pavimento del venue. */
  safeFloorMinutes?: number;
  /** marketId (minuscolo) → campi di mercato da unire alla riga d'ordine. Solo per `bucketizza`. */
  contesto?: Map<string, RiskSubject>;
}

export interface BucketResult<T = RiskSubject> {
  safe: Array<T & { rischio: RiskVerdict }>;
  risk: Array<T & { rischio: RiskVerdict }>;
  /** Né Safe né Risk: nulla di misurato contro, e nulla di misurato a favore. */
  nonGiudicabili: Array<T & { rischio: RiskVerdict }>;
  safeUsd: number;
  riskUsd: number;
  nonGiudicabileUsd: number;
  impegnatoUsd: number;
}

export function classifyRisk(soggetto?: RiskSubject, opts?: RiskOptions): RiskVerdict;
export function bucketizza<T extends RiskSubject>(ordini?: T[], opts?: RiskOptions): BucketResult<T>;
export function etichettaScadenza(minuti: number | null): string | null;
export function minutiAllaChiusura(a?: RiskSubject & { nowMs?: number }): number | null;
export function fuoriBanda(a?: RiskSubject): boolean | null;

/** 3 — derivato da VENUE_GTD_MIN_FUTURE_SEC (lib/maker/order-ttl.js), mai riscritto. */
export const VENUE_FLOOR_MINUTES: number;
/** 2880 — derivato da MIN_HORIZON_DAYS (lib/rewards/horizon.js), mai riscritto. */
export const SAFE_FLOOR_MINUTES: number;
/** 300 — STALE_S (lib/rewards/plan-to-orders.js), mai riscritto. */
export const STALE_SECONDS: number;

export const FLAG_FUORI_BANDA: string;
export const FLAG_STALE: string;
export const FLAG_SOTTO_PAVIMENTO: string;
export const FLAG_PRIMO_SUL_BOOK: string;
