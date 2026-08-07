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
  /** Le soglie EFFETTIVE di questa chiamata, in centesimi: difetto 3/97, o quelle lette da .env. */
  lowCents: number;
  highCents: number;
}

/** @param mid il mid in PREZZO (0–1), non in centesimi. */
export function endOfScaleCheck(mid: number | null | undefined, env?: Record<string, string | undefined>): EndOfScaleVerdict;
export function sogliaFineScala(env?: Record<string, string | undefined>): {
  lowCents: number; highCents: number; origine: 'difetto' | 'env' | 'scartato';
};
