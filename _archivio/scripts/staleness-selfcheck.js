#!/usr/bin/env node
'use strict';
// staleness-selfcheck — assertions for the Phase-1 "collection stopped" honesty path. When a producing
// agent is stopped its output file freezes; every surface fed by it must then render "—" + the last
// real observation time + a calm Italian note, never the frozen value/zero/error. This exercises the
// shared SSOT (lib/collection-status.js) directly, proves the "—" path fires INDEPENDENTLY by
// simulating a frozen file on disk, and confirms a fresh file passes the real value through.
// Run: node scripts/staleness-selfcheck.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STOPPED_DASH,
  toEpochMs,
  isCollectionStopped,
  lastObsHHMM,
  valueOrDash,
  collectionStoppedNoteIt,
} = require('../lib/collection-status');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); passed++; };

const NOW = 1_700_000_000_000;      // fixed synthetic "now" so the checks are deterministic
const MIN = 60_000;
const THRESHOLD = 15 * MIN;         // a representative cadence-derived stopped threshold

// ── PHASE 1 — pure classifier fires independently (fresh vs stopped) ──────────────────────────────
function phase1() {
  console.log('PHASE 1 — isCollectionStopped classifier (threshold = 15 min)');
  const fresh   = NOW - 2 * MIN;    // 2 min old → live
  const stopped = NOW - 90 * MIN;   // 90 min old → agent long stopped
  const before = { fresh: isCollectionStopped(fresh, THRESHOLD, NOW), stopped: isCollectionStopped(stopped, THRESHOLD, NOW) };
  console.log(`  before: fresh→stopped?=${before.fresh}  stopped→stopped?=${before.stopped}`);
  ok('a 2-min-old observation is NOT collection-stopped', isCollectionStopped(fresh, THRESHOLD, NOW) === false);
  ok('a 90-min-old observation IS collection-stopped', isCollectionStopped(stopped, THRESHOLD, NOW) === true);
  ok('a missing timestamp counts as stopped (nothing observed)', isCollectionStopped(null, THRESHOLD, NOW) === true);
  ok('a zero timestamp counts as stopped', isCollectionStopped(0, THRESHOLD, NOW) === true);
  // Independence: the decision is threshold-relative, not a fixed constant — a wider threshold keeps the
  // same observation live, proving the guard keys on age vs cadence and nothing else.
  ok('same 90-min observation is live under a 4h threshold (keys on age, not a constant)',
    isCollectionStopped(stopped, 4 * 60 * MIN, NOW) === false);
}

// ── PHASE 2 — the "—" render path (never the frozen value, never a zero) ──────────────────────────
function phase2() {
  console.log('PHASE 2 — valueOrDash never leaks a frozen number when stopped');
  ok('STOPPED_DASH is the em-dash', STOPPED_DASH === '—');
  ok('stopped → "—", not the frozen "$4.20/day"', valueOrDash(true, '$4.20/day') === '—');
  ok('stopped → "—", not a frozen zero', valueOrDash(true, '0') === '—' && valueOrDash(true, '$0.00') === '—');
  ok('live → the real formatted value passes straight through', valueOrDash(false, '$4.20/day') === '$4.20/day');
}

// ── PHASE 3 — plain-Italian note carries the LAST real observation, not "now" ─────────────────────
function phase3() {
  console.log('PHASE 3 — collectionStoppedNoteIt (Italian, last-observation time)');
  const t = NOW - 90 * MIN;
  const note = collectionStoppedNoteIt(t);
  const hhmm = lastObsHHMM(t);
  console.log(`  note = "${note}"`);
  ok('note is calm Italian "raccolta interrotta", not an error word', /^Raccolta dati interrotta/.test(note));
  ok('note carries the last-observation HH:MM, not the current clock', hhmm !== null && note.includes(hhmm));
  ok('note degrades cleanly with no timestamp', collectionStoppedNoteIt(null) === 'Raccolta dati interrotta');
  // toEpochMs accepts the three shapes routes actually emit (ms number, numeric string, ISO string).
  ok('toEpochMs accepts epoch-ms number', toEpochMs(t) === t);
  ok('toEpochMs accepts numeric string', toEpochMs(String(t)) === t);
  ok('toEpochMs accepts ISO string', toEpochMs(new Date(t).toISOString()) === t);
  ok('toEpochMs rejects junk → null', toEpochMs('not-a-date') === null && toEpochMs(undefined) === null);
}

// ── PHASE 4 — FROZEN-FILE SIMULATION: prove the path fires end-to-end off a real file on disk ──────
function phase4() {
  console.log('PHASE 4 — frozen-file simulation (write a file, freeze its updatedAt, assert "—")');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-selfcheck-'));
  const file = path.join(dir, 'surface.json');
  const realNow = Date.now();

  // (a) FRESH file — agent still writing: value must pass through, note must NOT show.
  fs.writeFileSync(file, JSON.stringify({ updatedAt: realNow, netUsdPerDay: 4.2 }));
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  let stoppedFresh = isCollectionStopped(doc.updatedAt, THRESHOLD, Date.now());
  console.log(`  fresh file: stopped?=${stoppedFresh} · shows="${valueOrDash(stoppedFresh, '$4.20/day')}"`);
  ok('fresh file on disk → not stopped, real value shown', stoppedFresh === false && valueOrDash(stoppedFresh, '$4.20/day') === '$4.20/day');

  // (b) FROZEN file — simulate the agent having been stopped 3h ago (updatedAt frozen), file unchanged.
  const frozenAt = realNow - 3 * 60 * MIN;
  fs.writeFileSync(file, JSON.stringify({ updatedAt: frozenAt, netUsdPerDay: 4.2 }));
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stoppedFrozen = isCollectionStopped(doc.updatedAt, THRESHOLD, Date.now());
  const shown = valueOrDash(stoppedFrozen, '$4.20/day');
  const note = collectionStoppedNoteIt(doc.updatedAt);
  console.log(`  frozen file: stopped?=${stoppedFrozen} · shows="${shown}" · note="${note}"`);
  ok('frozen file on disk → stopped', stoppedFrozen === true);
  ok('frozen file → surface shows "—", NOT the frozen $4.20/day', shown === STOPPED_DASH);
  ok('frozen file → note reports collection stopped', /^Raccolta dati interrotta/.test(note));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('staleness-selfcheck — Phase-1 "collection stopped" honesty\n');
phase1();
phase2();
phase3();
phase4();
console.log(`\nstaleness-selfcheck: ${passed} assertions passed`);
