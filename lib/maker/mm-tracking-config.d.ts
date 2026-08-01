// Superficie di tipo per lib/maker/mm-tracking-config.js — il registro dei mercati con tracking attivo.
export interface TrackingRecord {
  marketId: string; enabled: true;
  offsetCents: number; minMoveCents: number; sizeShares: number;
  at: number | null; atIso: string | null; by: string | null; reason: string | null;
}
export interface TrackingConfigState {
  readable: boolean; error: string | null;
  markets: Record<string, TrackingRecord>;
  marketIds: string[];
  stateFile: string;
}
export declare const LIMITS: Record<'offsetCents' | 'minMoveCents' | 'sizeShares', { min: number; max: number }>;
export declare const STATE_FILE: string;
export declare const AUDIT_FILE: string;
export declare function readTrackingConfig(deps?: Record<string, unknown>): TrackingConfigState;
export declare function trackedMarketIds(deps?: Record<string, unknown>): string[];
export declare function trackingFor(marketId: string, deps?: Record<string, unknown>): TrackingRecord | null;
export declare function setTracking(
  args: { marketId: string; enabled: boolean; offsetCents?: number; minMoveCents?: number; sizeShares?: number; by?: string; reason?: string | null },
  deps?: Record<string, unknown>,
): { ok: boolean; error: string | null; enabled?: boolean; was?: boolean; record?: TrackingRecord | null };
export declare function checkParam(name: string, value: unknown): { ok: boolean; reason: string | null };
export declare function isConditionId(v: unknown): boolean;
