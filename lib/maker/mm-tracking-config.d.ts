// Superficie di tipo per lib/maker/mm-tracking-config.js — il registro dei mercati con tracking attivo.

/** Quali lati quota il motore. Un record senza questo campo vale 'both': e' il comportamento che quel
 *  record ha sempre avuto, e leggerlo altrimenti cambierebbe da solo cosa fa un mercato gia' configurato. */
export type TrackingSides = 'both' | 'yes' | 'no';

export interface TrackingRecord {
  marketId: string; enabled: true;
  offsetCents: number; minMoveCents: number; sizeShares: number;
  sides: TrackingSides;
  /** true ⇒ il record non dichiarava un lato ed e' stato letto come 'both' (record d'epoca precedente). */
  sidesDefaulted: boolean;
  at: number | null; atIso: string | null; by: string | null; reason: string | null;
}
export interface TrackingConfigState {
  readable: boolean; error: string | null;
  markets: Record<string, TrackingRecord>;
  marketIds: string[];
  stateFile: string;
}
export declare const LIMITS: Record<'offsetCents' | 'minMoveCents' | 'sizeShares', { min: number; max: number }>;
export declare const SIDES: readonly TrackingSides[];
export declare const DEFAULT_SIDES: TrackingSides;
export declare const STATE_FILE: string;
export declare const AUDIT_FILE: string;
export declare function readTrackingConfig(deps?: Record<string, unknown>): TrackingConfigState;
export declare function trackedMarketIds(deps?: Record<string, unknown>): string[];
export declare function trackingFor(marketId: string, deps?: Record<string, unknown>): TrackingRecord | null;
export declare function setTracking(
  args: {
    marketId: string; enabled: boolean;
    offsetCents?: number; minMoveCents?: number; sizeShares?: number;
    sides?: TrackingSides;
    by?: string; reason?: string | null;
  },
  deps?: Record<string, unknown>,
): {
  ok: boolean; error: string | null; enabled?: boolean; was?: boolean;
  record?: TrackingRecord | null;
  /** I lati che il mercato aveva PRIMA di questa scrittura, o null se non era acceso. */
  prevSides?: TrackingSides | null;
};
export declare function checkParam(name: string, value: unknown): { ok: boolean; reason: string | null };
export declare function isConditionId(v: unknown): boolean;

/** Distingue «non dichiarato» (⇒ 'both') da «dichiarato e non riconosciuto» (⇒ invalido, record escluso). */
export declare function readSides(raw: unknown): { ok: boolean; sides: TrackingSides | null; defaulted: boolean; reason?: string };

/** I libri che il motore deve quotare: ['yes','no'] per 'both', un solo elemento altrimenti. */
export declare function activeSides(sides: unknown): Array<'yes' | 'no'>;
