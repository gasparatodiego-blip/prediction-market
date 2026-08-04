/** Da piano a righe eseguibili — DUE gambe per mercato. Vedi lib/rewards/plan-to-orders.js. */

export type GambaRiga = {
  marketId: string;
  title: string | null;
  /** 'yes' = BUY sul libro YES a mid−d · 'no' = BUY sul libro NO a (1−mid)−d, che sul libro YES è un ask a mid+d */
  book: 'yes' | 'no';
  side: 'BUY';
  price: number;
  size: number;
  /** il marketId, portato sulla riga: bulk-allocate lo usa per non piazzare mai una gamba senza l'altra */
  coppia: string;
  gamba: 'yes' | 'no';
};

export type Coppia = {
  marketId: string;
  title: string | null;
  shares: number;
  prezzoYes: number;
  prezzoNo: number;
  offsetCents: number | null;
  capitalePianoUsd: number;
  capitaleImpegnatoUsd: number;
  sharePiano: number | null;
  shareReali: number;
  rapportoSize: number | null;
};

export type Scarto = { marketId: string; title: string | null; motivo: string; dettaglio: string };

/**
 * Le due gambe di UNA riga, all'offset dato. `rows` valorizzato ⇒ due righe pronte; `scarto`
 * valorizzato ⇒ il mercato non è eseguibile, col motivo. Mai una riga sola.
 */
export declare function gambeDiUnaRiga(
  r: any,
  offsetTicks: number,
): { rows: GambaRiga[] | null; scarto: Scarto | null; coppia: Coppia | null };

export declare function planToOrders(
  plan: any,
  opts?: { nowMs?: number; staleSeconds?: number },
): {
  rows: GambaRiga[];
  scartate: Scarto[];
  coppie: Coppia[];
  totals: { candidate: number; eseguibili: number; righe: number; scartate: number; capitaleUsd: number };
};

export declare function rowAt(r: any, offsetTicks: number): {
  offsetTicks: number; offsetCents: number | null;
  bid: number | null; ask: number | null;
  inBand: boolean | null; bandKnown: boolean; gross: number | null;
};

export declare function troncaShare(q: number | null | undefined): number;
export declare const STALE_S: number;
