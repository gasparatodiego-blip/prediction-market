// Types for the shared dead/illiquid/cap-pinned contract guard (lib/contract-liveness.js).
// Consumed by agent15 (JS, untyped) and lib/spread-compute.ts (typed serve path) so both
// exclude the same phantom legs (e.g. edgeX dust/cap-pinned funding) identically.

export declare function isDeadContract(
  venue: string,
  coin: string,
  data: unknown,
  hist: Array<{ t: number; rate: number } | number>,
  ctx?: { now?: number; peerMarks?: number[] },
): { dead: boolean; reason: string | null };

export declare function buildPeerMarks(
  futures: Record<string, Record<string, unknown>>,
): Record<string, number[]>;

export declare function annualizePct(ratePerInterval: number, intervalHours: number): number;
export declare function median(xs: number[]): number | null;
