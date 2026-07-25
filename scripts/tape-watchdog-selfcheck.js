#!/usr/bin/env node
'use strict';
// scripts/tape-watchdog-selfcheck.js — proves agent38-tape-watchdog's fault detection, the stall-vs-quiet
// distinction, the single-shot alert episode, and the alert PATH end to end (a real POST at a local stub).
// Pure + local: no real Telegram, no pm2, no venue. Run: node scripts/tape-watchdog-selfcheck.js
//
// EXIT 0 = every assertion held. Any failure exits 1.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };

const WD = require('../agents/agent38-tape-watchdog');
const { evaluateFeeds, stepEpisode, tailRows } = WD;

const S = 1000, MIN = 60_000;

// ── 1 · evaluateFeeds — each fault fires INDEPENDENTLY, and a quiet market is NOT a fault ──────────────
console.log('\n1. fault classification (each guard independent)');
{
  // healthy: mid fresh+advancing+socketFresh, tape recent
  ok(evaluateFeeds({ midLastAgeMs: 30 * S, socketFresh: true, midAdvancing: true, tapeLastAgeMs: 40 * S }).faulted === false,
    'healthy: mid fresh + socket fresh + tape recent → NOT a fault');

  // QUIET MARKET: socket provably fresh, but NO trade for 20 min (< 30-min tape threshold) → NOT a fault
  const quiet = evaluateFeeds({ midLastAgeMs: 30 * S, socketFresh: true, midAdvancing: true, tapeLastAgeMs: 20 * MIN });
  ok(quiet.faulted === false, 'QUIET MARKET: fresh socket + 20min of no prints (< 30min) → NOT a fault (overnight quiet is not a stall)');

  // mid_history_stalled fires on its own (tape irrelevant)
  const m1 = evaluateFeeds({ midLastAgeMs: 5 * MIN, socketFresh: false, midAdvancing: false, tapeLastAgeMs: 5 * S });
  ok(m1.faulted && m1.faultType === 'mid_history_stalled', 'mid_history_stalled: 5min without a 45s sample → fault, INDEPENDENT of the tape');
  const m1b = evaluateFeeds({ midLastAgeMs: Infinity, socketFresh: false, midAdvancing: false, tapeLastAgeMs: 5 * S });
  ok(m1b.faulted && m1b.faultType === 'mid_history_stalled', 'mid_history_stalled: no mid rows at all → fault');

  // socket_stale fires when mid advances but nothing is fresh (tape recent, doesn't matter)
  const s1 = evaluateFeeds({ midLastAgeMs: 30 * S, socketFresh: false, midAdvancing: true, tapeLastAgeMs: 5 * S });
  ok(s1.faulted && s1.faultType === 'socket_stale', 'socket_stale: mid advancing but every recent row src:"stale" → fault, INDEPENDENT of the tape');

  // tape_stalled fires ONLY when the socket is fresh (else it is attributed to the socket, not the tape)
  const t1 = evaluateFeeds({ midLastAgeMs: 30 * S, socketFresh: true, midAdvancing: true, tapeLastAgeMs: 45 * MIN });
  ok(t1.faulted && t1.faultType === 'tape_stalled', 'tape_stalled: fresh socket + 45min of no prints → fault (append path failed while books flow)');
  // priority: a stale socket is NEVER mislabelled a tape stall
  const t2 = evaluateFeeds({ midLastAgeMs: 30 * S, socketFresh: false, midAdvancing: true, tapeLastAgeMs: 45 * MIN });
  ok(t2.faultType === 'socket_stale', 'priority: with the socket stale AND the tape old, it is reported as socket_stale (root cause), never tape_stalled');
}

// ── 2 · tailRows reads only the trailing rows of a large file (never buffers the whole day) ────────────
console.log('\n2. tailRows — trailing-window read');
{
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'big.jsonl');
  const w = fs.createWriteStream(tmp);
  for (let i = 0; i < 5000; i++) w.write(JSON.stringify({ i, ts: '2026-07-25T00:00:00.000Z' }) + '\n');
  w.end();
  // wait for flush
  return new Promise((res) => w.on('finish', res)).then(() => {
    const t = tailRows(tmp, 4096);
    ok(t.rows.length > 0 && t.rows.length < 5000, `tailRows returns only the trailing rows (${t.rows.length} of 5000), not the whole file`);
    ok(t.rows[t.rows.length - 1].i === 4999, 'tailRows keeps the NEWEST row last (i=4999)');
    ok(tailRows('/nonexistent/x.jsonl').rows.length === 0, 'tailRows on a missing file → no rows (no throw)');
    return section3();
  });
}

// ── 3 · stepEpisode — recover-first, single alert, single-shot while held, resolved once ──────────────
async function section3() {
  console.log('\n3. episode state machine — recover → (grace) → ONE alert → single-shot');
  const now0 = 1_000_000_000_000;
  const fault = { faulted: true, faultType: 'tape_stalled', detail: 'x' };
  const healthy = { faulted: false, faultType: null };
  const cfg = { recoveryGraceMs: 120_000 };

  // t0: first sight of the fault → RECOVER (attempt restart before alerting)
  let r = stepEpisode(null, fault, now0, cfg);
  ok(r.action === 'recover' && r.state.phase === 'detected', 'first fault sighting → action=recover (restart agent34 BEFORE alerting)');

  // t1: still faulted, was 'detected' → move to 'recovering', no action (giving agent34 time)
  r = stepEpisode(r.state, fault, now0 + 30_000, cfg);
  ok(r.action === 'none' && r.state.phase === 'recovering', 'within grace → no action (waiting for the restart to take effect)');

  // t2: still faulted, still within grace → no action
  r = stepEpisode(r.state, fault, now0 + 90_000, cfg);
  ok(r.action === 'none', 'still within grace → still no alert');

  // t3: grace elapsed, STILL faulted → ONE alert
  r = stepEpisode(r.state, fault, now0 + 200_000, cfg);
  ok(r.action === 'alert' && r.state.phase === 'alerted' && r.state.alertSent === true, 'grace elapsed and still faulted → action=alert (exactly once)');

  // t4..t9: fault HELD across many more checks → NO further alerts (single-shot)
  let extra = 0;
  let s = r.state;
  for (let k = 0; k < 6; k++) { const rr = stepEpisode(s, fault, now0 + 300_000 + k * 60_000, cfg); if (rr.action !== 'none') extra++; s = rr.state; }
  ok(extra === 0, 'fault held across 6 more checks → ZERO further alerts (single-shot: not 400 messages)');

  // recovery: healthy after an alert → exactly one 'resolved', then clear
  r = stepEpisode(s, healthy, now0 + 700_000, cfg);
  ok(r.action === 'resolved' && r.state.episodeActive === false, 'fault clears after an alert → exactly one resolved notice, episode closed');
  r = stepEpisode(r.state, healthy, now0 + 760_000, cfg);
  ok(r.action === 'none', 'a subsequent healthy check emits nothing (episode already closed)');

  // a fault that RECOVERS during the grace window (before alert) → NO alert ever
  let g = stepEpisode(null, fault, now0, cfg);            // recover
  g = stepEpisode(g.state, fault, now0 + 20_000, cfg);    // recovering
  g = stepEpisode(g.state, healthy, now0 + 40_000, cfg);  // recovered within grace
  ok(g.action === 'none' && g.state.episodeActive === false, 'fault that self-heals within the grace window → NO alert at all (restart worked)');

  await section4();
}

// ── 4 · END-TO-END alert path: a real POST at a local stub, proving single-shot over a held fault ──────
async function section4() {
  console.log('\n4. end-to-end alert PATH (real POST at a local stub) + mute semantics');
  const received = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { received.push(JSON.parse(b)); } catch { received.push({ raw: b }); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  delete process.env.TELEGRAM_ALERTS_ENABLED;
  delete process.env.TAPE_WATCHDOG_TELEGRAM_MUTED;

  // Drive a full held-fault episode through the REAL action functions, alerting via the stub.
  const now0 = 2_000_000_000_000;
  const fault = { faulted: true, faultType: 'mid_history_stalled', detail: 'mid-history has not been written for 6min' };
  const cfg = { recoveryGraceMs: 1 }; // collapse grace so the alert fires on the next step
  let s = null, alertsFired = 0;
  for (let k = 0; k < 10; k++) {
    const r = stepEpisode(s, fault, now0 + k * 1000, cfg); s = r.state;
    if (r.action === 'alert') { alertsFired++; await WD.alertFault(fault); }
    // (action==='recover' would pm2-restart in production; skipped here — no pm2 side effect in the test)
  }
  ok(alertsFired === 1, 'held fault across 10 checks → the episode machine fired exactly ONE alert');
  ok(received.length === 1, 'exactly ONE Telegram POST reached the stub (single-shot end to end)');
  ok(received[0] && /mid_history_stalled/.test(received[0].text) && /6min/.test(received[0].text), 'the alert message names the stalled feed AND for how long');

  // mute semantics: global mute silences the send with no POST
  process.env.TELEGRAM_ALERTS_ENABLED = 'false';
  const before = received.length;
  const muted = await WD.sendTelegram('should be muted');
  ok(muted === false && received.length === before, 'TELEGRAM_ALERTS_ENABLED=false → send suppressed, no POST (respects the existing global mute)');
  process.env.TELEGRAM_ALERTS_ENABLED = 'true';
  process.env.TAPE_WATCHDOG_TELEGRAM_MUTED = 'true';
  const muted2 = await WD.sendTelegram('should be muted too');
  ok(muted2 === false && received.length === before, 'TAPE_WATCHDOG_TELEGRAM_MUTED=true → send suppressed (per-agent mute works alone)');

  await new Promise((res) => server.close(res));
  console.log(`\ntape-watchdog selfcheck: ${checks} assertions passed — faults classified independently; quiet market is not a fault; recovery is attempted before alerting; the alert is single-shot per episode (proven end-to-end at a stub); both the global and per-agent mutes are honoured.`);
}

process.on('unhandledRejection', (e) => { console.error('\nFAILED:', e.message); process.exit(1); });
