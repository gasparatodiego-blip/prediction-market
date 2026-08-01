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

export function writeAllocatedCapital(
  args: { rows: Array<{ marketId: string; capital: number }>; capital?: number | null; by?: string },
  deps?: Record<string, unknown>,
): { ok: boolean; marketCount: number; at: number };

export function readAllocatedCapital(marketId: string, deps?: Record<string, unknown>): AllocatedCapitalVerdict;
export function readAllocatedCapitalAll(deps?: Record<string, unknown>): AllocatedCapitalSnapshot;

export const STORE_FILE: string;
export const MAX_AGE_MS: number;
