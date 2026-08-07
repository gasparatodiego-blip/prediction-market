export interface MidVivoOrdine {
  orderId: string | null; side: string | null; price: number | null;
  size: number | null; sizeRemaining: number | null;
  distanzaCents: number | null; latoDelMid: 'sotto' | 'sopra' | 'sul' | null;
}
export interface MidVivoRiga {
  marketId: string; title: string | null; mid: number | null; midAgeSec: number | null;
  live: boolean; midStantio: boolean; sogliaStantioSec: number; ordini: MidVivoOrdine[];
}
export declare function componiMidVivo(
  books: any, ordini: any[], sogliaStantioSec: number,
): { feedLetto: boolean; mercati: MidVivoRiga[] };
