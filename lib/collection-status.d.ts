// Type declarations for lib/collection-status.js — see that file for the honest-engine rationale.

export type LastObs = number | string | null | undefined;

export const STOPPED_DASH: '—';

/** Coerce a last-observation stamp (epoch ms, numeric string, or ISO string) to epoch ms, or null. */
export function toEpochMs(updatedAt: LastObs): number | null;

/** True when the last observation is older than `thresholdMs` (agent no longer writing), or absent. */
export function isCollectionStopped(updatedAt: LastObs, thresholdMs: number, nowMs: number): boolean;

/** HH:MM (24h) of the last real observation, or null when never observed. */
export function lastObsHHMM(updatedAt: LastObs): string | null;

/** The em-dash when stopped, else the caller's already-formatted value. */
export function valueOrDash(stopped: boolean, formattedValue: string): string;

/** Calm, plain-Italian inline reason stating collection has stopped and when it last produced. */
export function collectionStoppedNoteIt(updatedAt: LastObs): string;
