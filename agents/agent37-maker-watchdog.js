#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent37-maker-watchdog — the DEAD-MAN switch for the Polymarket maker (agent35).
//
// NAMED agent37, NOT agent36: slot 36 is already taken by agent36-book-velocity. A watchdog must be a
// SEPARATE process from the thing it watches — a timer inside agent35 dies exactly when agent35 dies, so
// it is not a watchdog at all. This runs on its own, polls agent35's heartbeat, and if that heartbeat goes
// stale it cancels every open order on every configured venue and alerts.
//
// WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT:
//   • Protects against: agent35 crashing, hanging, or crash-looping while orders rest on the venue.
//   • Does NOT protect against host death (VPS reboot / kernel panic / network partition of THIS box):
//     a watchdog on the same host dies with the host. That case is covered ONLY by the venue-native GTD
//     order expiry (lib/maker/order-ttl.js). Both layers are required; neither replaces the other.
//
// HARD SAFETY CONSTRAINT — this process is STRUCTURALLY INCAPABLE OF PLACING AN ORDER. Its only reachable
// venue surface is lib/maker/cancel-all.js → the cancel-only adapter (address-only signer). It does NOT
// import lib/venues/polymarket-clob-maker/* (the placement module) anywhere in its require tree.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const https = require('https');
const { cancelAllOrders } = require('../lib/maker/cancel-all');
// The ONE cancel credentials provider (shared with POST /api/maker/cancel). Present creds → live cancel;
// absent → dry-run (simulated). key-custody is required lazily inside it, AFTER the .env load below.
const { buildCancelCredsProviders } = require('../lib/maker/cancel-creds-provider');
// ── LO SCATTO ESCE DAL LOG DI PROCESSO ────────────────────────────────────────────────────────────
// Il 6 agosto 2026 alle 00:16:03 questo watchdog ha cancellato nove ordini reali su cinque mercati e
// l'ha scritto in tre righe di ~/.pm2/logs/agent37-maker-watchdog-out.log, con il Telegram «not
// configured». Il mattino dopo: libro vuoto, $663 fermi, nessuna spiegazione visibile in nessun
// pannello. Un avviso che per essere visto pretende che qualcuno legga i log di un processo non è un
// avviso — è la stessa lezione di residui-sotto-soglia e scadenze-senza-rinnovo, e qui prende la
// stessa strada: un file in data/ che /api/maker/wallet-status porta in «Stato wallet e piazzamento».
const { costruisciCancellazione, registraCancellazioneDiEmergenza } = require('../lib/maker/cancellazione-di-emergenza');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

// ── Load .env for Telegram creds (pm2 doesn't auto-load project env files) — read-only, never commit ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const POLL_MS      = Number(process.env.MAKER_WATCHDOG_POLL_MS || 15_000);
const DEADMAN_SEC  = Number(process.env.MAKER_DEADMAN_SECONDS || 120);
const HB_FILE      = path.join(__dirname, '..', 'data', 'maker-heartbeat.json');   // agent35 writes; we READ
const STATE_FILE   = path.join(__dirname, '..', 'data', 'maker-watchdog-state.json'); // WE OWN THIS
const HEARTBEATS   = '/tmp/agent-heartbeats.json';                                 // shared fleet heartbeat

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
// Per-agent mute (mirrors BOOK_VELOCITY_TELEGRAM_MUTED / TRADER_AUDITOR_TELEGRAM_MUTED) so this one
// watchdog can be silenced without muting the fleet. The project-wide switch (TELEGRAM_ALERTS_ENABLED)
// is honoured too — this is not a guardian.
const log = (...a) => console.log(new Date().toISOString(), '[agent37-maker-watchdog]', ...a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeState(s) { try { atomicWriteJson(STATE_FILE, s); } catch (e) { log('state write failed:', e.message); } }
function heartbeat() { const hb = readJson(HEARTBEATS) || {}; hb['agent37-maker-watchdog'] = Date.now(); try { atomicWriteJson(HEARTBEATS, hb); } catch { /* best-effort */ } }

// ── Telegram (two mute gates, re-read every call) ───────────────────────────────
function httpPostTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15_000 },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('telegram timeout')); });
    req.write(body); req.end();
  });
}
async function sendTelegram(text, transport = httpPostTelegram) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') { log('Telegram muted (TELEGRAM_ALERTS_ENABLED=false) — trigger logged only'); return false; }
  if (process.env.MAKER_WATCHDOG_TELEGRAM_MUTED === 'true') { log('Telegram muted (MAKER_WATCHDOG_TELEGRAM_MUTED=true) — trigger logged only'); return false; }
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — trigger logged only'); return false; }
  try { await transport(text); return true; } catch (e) { log('sendTelegram error:', e.message); return false; }
}

function formatResults(results) {
  return results.map((r) => {
    if (r.ok === false) return `  • ${r.venue}: ERROR — ${r.error}`;
    const c = r.cancelled == null ? '?' : r.cancelled;
    const believed = r.venueOpenBefore != null ? `, venue-open-before ${r.venueOpenBefore}` : '';
    // Il capitale che quegli ordini impegnavano: è la cifra che dice se alzarsi adesso o domattina.
    // `null` (non leggibile) resta detto come tale — mai uno zero di comodo.
    const usd = r.notionalUsd != null ? `, $${Number(r.notionalUsd).toFixed(2)} freed` : '';
    return `  • ${r.venue}: ${c} cancelled${r.simulated ? ' (dry-run/disarmed)' : ''}${believed}${usd}`;
  }).join('\n');
}

// One poll. Returns a small status object (also used by the test harness). `deps` injects the clock,
// the cancel-all call, and the Telegram transport so the trigger/quiet behaviour can be driven offline.
async function poll(deps = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const doCancelAll = deps.cancelAllOrders || cancelAllOrders;
  const buildProviders = deps.buildCancelCredsProviders || buildCancelCredsProviders;
  const transport = deps.transport; // undefined → real Telegram (with its mute gates)

  const hb = readJson(HB_FILE);
  const state = readJson(STATE_FILE) || { triggeredForEpisode: false, lastTriggerTs: null, lastHeartbeatTs: null, lastStalenessSec: null, missingLogged: false };

  // ── Heartbeat file absent/malformed → "never started", NOT "died". Never trigger; log once, stay quiet.
  if (!hb || typeof hb.ts !== 'number') {
    if (!state.missingLogged) { log('no valid maker heartbeat (data/maker-heartbeat.json) — treating as NEVER STARTED, not died. Standing by, will not cancel.'); state.missingLogged = true; }
    writeState(state);
    return { action: 'quiet-no-heartbeat' };
  }
  state.missingLogged = false;

  // A fresh heartbeat (newer ts than last seen) means the maker is alive again → reset the episode latch.
  if (state.lastHeartbeatTs != null && hb.ts > state.lastHeartbeatTs) state.triggeredForEpisode = false;
  state.lastHeartbeatTs = hb.ts;

  const stalenessSec = Math.round((nowMs - hb.ts) / 1000);
  if (stalenessSec <= DEADMAN_SEC) {
    state.lastStalenessSec = stalenessSec;
    writeState(state);
    return { action: 'quiet-fresh', stalenessSec };
  }

  // ── STALE beyond the dead-man threshold ──
  if (state.triggeredForEpisode) {           // already fired for this stale episode → stay quiet
    state.lastStalenessSec = stalenessSec;
    writeState(state);
    return { action: 'already-triggered', stalenessSec };
  }

  log(`DEAD-MAN TRIGGER: maker heartbeat is ${stalenessSec}s stale (> ${DEADMAN_SEC}s). Cancelling ALL open orders on every configured venue.`);
  let results = [];
  try {
    // Live cancel when L2 creds are stored; dry-run (simulated) when genuinely absent.
    const credsProviders = await buildProviders();
    results = await doCancelAll({ credsProviders });
  } catch (e) { log('cancel-all threw:', e.message); results = [{ venue: 'polymarket', ok: false, error: (e && e.message) || String(e), cancelled: 0 }]; }

  state.triggeredForEpisode = true;
  state.lastTriggerTs = nowMs;
  state.lastStalenessSec = stalenessSec;
  state.lastTriggerResults = results;
  writeState(state);

  const totalCancelled = results.reduce((a, r) => a + (Number.isFinite(r.cancelled) ? r.cancelled : 0), 0);
  log(`cancel-all complete: ${totalCancelled} cancelled across ${results.length} venue(s). ${formatResults(results).replace(/\n/g, ' | ')}`);

  // ── IL REFERTO, DOVE SI GUARDA ──────────────────────────────────────────────────────────────────
  // Try/catch suo e DOPO la cancellazione: un file che non si scrive non deve poter interferire con il
  // guardiano, e il guardiano ha già fatto la sua parte. Se il deposito fallisce lo si dice — resterebbe
  // solo il log di processo, cioè esattamente il buco che questo blocco esiste per chiudere.
  const evento = costruisciCancellazione({
    at: nowMs,
    stalenessSec,
    thresholdSec: DEADMAN_SEC,
    heartbeatTs: (hb && typeof hb.ts === 'number') ? hb.ts : null,
    results,
  });
  try {
    const w = (deps.registraCancellazione || registraCancellazioneDiEmergenza)(evento);
    if (!w.ok) log(`avviso cancellazione di emergenza NON depositato (${w.reason}) — resta solo in questo log`);
    else log(`avviso depositato per la dashboard: ${evento.ordiniCancellati} ordini su ${evento.mercatiToccati} mercati`
      + `${evento.capitaleUsd != null ? `, $${evento.capitaleUsd.toFixed(2)} tornati liberi` : ', capitale non leggibile'}`
      + ` · battito fermo da ${stalenessSec}s contro una soglia di ${DEADMAN_SEC}s`);
  } catch (e) { log('avviso cancellazione di emergenza NON depositato:', e.message); }
  await sendTelegram(`🛑 <b>MAKER DEAD-MAN TRIGGERED</b>\nagent35 heartbeat stale <b>${stalenessSec}s</b> (&gt; ${DEADMAN_SEC}s dead-man).\nIssued cancel-all:\n${formatResults(results)}`, transport);

  return { action: 'triggered', stalenessSec, results, evento };
}

async function loop() {
  try { await poll(); } catch (e) { log('poll failed (non-fatal):', e.message); }
  heartbeat();
  setTimeout(loop, POLL_MS);
}

function main() {
  log(`starting — polling ${HB_FILE} every ${POLL_MS}ms; dead-man threshold ${DEADMAN_SEC}s. Cancel-only surface (cannot place). NOTE: a same-host watchdog does NOT survive host death — that is covered only by the venue-native order TTL.`);
  loop();
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

if (require.main === module) main();

module.exports = { poll, sendTelegram, formatResults, HB_FILE, STATE_FILE, DEADMAN_SEC };
