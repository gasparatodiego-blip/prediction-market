// Types for lib/maker/cancellazione-di-emergenza.js — l'avviso «il dead-man ha svuotato il libro».
//
// Non è un gate e non blocca niente: rende visibile un ESITO che prima non produceva alcun evento
// leggibile. Il 6 agosto 2026 alle 00:16:03 UTC agent37 ha cancellato nove ordini reali su cinque
// mercati per un battito fermo da 121s, e l'unica traccia era in un log di processo.

export interface MercatoCancellato {
  market: string | null;
  /** Quanti ordini il venue dichiara di aver cancellato. `null` = risposta non conteggiabile. */
  cancelled: number | null;
  /** Il controvalore residuo che quel mercato impegnava un istante prima. `null` = non leggibile. */
  notionalUsd: number | null;
  ok: boolean;
}

export interface MotoreNelReferto {
  id: string | null;
  processo: string | null;
  etichetta: string | null;
  stalenessSec: number | null;
}

export interface VenueCancellato {
  venue: string | null;
  /** La corsia cancellata, quando lo scatto è stato mirato. `null` per una spazzata totale. */
  corsia: string | null;
  ok: boolean;
  cancelled: number | null;
  venueOpenBefore: number | null;
  notionalUsd: number | null;
  /** `true` = nessuna credenziale, cancellazione SIMULATA: il libro non è stato toccato. */
  simulated: boolean;
  markets: MercatoCancellato[];
}

export interface CancellazioneDiEmergenza {
  type: 'cancellazione-di-emergenza';
  /** Quando è scattata (ISO). È da qui che si conta la finestra di visibilità. */
  at: string;
  /** Chiave di deduplica: un episodio di battito fermo produce uno scatto solo. */
  id: string;
  /** Da quanto era fermo il battito del maker quando è scattata. */
  stalenessSec: number | null;
  /** La soglia dead-man superata. */
  thresholdSec: number | null;
  /** Di quanto la si è superata: 1s è un pelo, 480s è un crollo, e sono due fatti diversi. */
  oltreSogliaSec: number | null;
  /** L'ultimo battito visto (ISO), cioè l'istante in cui il motore ha smesso di rispondere. */
  heartbeatAt: string | null;
  ordiniCancellati: number;
  mercatiToccati: number;
  /** Il capitale tornato libero. `null` = almeno un ordine non leggibile, mai uno zero di comodo. */
  capitaleUsd: number | null;
  /**
   * 'tutto'  — nessun motore rispondeva più: il libro è vuoto.
   * 'corsie' — un motore è morto e l'altro lavorava: è sparita solo la sua parte del libro.
   */
  ambito: 'tutto' | 'corsie';
  /** Ordini a riposo LASCIATI dov'erano da uno scatto mirato, perché di un motore ancora vivo. */
  ordiniLasciati: number;
  motoriMorti: MotoreNelReferto[];
  motoriVivi: MotoreNelReferto[];
  simulata: boolean;
  /** Un venue che ha risposto male: quegli ordini potrebbero essere ancora sul libro. */
  erroreVenue: string | null;
  venues: VenueCancellato[];
}

export function costruisciCancellazione(args: {
  at: number;
  stalenessSec: number | null;
  thresholdSec: number | null;
  heartbeatTs?: number | null;
  results?: unknown[];
  ambito?: 'tutto' | 'corsie';
  motoriMorti?: Array<Partial<MotoreNelReferto>>;
  motoriVivi?: Array<Partial<MotoreNelReferto>>;
}): CancellazioneDiEmergenza;

export function registraCancellazioneDiEmergenza(
  nuova: CancellazioneDiEmergenza | CancellazioneDiEmergenza[],
  deps?: { now?: () => number; cancellazioniFile?: string },
): { ok: boolean; written: boolean; count: number; reason: string | null };

export function readCancellazioniDiEmergenza(
  deps?: { now?: () => number; cancellazioniFile?: string },
): {
  at: number | null;
  cancellazioni: CancellazioneDiEmergenza[];
  count: number;
  ordiniCancellati: number;
  capitaleUsd: number | null;
};

export const CANCELLAZIONI_FILE: string;
export const RETENTION_MS: number;
