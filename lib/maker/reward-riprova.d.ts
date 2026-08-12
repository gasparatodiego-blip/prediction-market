// lib/maker/reward-riprova.d.ts — i tipi della seconda lettura del montepremi.
//
// Serve perché il gate (`app/api/maker/markets/enable/route.ts`) è TypeScript, e senza questo file
// `tsc` inferisce i parametri dai valori di difetto del JS (`righe = null` ⇒ `null | undefined`) e
// rifiuta un array perfettamente legittimo. Il modulo resta JS: qui si dichiara solo il contratto.

/** Lo stato del montepremi come lo pubblica `market-search.rewardStateOf`. */
export type RewardStato = 'premiato' | 'senza-premio' | 'illeggibile';

/** Una riga di mercato, per la parte che questo modulo legge e riscrive. */
export interface RigaPremio {
  marketId?: string | null;
  rewardsStato?: RewardStato | string | null;
  rewardsDailyRate?: number | null;
  rewardsPerche?: string | null;
  hasRewards?: boolean;
  /** Da dove viene il verdetto: `riprova`, `cache`, o `oltre-il-tetto` se non è stato chiesto. */
  rewardsRiprova?: string | null;
}

// ⚠ NIENTE `[k: string]: unknown` SU `RigaPremio`, ed è una scelta: una index signature costringerebbe
// OGNI tipo passato qui ad averne una, e `MarketRow` (il tipo vero delle righe di `market-search`) non
// ce l'ha. Il generico `T` qui sotto risolve la cosa nel verso giusto — il chiamante passa il SUO tipo
// e lo riottiene indietro, invece di doverlo appiattire in un dizionario di `unknown`.
type ConPremio = Partial<RigaPremio>;

export interface EsitoRiprova<T = RigaPremio> {
  // `T & ConPremio` e non `T`: le righe tornano ARRICCHITE — `rewardsRiprova` e il verdetto aggiornato
  // non stanno nel tipo del chiamante, e dichiararle come `T` costringerebbe chi legge a un cast.
  righe: Array<T & ConPremio>;
  /** Quante richieste sono davvero partite (esclusa la cache). */
  riprovate: number;
  /** Quante hanno recuperato un verdetto. */
  risolte: number;
  /** Quante restano ignote DOPO aver chiesto. Diverso da `oltreIlTetto`. */
  sconosciute: number;
  daCache: number;
  /** Non richieste per il tetto del ciclo: NON sono «sconosciute», si riprovano al giro dopo. */
  oltreIlTetto: number;
  tetto: number;
  dettaglio: Array<{ marketId: string; esito: string; fonte?: string | null; motivo?: string }>;
}

export function risolviPremiMancanti<T extends ConPremio>(a: {
  righe?: T[] | null;
  fetchOne?: ((conditionId: string) => Promise<{ ok: boolean; market?: ConPremio | null }>) | null;
  nowMs?: number;
  tetto?: number | null;
  ttlMs?: number;
}): Promise<EsitoRiprova<T>>;

/** `ok` · `reward-zero` (il venue ha detto no) · `reward-sconosciuto` (non lo sappiamo). */
export function motivoScarto(riga: ConPremio | null | undefined): 'ok' | 'reward-zero' | 'reward-sconosciuto';

export function leggiTetto(env?: Record<string, string | undefined>): number;
export function leggiCache(cid: string, nowMs?: number, ttlMs?: number): { stato: RewardStato; rate: number | null; perche: string | null; at: number } | null;
export function scriviCache(cid: string, rec: { stato: RewardStato; rate: number | null; perche?: string | null }, nowMs?: number): void;
export function svuotaCache(): void;
export function selfcheck(): boolean;

export const TTL_MS: number;
export const TETTO_DEFAULT: number;
