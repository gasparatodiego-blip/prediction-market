import type { LayerDepth, DepthSource } from './reward-layered';

export interface LayeredDepthField {
  source: DepthSource;
  perLevel: LayerDepth[];
}

/** Attach `layeredDepth: { source, perLevel } | null` (history-preferred, live fallback) to each market. */
export function enrichLayeredDepth<T extends { marketId?: string; venue?: string }>(
  markets: T[],
  opts?: { windowMs?: number; tailMaxBytes?: number; liveBooksFile?: string },
): Array<T & { layeredDepth: LayeredDepthField | null }>;
