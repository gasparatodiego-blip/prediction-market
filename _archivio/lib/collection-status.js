'use strict';
// lib/collection-status.js — honest-engine rule for a surface whose PRODUCING AGENT HAS STOPPED.
//
// When a pm2 agent is stopped, its /tmp or data/ output file freezes at the last write. Any surface
// that keeps reading that file would present the frozen numbers as if they were current — the exact
// honest-engine violation this module prevents. The rule:
//
//   • Never render the frozen value once collection has stopped — render the em-dash "—" instead.
//   • Never render a zero, never an error state, never a client-clock "updated now" timestamp.
//   • Show, calmly and in plain Italian, that collection has stopped and WHEN the last real
//     observation was, so the reader knows the number is abandoned, not merely a moment behind.
//
// The staleness THRESHOLD is not defined here — it stays server-side in each API route, derived from
// that agent's own write cadence (e.g. a 30-min scanner → ~35-min threshold). This module only turns
// a route's already-computed "stopped" decision into an honest display. A stopped agent's file ages
// without bound, so any cadence-derived threshold trips permanently and correctly once it is stopped.

const STOPPED_DASH = '—'; // "—" — the single honest placeholder for an abandoned number

/** Coerce a last-observation stamp (epoch ms number, numeric string, or ISO string) to epoch ms,
 *  or null when there is no real observation. */
function toEpochMs(updatedAt) {
  if (updatedAt == null) return null;
  if (typeof updatedAt === 'number') return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null;
  if (typeof updatedAt === 'string') {
    const asNum = Number(updatedAt);
    if (Number.isFinite(asNum) && String(asNum) === updatedAt.trim()) return asNum > 0 ? asNum : null;
    const t = Date.parse(updatedAt);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  return null;
}

/** True when the last observation is older than the surface's cadence-derived threshold — i.e. the
 *  producing agent is no longer writing. A missing/zero stamp counts as stopped (nothing observed). */
function isCollectionStopped(updatedAt, thresholdMs, nowMs) {
  const ms = toEpochMs(updatedAt);
  if (ms == null) return true;
  return nowMs - ms > thresholdMs;
}

/** HH:MM (24h) of the last real observation, for the inline note. null when never observed. */
function lastObsHHMM(updatedAt) {
  const ms = toEpochMs(updatedAt);
  if (ms == null) return null;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The value to display: the em-dash when stopped, else the caller's already-formatted value.
 *  Guarantees a stopped surface never shows the frozen value (and never a zero). */
function valueOrDash(stopped, formattedValue) {
  return stopped ? STOPPED_DASH : formattedValue;
}

/** Calm, plain-Italian inline reason. Not an error — a factual statement that the feed has stopped
 *  and when it last produced. */
function collectionStoppedNoteIt(updatedAt) {
  const t = lastObsHHMM(updatedAt);
  return t ? `Raccolta dati interrotta · ultimo dato alle ${t}` : 'Raccolta dati interrotta';
}

module.exports = {
  STOPPED_DASH,
  toEpochMs,
  isCollectionStopped,
  lastObsHHMM,
  valueOrDash,
  collectionStoppedNoteIt,
};
