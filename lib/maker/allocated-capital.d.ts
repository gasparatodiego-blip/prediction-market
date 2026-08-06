// Type surface for lib/maker/allocated-capital.js — the DERIVED position ceiling.
// `writeAllocatedCapital` takes plan rows, never an operator-supplied number: there is no setter here
// that a control could reach, which is what makes the ceiling underivable-from-the-UI by construction.

export interface AllocatedCapitalVerdict {
  capUsd: number | null;
  readable: boolean;
  stale: boolean;
  ageSec: number | null;
  reason: string;
}

export interface AllocatedCapitalSnapshot {
  readable: boolean;
  error: string | null;
  markets: Record<string, { capitalUsd: number }>;
  updatedAt: number | null;
  ageSec: number | null;
  capital: number | null;
}

/** I due profili che un piano puo' avere. Un record senza profilo e' 'safe' per costruzione. */
export type ProfiloPiano = 'safe' | 'risk';

/**
 * Il verdetto sul profilo di UN mercato. `profile: null` non e' 'safe': significa che il profilo non
 * si e' potuto stabilire (mercato fuori piano, piano scaduto, store illeggibile) e a valle si traduce
 * in «nessun ordine nuovo». Un difetto comodo farebbe attraversare a un mercato Risk i controlli Safe.
 */
export interface ProfiloVerdetto {
  profile: ProfiloPiano | null;
  readable: boolean;
  stale: boolean;
  ageSec: number | null;
  reason: string;
}

/**
 * FONDE PER PROFILO: un piano di profilo P sostituisce esattamente i mercati P e non tocca gli altri.
 * Non e' un dettaglio: la sostituzione totale avrebbe fatto cancellare a un piano Risk i tetti dei
 * mercati Safe, e un tetto assente vale «niente nuova esposizione».
 */
export function writeAllocatedCapital(
  args: {
    rows: Array<{ marketId: string; capital: number }>;
    capital?: number | null;
    by?: string;
    profile?: ProfiloPiano;
  },
  deps?: Record<string, unknown>,
): { ok: boolean; marketCount: number; profileCount: number; profile: ProfiloPiano; at: number };

export function readAllocatedCapital(marketId: string, deps?: Record<string, unknown>): AllocatedCapitalVerdict;
export function readAllocatedCapitalAll(deps?: Record<string, unknown>): AllocatedCapitalSnapshot;
/** Il profilo di un mercato, riletto dal file a ogni chiamata: nessuna cache. */
export function readMarketProfile(marketId: string, deps?: Record<string, unknown>): ProfiloVerdetto;

export const STORE_FILE: string;
export const MAX_AGE_MS: number;
export const PROFILI: readonly ProfiloPiano[];
export const PROFILO_DIFETTO: ProfiloPiano;
