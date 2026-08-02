export const END_OF_SCALE_LOW_CENTS: number;
export const END_OF_SCALE_HIGH_CENTS: number;
export const END_OF_SCALE_REASON: string;

export interface EndOfScaleVerdict {
  /** true ⇒ cancellare gli ordini di questo mercato. Mai «riprezzare piu' stretto»: solo cancellare. */
  endOfScale: boolean;
  /** false ⇒ il mid non era leggibile, quindi la domanda non ha avuto risposta (e non si agisce). */
  readable: boolean;
  midCents: number | null;
  side: 'low' | 'high' | null;
  reason: string | null;
}

/** @param mid il mid in PREZZO (0–1), non in centesimi. */
export function endOfScaleCheck(mid: number | null | undefined): EndOfScaleVerdict;
