#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent38-tape-watchdog — continuity watchdog for the rewards TRADE TAPE + MID-HISTORY journals.
//
// WHY THIS EXISTS (and what it does NOT duplicate):
//   agent34-clob-ws already SELF-HEALS its socket: lib/clob-ws/client.js sends PING every 10s, runs a 35s
//   silent-socket watchdog that force-reconnects a half-open connection, and reconnects with exponential
//   backoff. So a dropped/half-open SOCKET is already handled inside agent34 — this watchdog does NOT
//   re-implement socket reconnection (it could not anyway; the socket lives in agent34's process).
//
//   What agent34's self-heal CANNOT catch is the process going WEDGED while online: the event loop blocked,
//   the append stream erroring, or the socket dead with reconnect stuck — any state where the FILES stop
//   GROWING even though pm2 still shows the process "online". agent-monitor only checks process status +
//   heartbeat staleness, not data-file growth. That gap is this watchdog's whole job: prove the journals are
//   still GROWING, and if not, restart agent34 ONCE and — only if that does not restore growth — send ONE
//   Telegram alert so an operator acts. It places/signs/decrypts NOTHING; it reads two files and, at most,
//   runs `pm2 restart agent34-clob-ws` by name (never pkill).
//
// STALL vs QUIET MARKET (the honest distinction):
//   The mid-history sampler writes on a FIXED 45s cadence regardless of trade activity, so it is the
//   liveness reference. The trade tape is event-driven (a row per executed print), so it is legitimately
//   silent in a quiet market — low overnight volume is NOT a fault. Both the tape and the book updates that
//   feed mid-history ride the SAME `client.on('event')` emission, so when mid-history is advancing with
//   FRESH (src:"ws") rows the socket is provably delivering frames and tape silence is real market quiet.
//   Only these are faults:
//     • mid_history_stalled — the fixed 45s writer stopped (agent34 wedged/dead).
//     • socket_stale        — mid-history still advancing but every recent row is src:"stale": the socket is
//                             delivering nothing and agent34's own reconnect has not restored it.
//     • tape_stalled        — the socket is provably fresh (src:"ws") yet the tape has been silent far past
//                             any plausible quiet-market gap: the append path itself (appendTrade/stream)
//                             has failed while book ingestion continues.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { fileRuntime } = require('../lib/percorsi-runtime');
const { execFile } = require('child_process');
const { httpPost: _httpPost } = require('../lib/httpGet');

// ── I PERCORSI PRIMA DI TUTTO — 17 agosto 2026 ─────────────────────────────────────────────────────
// Se `data/`, la directory di servizio o un file di servizio gia' esistente non sono utilizzabili da
// QUESTO processo, ci si ferma qui e lo si dice. Non e' prudenza generica: il 17 agosto nove file di
// `/tmp` erano di un altro utente, gli scrittori prendevano EACCES e **i lettori continuavano a leggere
// la copia vecchia, che da quel momento non invecchiava piu'**. Un processo «online» che decide su una
// fotografia ferma e' peggio di un processo caduto. Dettagli in `lib/safety/percorsi-critici.js`.
require('../lib/safety/percorsi-critici').verificaOMuori('agent38-tape-watchdog');

// ── Load .env (pm2 doesn't auto-load project env files; TELEGRAM_* live in .env) ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const DATA_DIR   = path.join(__dirname, '..', 'data');
const HB_FILE    = fileRuntime('agent-heartbeats.json');
const HB_KEY     = 'agent38-tape-watchdog';
const STATE_FILE = fileRuntime('tape-watchdog-state.json');

// ── thresholds (all overridable via env; defaults justified from the OBSERVED cadences) ──
// mid-history writes every 45s (agent34 MID_HISTORY_INTERVAL_MS). 4 missed writes = unambiguous stall.
const MID_STALL_MS      = Number(process.env.TAPE_WD_MID_STALL_MS      || 180_000);   // 3 min
// mid-history advancing but all-stale: the in-process 35s watchdog had ~4 chances to reconnect within this.
const SOCKET_STALE_MS   = Number(process.env.TAPE_WD_SOCKET_STALE_MS   || 150_000);   // 2.5 min
// tape silence UNDER a fresh socket. Observed cross-universe inter-trade gap (all ~40-60 subscribed markets
// aggregated): p50 17s, p95 84s, max 127s during active hours. 30 min of ZERO prints anywhere while books
// keep flowing is the append path failing, not the market being quiet. Single-shot bounds any night edge case.
const TAPE_STALL_MS     = Number(process.env.TAPE_WD_TAPE_STALL_MS     || 1_800_000); // 30 min
// after a restart: agent34 must reconnect + resnapshot + write its first 45s sample. 2 min covers it.
const RECOVERY_GRACE_MS = Number(process.env.TAPE_WD_RECOVERY_GRACE_MS || 120_000);
const CHECK_INTERVAL_MS = Number(process.env.TAPE_WD_CHECK_INTERVAL_MS || 60_000);

function log(...a) { console.log('[A38]', ...a); }

// ── Telegram: existing bot, existing global mute (TELEGRAM_ALERTS_ENABLED==='false' silences), plus a
//    dedicated per-agent mute (TAPE_WATCHDOG_TELEGRAM_MUTED==='true') so this lane can be hushed alone. ──
async function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return false;   // global mute
  if (process.env.TAPE_WATCHDOG_TELEGRAM_MUTED === 'true') return false; // per-agent mute
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('telegram not configured (token/chat absent) — alert not sent'); return false; }
  // API base is overridable (TELEGRAM_API_BASE) so the selfcheck can drive a real POST at a local stub.
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    await _httpPost(`${base}/bot${token}/sendMessage`, { chat_id: chat, text, parse_mode: 'HTML' }, { timeoutMs: 15_000 });
    return true;
  } catch (e) { log('sendTelegram error:', e.message); return false; }
}

// ── read helpers ──────────────────────────────────────────────────────────────
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log('state write failed:', e.message); } }

function heartbeat() {
  let hb = {}; try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')) || {}; } catch { /* fresh */ }
  hb[HB_KEY] = Date.now();
  try { const tmp = HB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(hb)); fs.renameSync(tmp, HB_FILE); } catch { /* best-effort */ }
}

// Newest file matching a daily-rotated prefix (handles the UTC-midnight rollover without hardcoding today).
function newestDailyFile(prefix) {
  let files;
  try { files = fs.readdirSync(DATA_DIR); } catch { return null; }
  const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const matched = files.filter((f) => re.test(f)).sort();
  return matched.length ? path.join(DATA_DIR, matched[matched.length - 1]) : null;
}

// Read the last ≤maxBytes of a file and return its complete trailing lines (JSON rows), newest last.
function tailRows(file, maxBytes = 65536) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return { rows: [], size: 0, mtimeMs: st.mtimeMs };
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // drop a partial first line if we started mid-file
    const lines = text.split('\n').filter((l) => l.trim());
    const usable = start > 0 ? lines.slice(1) : lines;
    const rows = [];
    for (const l of usable) { try { rows.push(JSON.parse(l)); } catch { /* skip partial/corrupt */ } }
    return { rows, size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { rows: [], size: null, mtimeMs: null, error: e.message };
  } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// ── PURE fault evaluation (exported for the selfcheck) ──────────────────────────
// inputs are already-extracted ages/flags so this is deterministic and side-effect-free.
//   midLastAgeMs   — age of the newest mid-history row (Infinity if none)
//   socketFresh    — is there a src:"ws" mid-history row within SOCKET_STALE_MS?
//   midAdvancing   — is the newest mid-history row within MID_STALL_MS? (the fixed writer is alive)
//   tapeLastAgeMs  — age of the newest trade-tape row (Infinity if none)
function evaluateFeeds({ midLastAgeMs, socketFresh, midAdvancing, tapeLastAgeMs }, cfg = {}) {
  const midStall    = cfg.midStallMs    ?? MID_STALL_MS;
  const socketStale = cfg.socketStaleMs ?? SOCKET_STALE_MS;
  const tapeStall   = cfg.tapeStallMs   ?? TAPE_STALL_MS;

  if (!(midLastAgeMs <= midStall) || !midAdvancing) {
    return { faulted: true, faultType: 'mid_history_stalled',
      detail: `mid-history has not been written for ${fmt(midLastAgeMs)} (fixed 45s sampler stopped — agent34 wedged or dead)` };
  }
  if (!socketFresh) {
    return { faulted: true, faultType: 'socket_stale',
      detail: `mid-history is advancing but every recent row is src:"stale" (no fresh socket frame within ${fmt(socketStale)}) — the CLOB socket is delivering nothing and agent34's own reconnect has not restored it` };
  }
  if (!(tapeLastAgeMs <= tapeStall)) {
    return { faulted: true, faultType: 'tape_stalled',
      detail: `the socket is fresh (books are flowing) yet no executed-trade print has been recorded for ${fmt(tapeLastAgeMs)} — past any plausible quiet-market gap, so the tape append path has failed while book ingestion continues` };
  }
  return { faulted: false, faultType: null, detail: 'both journals growing; socket fresh' };
}

function fmt(ms) { if (!isFinite(ms)) return '∞ (no rows at all)'; const s = Math.round(ms / 1000); return s < 120 ? `${s}s` : `${Math.round(s / 60)}min`; }

// ── PURE episode state machine (exported for the selfcheck) ─────────────────────
// ONE alert per fault EPISODE, not per check. Phases: detected → recovering → alerted → (clear on recovery).
// Returns the next state + the ACTION the caller must perform ('recover' | 'alert' | 'resolved' | 'none').
function stepEpisode(prev, ev, now, cfg = {}) {
  const grace = cfg.recoveryGraceMs ?? RECOVERY_GRACE_MS;
  const st = prev && prev.episodeActive ? { ...prev } : { episodeActive: false, faultType: null, phase: null, since: null, recoveryAt: null, alertSent: false };

  if (!ev.faulted) {
    // healthy. If we were in an episode that had ALERTED, emit exactly one 'resolved' notice, then clear.
    if (st.episodeActive && st.alertSent) return { state: { episodeActive: false }, action: 'resolved', resolvedType: st.faultType };
    return { state: { episodeActive: false }, action: 'none' };
  }

  // faulted:
  if (!st.episodeActive || st.faultType !== ev.faultType) {
    // new episode (or the fault mutated to a different type) → open in 'detected', recovery pending.
    return { state: { episodeActive: true, faultType: ev.faultType, phase: 'detected', since: now, recoveryAt: null, alertSent: false }, action: 'recover' };
  }
  if (st.phase === 'detected') {
    // recovery was requested last step; mark it in-flight and start the grace clock.
    return { state: { ...st, phase: 'recovering', recoveryAt: now }, action: 'none' };
  }
  if (st.phase === 'recovering') {
    if (now - (st.recoveryAt || now) >= grace) {
      // grace elapsed and STILL faulted → the restart did not fix it → ONE alert.
      return { state: { ...st, phase: 'alerted', alertSent: true }, action: 'alert' };
    }
    return { state: st, action: 'none' }; // still within grace, give agent34 time to come back
  }
  // phase 'alerted' → single-shot; hold silent for the rest of the episode.
  return { state: st, action: 'none' };
}

// ── side-effecting actions ──────────────────────────────────────────────────────
function restartAgent34() {
  return new Promise((resolve) => {
    log('recovery: pm2 restart agent34-clob-ws (by name)');
    execFile('pm2', ['restart', 'agent34-clob-ws'], { timeout: 30_000 }, (err, so, se) => {
      if (err) log('pm2 restart failed:', err.message, (se || '').trim());
      else log('pm2 restart issued');
      resolve(!err);
    });
  });
}

async function alertFault(ev) {
  const msg =
    `⚠️ <b>Tape watchdog</b> — feed stalled\n` +
    `<b>Fault:</b> ${ev.faultType}\n` +
    `${ev.detail}\n` +
    `Recovery (pm2 restart agent34-clob-ws) did not restore growth within ${fmt(RECOVERY_GRACE_MS)}. The rewards tape/mid-history journals are NOT accumulating — an operator needs to look.`;
  const sent = await sendTelegram(msg);
  log(sent ? 'ALERT sent (single-shot for this episode)' : 'ALERT suppressed (muted/unconfigured)');
}
async function alertResolved(faultType) {
  const sent = await sendTelegram(`✅ <b>Tape watchdog</b> — recovered\nThe <b>${faultType}</b> fault has cleared; the rewards journals are growing again.`);
  log(sent ? 'RESOLVED notice sent' : 'RESOLVED notice suppressed (muted/unconfigured)');
}

// ── one check ────────────────────────────────────────────────────────────────────
async function check() {
  const now = Date.now();
  const midFile  = newestDailyFile('mid-history');
  const tapeFile = newestDailyFile('trade-tape');

  const mid  = midFile  ? tailRows(midFile)  : { rows: [] };
  const tape = tapeFile ? tailRows(tapeFile) : { rows: [] };

  const midRows = mid.rows;
  const midLast = midRows.length ? midRows[midRows.length - 1] : null;
  const midLastAgeMs = midLast ? now - Date.parse(midLast.ts) : Infinity;
  const midAdvancing = midLastAgeMs <= MID_STALL_MS;
  // socketFresh: any recent mid-history row is a fresh socket sample (src:"ws") within SOCKET_STALE_MS.
  const socketFresh = midRows.some((r) => r.src === 'ws' && (now - Date.parse(r.ts)) <= SOCKET_STALE_MS);

  const tapeLast = tape.rows.length ? tape.rows[tape.rows.length - 1] : null;
  const tapeLastAgeMs = tapeLast ? now - (tapeLast.tsVenueMs || Date.parse(tapeLast.tsVenueIso)) : Infinity;

  const ev = evaluateFeeds({ midLastAgeMs, socketFresh, midAdvancing, tapeLastAgeMs });
  log(`mid age ${fmt(midLastAgeMs)} (advancing=${midAdvancing}, socketFresh=${socketFresh}) · tape age ${fmt(tapeLastAgeMs)} · ${ev.faulted ? 'FAULT ' + ev.faultType : 'ok'}`);

  const prev = readState();
  const { state, action, resolvedType } = stepEpisode(prev, ev, now);
  writeState(state);

  if (action === 'recover') { log(`fault ${ev.faultType} detected — attempting recovery before alerting`); await restartAgent34(); }
  else if (action === 'alert') await alertFault(ev);
  else if (action === 'resolved') await alertResolved(resolvedType);

  heartbeat();
}

function start() {
  log(`starting — mid-stall ${fmt(MID_STALL_MS)}, socket-stale ${fmt(SOCKET_STALE_MS)}, tape-stall ${fmt(TAPE_STALL_MS)}, check every ${fmt(CHECK_INTERVAL_MS)}`);
  heartbeat();
  check().catch((e) => log('check error:', e.message));
  setInterval(() => check().catch((e) => log('check error:', e.message)), CHECK_INTERVAL_MS);
}

module.exports = { evaluateFeeds, stepEpisode, tailRows, newestDailyFile, fmt,
  sendTelegram, alertFault, alertResolved,
  MID_STALL_MS, SOCKET_STALE_MS, TAPE_STALL_MS, RECOVERY_GRACE_MS };

if (require.main === module) start();
