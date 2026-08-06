#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent37-maker-watchdog — the DEAD-MAN switch for the Polymarket maker.
//
// NAMED agent37, NOT agent36: slot 36 is already taken by agent36-book-velocity. A watchdog must be a
// SEPARATE process from the thing it watches — a timer inside an engine dies exactly when that engine
// dies, so it is not a watchdog at all. This runs on its own, polls the engines' heartbeats, and if one
// goes stale it cancels THAT ENGINE'S resting orders and alerts.
//
// ═══ DUE MOTORI, DUE DEAD-MAN — e perché non è più uno solo ═════════════════════════════════════════
// Fino al 6 agosto 2026 questo processo sorvegliava UN battito (agent35) e, quando si fermava,
// cancellava TUTTO. Quella notte è andata così:
//   00:14:02.338  agent35-maker completa un ciclo e poi si blocca 129 secondi.
//   00:16:03.029  battito fermo da 121s (soglia 120s) → cancel-all: nove ordini reali su cinque
//                 mercati, $663 tornati fermi.
// Ma quei nove ordini erano della CORSIA MANUALE, cioè di agent40 — che nello stesso intervallo stava
// facendo undici chiamate al venue ogni cinque secondi, vivo e regolare. agent35 non li aveva piazzati
// e non li avrebbe mai toccati: per tutta la notte aveva scritto «manual mode active, skip — the
// operator holds this market by hand». Il guardiano stava sorvegliando la cosa sbagliata, e ha
// distrutto il libro di un motore sano per la morte di un altro.
//
// Adesso ogni motore ha il suo battito e il suo ambito (lib/maker/battito-motori):
//   agent35 morto, agent40 vivo  → si cancellano SOLO gli ordini attribuiti ad agent35;
//   agent40 morto, agent35 vivo  → si cancellano SOLO gli ordini della corsia manuale;
//   ENTRAMBI morti               → spazzata totale, identica a oggi.
// Sulla notte del 6 agosto questa regola avrebbe cancellato zero ordini invece di nove, e avrebbe
// cancellato gli stessi nove un secondo dopo se agent40 fosse stato davvero morto.
//
// NON È UN INDEBOLIMENTO. La soglia è la stessa, il ritmo è lo stesso, e ciò che un motore morto
// possiede viene tolto come prima. Cambia solo che la sua morte non porta più via il libro dell'altro.
// Un ordine che il registro non riesce ad attribuire ('sconosciuto') non viene toccato da una
// cancellazione mirata — resta coperto dalla scadenza GTD del venue, che è il livello previsto per
// «non sappiamo di chi è» — e viene invece cancellato dalla spazzata totale, come sempre.
//
// WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT:
//   • Protects against: an engine crashing, hanging, or crash-looping while its orders rest on the venue.
//   • Does NOT protect against host death (VPS reboot / kernel panic / network partition of THIS box):
//     a watchdog on the same host dies with the host. That case is covered ONLY by the venue-native GTD
//     order expiry (lib/maker/order-ttl.js). Both layers are required; neither replaces the other.
//
// HARD SAFETY CONSTRAINT — this process is STRUCTURALLY INCAPABLE OF PLACING AN ORDER. Its only reachable
// venue surface is lib/maker/cancel-all.js → the cancel-only adapter (address-only signer). It does NOT
// import lib/venues/polymarket-clob-maker/* (the placement module) anywhere in its require tree —
// verificato anche per i moduli aggiunti qui (attribuzione-ordini, battito-motori) da
// lib/maker/dead-man-per-motore.test.js, che fallisce se qualcuno ce lo trascina dentro.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const https = require('https');
const { cancelAllOrders, cancelLaneOrdersAllVenues } = require('../lib/maker/cancel-all');
// I MOTORI CHE POSSONO POSSEDERE UN ORDINE, con il loro battito e la loro corsia. L'elenco vive lì e non
// qui: un terzo motore un giorno si aggiunge in un posto solo, e questo file continua a iterare.
const { statoMotori, decidiAmbito, MOTORI } = require('../lib/maker/battito-motori');
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
// I PERCORSI DEI BATTITI VIVONO IN lib/maker/battito-motori (MOTORI[].file), non qui: un guardiano che
// conosce i nomi dei file per nome è un guardiano che va modificato in due posti quando nasce un terzo
// motore. Questo resta esportato perché lo usano i test e chi cita «il battito del maker».
const HB_FILE      = MOTORI[0].file;                                              // agent35 writes; we READ
const STATE_FILE   = path.join(__dirname, '..', 'data', 'maker-watchdog-state.json'); // WE OWN THIS
const HEARTBEATS   = '/tmp/agent-heartbeats.json';                                 // shared fleet heartbeat

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
// Per-agent mute (mirrors BOOK_VELOCITY_TELEGRAM_MUTED / TRADER_AUDITOR_TELEGRAM_MUTED) so this one
// watchdog can be silenced without muting the fleet. The project-wide switch (TELEGRAM_ALERTS_ENABLED)
// is honoured too — this is not a guardian.
const log = (...a) => console.log(new Date().toISOString(), '[agent37-maker-watchdog]', ...a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
// Il file di stato è iniettabile per una ragione sola: questo processo decide se cancellare ordini
// VERI, quindi la sua decisione deve poter essere guidata per intero da un test — orologio, battiti,
// cancellazioni e stato — senza toccare lo stato del guardiano in esecuzione.
function writeState(s, file = STATE_FILE) { try { atomicWriteJson(file, s); } catch (e) { log('state write failed:', e.message); } }
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
// the cancel calls, the engine states and the Telegram transport so the whole decision can be driven
// offline, senza un venue e senza un orologio.
async function poll(deps = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const doCancelAll = deps.cancelAllOrders || cancelAllOrders;
  const doCancelLane = deps.cancelLaneOrdersAllVenues || cancelLaneOrdersAllVenues;
  const buildProviders = deps.buildCancelCredsProviders || buildCancelCredsProviders;
  const transport = deps.transport; // undefined → real Telegram (with its mute gates)

  // ── LO STATO DI OGNI MOTORE, POI LA DECISIONE ───────────────────────────────────────────────────
  // Due letture pure e separate: `statoMotori` dice chi batte, `decidiAmbito` dice cosa va cancellato.
  // La seconda non tocca né il disco né la rete, quindi è verificabile da sola — ed è la funzione che
  // il 6 agosto avrebbe risposto «corsie: [agent35]» invece di «tutto».
  const stateFile = deps.stateFile || STATE_FILE;
  const stati = deps.stati || statoMotori(nowMs, DEADMAN_SEC);
  const decisione = decidiAmbito(stati);
  const state = readJson(stateFile) || { motori: {}, lastTriggerTs: null, lastStalenessSec: null };
  if (!state.motori || typeof state.motori !== 'object') state.motori = {};

  // La latch è PER MOTORE, non globale: agent35 che muore non deve poter zittire lo scatto su agent40.
  // Un battito più fresco dell'ultimo visto significa «è tornato», e riarma quel motore.
  const morti = [];
  for (const s of stati) {
    const prev = state.motori[s.id] || { triggeredForEpisode: false, lastHeartbeatTs: null, missingLogged: false };
    if (s.stato === 'mai-avviato') {
      if (!prev.missingLogged) {
        log(`nessun battito valido per ${s.processo} (${path.basename(s.file)}) — trattato come MAI AVVIATO, non morto. Resto in attesa, non cancello niente.`);
        prev.missingLogged = true;
      }
      state.motori[s.id] = { ...prev, stato: s.stato, lastStalenessSec: null };
      continue;
    }
    prev.missingLogged = false;
    if (prev.lastHeartbeatTs != null && s.ts > prev.lastHeartbeatTs) prev.triggeredForEpisode = false;
    prev.lastHeartbeatTs = s.ts;
    prev.lastStalenessSec = s.stalenessSec;
    prev.stato = s.stato;
    state.motori[s.id] = prev;
    if (s.stato === 'morto' && !prev.triggeredForEpisode) morti.push(s);
  }

  if (decisione.ambito === 'niente' || morti.length === 0) {
    writeState(state, stateFile);
    const peggiore = stati.filter((s) => s.stalenessSec != null).sort((a, b) => b.stalenessSec - a.stalenessSec)[0] || null;
    return {
      action: morti.length === 0 && decisione.ambito !== 'niente' ? 'already-triggered' : 'quiet-fresh',
      stalenessSec: peggiore ? peggiore.stalenessSec : null,
      stati,
    };
  }

  // ── SI SCATTA, E SI DICE SU COSA ────────────────────────────────────────────────────────────────
  // `stalenessSec` resta il numero del motore PIÙ fermo fra quelli morti: è quello che ha fatto scattare.
  const stalenessSec = Math.max(...morti.map((s) => s.stalenessSec));
  const totale = decisione.ambito === 'tutto';
  const vivi = decisione.vivi.map((s) => s.processo).join(', ');
  log(`DEAD-MAN TRIGGER: ${morti.map((s) => `${s.processo} fermo da ${s.stalenessSec}s`).join(' · ')} (soglia ${DEADMAN_SEC}s).`
    + (totale
      ? ' NESSUN motore risponde più: cancello TUTTI gli ordini aperti su ogni venue configurato.'
      : ` ${vivi} è vivo e continua a lavorare: cancello SOLO gli ordini della/e corsia/e ${morti.map((s) => s.corsia).join(', ')}, e lascio in pace il resto del libro.`));

  let results = [];
  try {
    // Live cancel when L2 creds are stored; dry-run (simulated) when genuinely absent.
    const credsProviders = await buildProviders();
    if (totale) {
      results = await doCancelAll({ credsProviders });
    } else {
      // Una corsia per volta, ognuna con il suo referto: «5 cancellati» deve poter dire di CHI erano.
      for (const s of morti) results.push(...await doCancelLane(s.corsia, { credsProviders }));
    }
  } catch (e) { log('cancellazione fallita:', e.message); results = [{ venue: 'polymarket', ok: false, error: (e && e.message) || String(e), cancelled: 0 }]; }

  for (const s of morti) state.motori[s.id].triggeredForEpisode = true;
  state.lastTriggerTs = nowMs;
  state.lastStalenessSec = stalenessSec;
  state.lastTriggerResults = results;
  state.lastTriggerScope = { ambito: decisione.ambito, corsie: decisione.corsie, morti: morti.map((s) => s.id), vivi: decisione.vivi.map((s) => s.id) };
  writeState(state, stateFile);

  const totalCancelled = results.reduce((a, r) => a + (Number.isFinite(r.cancelled) ? r.cancelled : 0), 0);
  const lasciati = results.reduce((a, r) => a + ((r.skipped && r.skipped.length) || 0), 0);
  log(`cancellazione completata: ${totalCancelled} ordini tolti su ${results.length} venue`
    + (lasciati ? ` · ${lasciati} LASCIATI dove sono perché non erano della corsia morta` : '')
    + `. ${formatResults(results).replace(/\n/g, ' | ')}`);

  // ── IL REFERTO, DOVE SI GUARDA ──────────────────────────────────────────────────────────────────
  // Try/catch suo e DOPO la cancellazione: un file che non si scrive non deve poter interferire con il
  // guardiano, e il guardiano ha già fatto la sua parte. Se il deposito fallisce lo si dice — resterebbe
  // solo il log di processo, cioè esattamente il buco che questo blocco esiste per chiudere.
  const evento = costruisciCancellazione({
    at: nowMs,
    stalenessSec,
    thresholdSec: DEADMAN_SEC,
    heartbeatTs: morti[0] ? morti[0].ts : null,
    results,
    // CHI è morto e chi no. Senza questo, «5 ordini cancellati» in dashboard non dice se il libro è
    // sparito tutto o se è stata tolta una corsia sola — che è la differenza fra due mattine diverse.
    ambito: decisione.ambito,
    motoriMorti: morti.map((s) => ({ id: s.id, processo: s.processo, etichetta: s.etichetta, stalenessSec: s.stalenessSec })),
    motoriVivi: decisione.vivi.map((s) => ({ id: s.id, processo: s.processo, etichetta: s.etichetta, stalenessSec: s.stalenessSec })),
  });
  try {
    const w = (deps.registraCancellazione || registraCancellazioneDiEmergenza)(evento);
    if (!w.ok) log(`avviso cancellazione di emergenza NON depositato (${w.reason}) — resta solo in questo log`);
    else log(`avviso depositato per la dashboard: ${evento.ordiniCancellati} ordini su ${evento.mercatiToccati} mercati`
      + `${evento.capitaleUsd != null ? `, $${evento.capitaleUsd.toFixed(2)} tornati liberi` : ', capitale non leggibile'}`
      + ` · battito fermo da ${stalenessSec}s contro una soglia di ${DEADMAN_SEC}s`);
  } catch (e) { log('avviso cancellazione di emergenza NON depositato:', e.message); }
  await sendTelegram(`🛑 <b>MAKER DEAD-MAN TRIGGERED</b>\n`
    + `${morti.map((s) => `${s.processo} fermo da <b>${s.stalenessSec}s</b>`).join('<br>')} (&gt; ${DEADMAN_SEC}s dead-man).\n`
    + (totale
      ? 'Nessun motore risponde: <b>cancel-all</b>.\n'
      : `${vivi} è VIVO — cancellata solo la corsia <b>${morti.map((s) => s.corsia).join(', ')}</b>.\n`)
    + formatResults(results), transport);

  return { action: 'triggered', ambito: decisione.ambito, corsie: decisione.corsie, stalenessSec, results, evento, stati };
}

async function loop() {
  try { await poll(); } catch (e) { log('poll failed (non-fatal):', e.message); }
  heartbeat();
  setTimeout(loop, POLL_MS);
}

function main() {
  log(`starting — ${MOTORI.length} motori sorvegliati, uno scatto ciascuno, ogni ${POLL_MS}ms; soglia dead-man ${DEADMAN_SEC}s.`
    + ' Superficie di sola cancellazione (non puo piazzare). NOTA: un guardiano sullo stesso host NON sopravvive alla morte dell host — quel caso lo copre solo la scadenza GTD del venue.');
  for (const m of MOTORI) log(`  ${m.processo} → corsia «${m.corsia}» · battito ${path.basename(m.file)} · ${m.etichetta}`);
  log('  morto UNO → si cancella SOLO la sua corsia · morti TUTTI → spazzata totale.'
    + ' Un ordine non attribuibile non viene toccato da una cancellazione mirata: lo copre la scadenza GTD.');
  loop();
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

if (require.main === module) main();

module.exports = { poll, sendTelegram, formatResults, HB_FILE, STATE_FILE, DEADMAN_SEC, MOTORI };
