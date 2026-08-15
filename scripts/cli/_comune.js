'use strict';
// scripts/cli/_comune.js — la parte condivisa dei comandi da terminale che sostituiscono il pannello.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════
// Il pannello Next.js è stato tolto dalla flotta il 15 agosto 2026: le decisioni si prendono da qui.
// Questo file NON aggiunge nessuna regola e NON duplica nessuna aritmetica: legge e scrive attraverso
// gli stessi moduli che usano gli agent (`lib/maker/bot-enabled`, `lib/safety/kill-switch`,
// `lib/maker/auto-reprice-config`, `lib/maker/distanza-obiettivo`), così un comando e un agent non
// possono avere due idee diverse dello stesso stato. Ricopiare una soglia qui sarebbe il reperto D1.
//
// ═══ COSA NESSUN COMANDO PUÒ FARE, PER COSTRUZIONE ═══════════════════════════════════════════════
//   · accendere la modalità viva: `MAKER_MODE` non viene MAI scritto da qui — si cambia a mano in
//     `.env`, ed è l'unico interruttore che chiede una mano umana su un file;
//   · piazzare o cancellare un ordine: nessun comando importa `lib/venues/`, e `stato.js` lo verifica
//     su se stesso camminando `require.cache`;
//   · scavalcare il KILL: `avvia.js` lo LEGGE e si rifiuta di partire mentre è attivo, invece di
//     spegnerlo.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ECOSYSTEM = path.join(ROOT, 'agents', 'ecosystem.config.js');
const ENV_FILE = path.join(ROOT, '.env');

// ── COLORI, ma solo se qualcuno li può vedere ───────────────────────────────────────────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (TTY ? `\u001b[${n}m${s}\u001b[0m` : String(s));
const col = { grassetto: c(1), spento: c(90), rosso: c(31), verde: c(32), giallo: c(33), ciano: c(36) };

const titolo = (t) => console.log('\n' + col.grassetto(t) + '\n' + col.spento('─'.repeat(Math.max(10, t.length))));
/** L'intenzione, PRIMA di toccare qualcosa. Ogni comando la stampa: si dichiara, poi si fa. */
const staPerCambiare = (righe) => {
  console.log('\n' + col.giallo('STA PER CAMBIARE:'));
  for (const r of [].concat(righe)) console.log('  → ' + r);
};
/** Il fatto, DOPO. Mai la stessa frase dell'intenzione: una è una promessa, l'altro è un riscontro. */
const haCambiato = (righe) => {
  console.log('\n' + col.verde('HA CAMBIATO:'));
  for (const r of [].concat(righe)) console.log('  ✓ ' + r);
};
const nienteDaCambiare = (perche) => console.log('\n' + col.spento('NIENTE È CAMBIATO: ' + perche));
const errore = (m) => { console.error('\n' + col.rosso('RIFIUTATO: ') + m); process.exitCode = 1; };

// ── .env: si LEGGE, e una sola chiave si scrive (mai MAKER_MODE) ────────────────────────────────
function leggiEnvFile() {
  const out = {};
  let txt;
  try { txt = fs.readFileSync(ENV_FILE, 'utf8'); } catch { return { presente: false, valori: out }; }
  for (const riga of txt.split('\n')) {
    const m = riga.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2].replace(/\r$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return { presente: true, valori: out };
}

/** Carica `.env` nel processo SENZA sovrascrivere ciò che la shell ha già deciso. */
function caricaEnv() {
  const { valori } = leggiEnvFile();
  for (const [k, v] of Object.entries(valori)) if (process.env[k] === undefined) process.env[k] = v;
  return valori;
}

// ── ecosystem.config.js: i processi che decidono un prezzo ──────────────────────────────────────
// ⚠ SI DERIVANO, non si elencano a mano. Un elenco scritto a mano difende l'invariante finché
// qualcuno si ricorda di aggiornarlo; un processo nuovo che decidesse un prezzo senza dichiarare la
// manopola passerebbe inosservato. È la stessa scelta di `lib/maker/distanza-2c.test.js` §6.
const DECIDE_UN_PREZZO = /agent41-realloc-scheduler|agent40-manual-reprice/;

function processiCheDecidonoUnPrezzo() {
  delete require.cache[require.resolve(ECOSYSTEM)];
  const cfg = require(ECOSYSTEM);
  return (cfg.apps || []).filter((a) => typeof a.script === 'string' && DECIDE_UN_PREZZO.test(a.script));
}

// ── LA FLOTTA VIVA, NON QUELLA DICHIARATA ───────────────────────────────────────────────────────
// ⚠ IL FILE E IL RUNTIME SONO DUE COSE DIVERSE, e la prima stesura di `stato.js` mostrava solo il
// primo: leggeva `ecosystem.config.js`, stampava «processi definiti 11» e da quella riga era
// impossibile capire se un processo fosse vivo, morto o mai avviato. Il 15 agosto 2026 quella riga
// diceva 11 mentre la flotta girava davvero — e avrebbe detto 11 identico anche a flotta spenta.
// Un pannello che non sa distinguere «acceso» da «spento» non e' un pannello, e' una didascalia.
//
// `pm2 jlist` e' sola lettura (la famiglia 2 della policy lascia passare list/describe/env/logs; sono
// restart/stop/delete/reload/kill a chiedere). Un pm2 assente o muto vale «non lo so», mai «zero
// processi»: la differenza e' fra dichiarare l'ignoranza e dichiarare un guasto che non c'e'.
function flottaViva() {
  const { execFileSync } = require('child_process');
  for (const cmd of [['pm2', ['jlist']], ['npx', ['pm2', 'jlist']]]) {
    try {
      const out = execFileSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const arr = JSON.parse(out);
      if (!Array.isArray(arr)) continue;
      const per = new Map();
      for (const p of arr) {
        if (!p || typeof p.name !== 'string') continue;
        const e = p.pm2_env || {};
        per.set(p.name, { stato: e.status || 'ignoto', pid: p.pid || null, riavvii: e.restart_time ?? null, avviatoAl: e.pm_uptime || null });
      }
      return { leggibile: true, error: null, per };
    } catch (e) { var ultimo = e.message; }
  }
  return { leggibile: false, error: ultimo || 'pm2 non raggiungibile', per: new Map() };
}

// ── L'AMBIENTE DI UN PROCESSO VIVO ──────────────────────────────────────────────────────────────
// ⚠ `pm2 restart <nome> --update-env` NON rilegge `ecosystem.config.js` (§5.1): prende l'ambiente
// della shell. Quindi il valore scritto nel file e quello che il processo sta USANDO possono divergere
// senza che nessuna riga lo dica — ed e' proprio il caso della manopola della distanza, dove due
// processi con due valori diversi producono due prezzi diversi sullo stesso ordine.
// Si legge da `/proc/<pid>/environ`, come prescrive §5.3: `pgrep -f <nome>` qui non e' affidabile
// perche' il comando che lo esegue contiene il nome cercato e trova la propria shell.
function envDiProcesso(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return null;
  try {
    const grezzo = fs.readFileSync(`/proc/${Number(pid)}/environ`, 'utf8');
    const out = {};
    for (const voce of grezzo.split('\0')) {
      const i = voce.indexOf('=');
      if (i > 0) out[voce.slice(0, i)] = voce.slice(i + 1);
    }
    return out;
  } catch { return null; }
}

// ── conditionId ─────────────────────────────────────────────────────────────────────────────────
// Il venue li normalizza in minuscolo (`evaluateLiveMinMarketGate`), quindi si normalizza qui una
// volta sola: due grafie dello stesso mercato sarebbero due mercati diversi per la allowlist.
const RE_CONDITION_ID = /^0x[0-9a-f]{64}$/;

function normalizzaConditionId(grezzo) {
  const s = String(grezzo == null ? '' : grezzo).trim().toLowerCase();
  if (!s) return { ok: false, id: null, motivo: 'nessun conditionId indicato' };
  if (!s.startsWith('0x')) return { ok: false, id: null, motivo: `«${grezzo}» non comincia per 0x — un conditionId di Polymarket è 0x seguito da 64 cifre esadecimali` };
  if (s.length !== 66) return { ok: false, id: null, motivo: `«${grezzo}» è lungo ${s.length} caratteri invece di 66 (0x + 64) — è un tokenId o un id troncato, non un conditionId` };
  if (!RE_CONDITION_ID.test(s)) return { ok: false, id: null, motivo: `«${grezzo}» contiene caratteri non esadecimali dopo lo 0x` };
  return { ok: true, id: s, motivo: null };
}

// ── la coda di un giornale, senza costruire una stringa da 700 MB ───────────────────────────────
// `readFileSync(…,'utf8')` costruisce UNA stringa e V8 si ferma a ~512 MB: §4.10. Qui serve solo la
// coda, quindi si legge un blocco dal fondo e si scarta la prima riga, che è quasi certamente rotta.
function codaFile(file, byte = 4 * 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const dim = fs.fstatSync(fd).size;
    if (dim === 0) return '';
    const quanti = Math.min(byte, dim);
    const buf = Buffer.alloc(quanti);
    fs.readSync(fd, buf, 0, quanti, dim - quanti);
    const s = buf.toString('utf8');
    return quanti < dim ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* niente */ } }
}

const eta = (ms) => {
  if (!Number.isFinite(ms)) return 'età ignota';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s fa`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min fa`;
  return `${(m / 60).toFixed(1)} ore fa`;
};

module.exports = {
  ROOT, ECOSYSTEM, ENV_FILE, col, titolo, staPerCambiare, haCambiato, nienteDaCambiare, errore,
  leggiEnvFile, caricaEnv, processiCheDecidonoUnPrezzo, normalizzaConditionId, RE_CONDITION_ID,
  flottaViva, envDiProcesso,
  codaFile, eta,
};
