// Types for lib/build-lock.js — build/deploy integrity state (rules 67/68/69).
export interface BuildState {
  phase:        'idle' | 'building';
  lastResult:   'ok' | 'fail' | null;
  startedAt:    number | null;
  finishedAt:   number | null;
  treeCoherent: boolean | null;
  reason:       string | null;
}
export declare function readState(): BuildState;
export declare function recordStart(now?: number): BuildState;
export declare function recordResult(result: 'ok' | 'fail', meta?: { treeCoherent?: boolean; reason?: string }, now?: number): BuildState;
export declare function isBuilding(now?: number): boolean;
export declare const LOCK_FILE: string;
export declare const STATE_FILE: string;
export declare const BUILDING_STALE_MS: number;
