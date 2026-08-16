export interface BookSnapshot {
  t: number;
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
}

export interface BookVelocityOptions {
  horizonMs: number;
  holdMs: number;
  retentionMin: number;
  nvThreshold: number;
  minMoveCents: number;
  maxPairGapMs: number;
}

export declare const DEFAULTS: BookVelocityOptions;

export interface ExecutableMove {
  moveCents: number;
  dBidCents: number;
  dAskCents: number;
  direction: -1 | 0 | 1;
}

export interface VelocityPair {
  t0: number;
  t1: number;
  elapsedMs: number;
  bid0: number;
  ask0: number;
  bid1: number;
  ask1: number;
  bidSz0: number;
  askSz0: number;
  bidSz1: number;
  askSz1: number;
  moveCents: number;
  dBidCents: number;
  dAskCents: number;
  direction: -1 | 0 | 1;
  depthUsd0: number;
  depthUsd1: number;
  depthWeight: number;
  nv: number;
}

export type HoldState = 'PERSISTENT' | 'REVERTING' | 'UNKNOWN';

export interface HoldClassification {
  state: HoldState;
  retention: number | null;
  pxHold: number | null;
  holdElapsedMs: number | null;
}

export type VelocityDetection = VelocityPair & HoldClassification & { thinBook: boolean };

export interface VelocityContext {
  minSizeUsd: number;
  thinBook?: boolean;
  maxPairGapMs?: number;
}

export declare function normalizeSnapshot(s: Partial<BookSnapshot> | null | undefined): BookSnapshot | null;
export declare function executableMove(prev: BookSnapshot, curr: BookSnapshot): ExecutableMove;
export declare function consumedDepthUsd(prev: BookSnapshot, direction: number): number;
export declare function depthWeight(depthUsd: number, minSizeUsd: number): number | null;
export declare function velocityPair(
  prev: Partial<BookSnapshot> | null | undefined,
  curr: Partial<BookSnapshot> | null | undefined,
  ctx: VelocityContext,
): VelocityPair | null;
export declare function classifyHold(
  pair: VelocityPair,
  future: Partial<BookSnapshot> | null | undefined,
  opts?: Partial<BookVelocityOptions>,
): HoldClassification;
export declare function isDetection(pair: VelocityPair | null, opts?: Partial<BookVelocityOptions>): boolean;
export declare function scanSeries(
  samples: Array<Partial<BookSnapshot>>,
  ctx: VelocityContext,
  opts?: Partial<BookVelocityOptions>,
): VelocityDetection[];
