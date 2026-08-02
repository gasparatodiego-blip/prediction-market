// Superficie di tipo per lib/maker/book-view.js — la vista coerente di un book (mid + tocco + scala
// dagli stessi livelli, nello stesso istante) e i giudizi puri sul prezzo. Nessun fs, nessuna rete.
export interface LadderRow { price: number; size: number; total: number }
export interface Ladder {
  rows: LadderRow[];
  /** Quanti livelli ESISTONO nella fonte, non quanti se ne mostrano. */
  count: number;
  shown: number;
  truncated: boolean;
  maxSize: number | null;
  totalSize: number;
}
export interface BookLevels {
  bids: LadderRow[]; asks: LadderRow[];
  bidCount: number; askCount: number;
  bidShown: number; askShown: number;
  truncated: boolean;
  maxSize: number | null;
  requested: number;
  /** Tetto della fonte (agent34 ne pubblica 12 per lato). null = ignoto. */
  sourceCap: number | null;
}
export type MidKind = 'midpoint' | 'one-sided-bid' | 'one-sided-ask' | 'unavailable';
export interface BookView {
  bestBid: number | null; bestAsk: number | null; spreadCents: number | null;
  /** Il mid MOSTRATO: midpoint del tocco qui sopra, stessa fonte e stesso istante. */
  mid: number | null;
  midKind: MidKind;
  /** Il mid contro cui il venue giudica la banda premiante (adjustedMid). Invariato. */
  scoringMid: number | null;
  midDiffersFromScoring: boolean;
  /** true = il mid di scoring NON sta fra bid e ask (book sottile + filtro min_incentive_size). */
  scoringMidOutsideTouch: boolean;
  midNotes: string[];
  lastTradePrice: number | null;
  levels: BookLevels;
  live: boolean; ageMs: number | null; source: string | null;
}
export declare function buildLadder(
  raw: Array<{ price: number | string; size: number | string }> | null | undefined,
  side: 'bids' | 'asks',
  opts?: { limit?: number },
): Ladder;
export declare function displayMid(bestBid: number | null, bestAsk: number | null): { mid: number | null; kind: MidKind };
export declare function midCoherence(args: {
  mid: number | null; midKind: MidKind; scoringMid: number | null;
  bestBid: number | null; bestAsk: number | null;
  minSize?: number | null; spreadCents?: number | null;
}): { differs: boolean; outsideTouch: boolean; diffCents: number | null; notes: string[] };
export declare function bookView(
  input: {
    levels?: { bids?: Array<{ price: number | string; size: number | string }>; asks?: Array<{ price: number | string; size: number | string }> } | null;
    bestBid?: number | null; bestAsk?: number | null; scoringMid?: number | null;
    minSize?: number | null; live?: boolean; ageMs?: number | null;
    source?: string | null; lastTradePrice?: number | null; levelCap?: number | null;
  } | null,
  opts?: { levels?: number },
): BookView;
export declare function crossesBook(q: {
  price: number; bestAsk: number | null; bestBid: number | null; side?: 'BUY' | 'SELL';
}): { crosses: boolean; readable: boolean; edge?: number | null; reason: string };
export declare function priceVerdict(q: {
  price: number; bestBid: number | null; bestAsk: number | null;
  scoringMid: number | null; bandRadiusCents: number | null; side?: 'BUY' | 'SELL';
}): { level: 'ok' | 'bad' | 'unknown'; crosses: boolean; outOfBand: boolean | null; messages: string[] };
export declare function distanceCents(price: number | null, mid: number | null): number | null;
export declare function levelBlocked(price: number | null, mid: number | null, minDistanceCents: number | null): boolean;
