// lib/maker/capitale-al-lavoro.d.ts — il contratto per i consumatori TypeScript.
//
// Serve perché una rotta `.ts` importa questo modulo JS: senza dichiarazione, `tsc` inferisce i
// parametri dai valori di difetto del JS (`utilizzo = null` ⇒ `null | undefined`) e RIFIUTA un
// oggetto legittimo. Non è un capriccio del compilatore: è un contratto mancante. Stessa trappola già
// registrata in §5 punto 84 per `reward-riprova`.

export interface UtilizzoLike {
  leggibile?: boolean;
  capitaleTotaleUsd?: number | null;
  impegnatoUsd?: number | null;
  liberoUsd?: number | null;
  motivo?: string | null;
  [k: string]: unknown;
}

export interface CapitaleAlLavoro {
  leggibile: boolean;
  alLavoroUsd: number | null;
  totaleUsd: number | null;
  fermoUsd: number | null;
  frazione: number | null;
  pct: number | null;
  obiettivo: number;
  obiettivoPct: number;
  raggiunto: boolean | null;
  mancanoUsd: number | null;
  motivo: string;
}

export interface VoceFermo { causa: string; usd: number; pct: number }

export interface RipartizioneFermo {
  chiude: boolean;
  fermoUsd: number;
  voci: VoceFermo[];
  nonAttribuitoUsd: number;
  riga: string;
}

export function capitaleAlLavoro(a?: {
  utilizzo?: UtilizzoLike | null;
  ingredienti?: { saldoUsd?: number | null; ordiniARiposoUsd?: number | null; posizioniUsd?: number | null } | null;
  obiettivo?: number | null;
}): CapitaleAlLavoro;

export function ripartizioneFermo(a?: {
  fermoUsd?: number;
  pianoSenzaRigheUsd?: number;
  tettoMercatoPienoUsd?: number;
  rifiutatiDalVenueUsd?: number;
  nonQuotabiliUsd?: number;
  rateLimitUsd?: number;
}): RipartizioneFermo;

export function valutaDiagnosi(a?: {
  frazione?: number | null;
  ora?: number;
  stato?: { sottoDa: number | null; giaScritta: boolean } | null;
  soglia?: number;
  durataMs?: number;
}): { sottoDa: number | null; giaScritta: boolean; scrivi: boolean; motivo: string };

export const OBIETTIVO_DEFAULT: number;
export const SOGLIA_DIAGNOSI: number;
export const DURATA_DIAGNOSI_MS: number;
