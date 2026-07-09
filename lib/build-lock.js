'use strict';
// lib/build-lock.js — build/deploy integrity state (rules 67/68/69).
//
// The ACTUAL mutual exclusion is done by flock in scripts/guarded-build.sh (a real OS
// lock, so a second `next build` WAITS instead of racing the .next directory — rule 67).
// This module is the shared STATE the lock writes and the guardian health report reads:
//   • rule 68 — a FAILED build records lastResult:'fail'; the guarded script then does
//     NOT restart the dashboard, so the last working .next keeps serving. The health
//     report surfaces lastResult:'fail' so a human sees the deploy was held back.
//   • rule 69 — the guarded script records tree coherence after the build; an incoherent
//     working tree is flagged, not deployed.
//
// Read-only/append-only JSON at a fixed /tmp path — never touches source or .next.

const fs = require('fs');

const LOCK_FILE  = '/tmp/edgeradar-build.lock';        // flock target (created by the shell)
const STATE_FILE = '/tmp/edgeradar-build-state.json';  // { phase, lastResult, startedAt, finishedAt, treeCoherent, reason }
const BUILDING_STALE_MS = 30 * 60_000;                 // a "building" phase older than this is stale (a killed build)

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { phase: 'idle', lastResult: null, startedAt: null, finishedAt: null, treeCoherent: null, reason: null }; }
}

function writeState(next) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, STATE_FILE);                    // atomic swap
  } catch { try { fs.unlinkSync(tmp); } catch {} }
  return next;
}

// Called by the guarded build when it starts (after acquiring the flock).
function recordStart(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const prev = readState();
  return writeState({ ...prev, phase: 'building', startedAt: t, finishedAt: null, reason: null });
}

// Called when the build finishes. result ∈ 'ok' | 'fail'. On 'fail' the caller MUST NOT
// restart the dashboard (rule 68) — recorded here so the health report can surface it.
function recordResult(result, meta = {}, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const prev = readState();
  return writeState({
    ...prev,
    phase: 'idle',
    lastResult: result === 'ok' ? 'ok' : 'fail',
    finishedAt: t,
    treeCoherent: meta.treeCoherent === undefined ? prev.treeCoherent : !!meta.treeCoherent,
    reason: meta.reason ?? null,
  });
}

// A build is genuinely in progress (not a stale 'building' left by a killed process).
function isBuilding(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const s = readState();
  return s.phase === 'building' && typeof s.startedAt === 'number' && (t - s.startedAt) < BUILDING_STALE_MS;
}

module.exports = { readState, recordStart, recordResult, isBuilding, LOCK_FILE, STATE_FILE, BUILDING_STALE_MS };
