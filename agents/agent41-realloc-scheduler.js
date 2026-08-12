#!/usr/bin/env node
'use strict';
// agents/agent41-realloc-scheduler.js — IL RIALLOCATORE PERIODICO.
//
// ═══ COSA FA ═════════════════════════════════════════════════════════════════════════════════════════
// Ogni 6 ore fa due domande indipendenti, e gli basta che una sola risponda male per rifare il piano al
// saldo attuale e metterlo in opera con il reset completo (cancella, spegne, riaccende, piazza):
//   1 · VALIDITÀ  i mercati in gestione sono ancora quelli su cui il piano fu deciso? (risolti, non
//                 negoziabili, senza banda, in scadenza, col montepremi crollato sotto metà)
//   2 · VALORE    il piano che si farebbe oggi vale più del 20% in più di quello in produzione?
// Se entrambe rispondono bene, non fa niente. Il referto dice sempre quale delle due ha deciso.
//
// La logica non è qui: è in lib/maker/realloc-cycle.js, che non legge file e non tocca la rete. Questo
// file è solo il cablaggio — quale funzione vera sta dietro ogni dipendenza — più il timer e il registro.
// La separazione è ciò che rende il ciclo testabile senza un venue e senza capitale.
//
// ═══ È SPENTO FINCHÉ NON LO SI ACCENDE, E NON PER SBAGLIO ═══════════════════════════════════════════
// Questo è l'unico processo autorizzato a cancellare e piazzare ordini VERI senza che nessuno confermi.
// Perciò non basta che pm2 lo avvii: senza REALLOC_SCHEDULER_ENABLED=1 nell'ambiente il processo resta
// vivo e INERTE — nessuna lettura del venue, nessun piano, nessun ordine. Un `pm2 start` distratto, un
// riavvio della macchina o un `pm2 resurrect` non possono accenderlo: serve una modifica esplicita
// all'ecosystem e un --update-env.
//
// REALLOC_SCHEDULER_ENABLED dice se il processo esiste operativamente; NON dice se apre posizioni.
// Quello lo dice l'unico interruttore del sistema, `lib/maker/bot-enabled`: a bot FERMO il ciclo gira
// per intero — verifica, saldo, piano — ma il reset è in anteprima: niente cancellazioni, niente
// ordini. È il modo di guardarlo lavorare a capitale fermo, ed è anche il default.
//
// ═══ PERCHÉ UN PROCESSO NUOVO E NON UN'ESTENSIONE DI AGENT40 ════════════════════════════════════════
// agent40 riprezza ordini esistenti ogni pochi secondi; questo cancella tutto e ricostruisce ogni sei ore.
// Cadenze, raggio d'azione e conseguenze di un bug sono diversi al punto che condividere un processo
// significherebbe che un errore qui ferma il riprezzamento, e che spegnere il riprezzamento spegne anche
// questo. Separati, ognuno dei due si può fermare da solo — e questo, per costruzione, parte spento.
//
// ═══ IL REGISTRO ════════════════════════════════════════════════════════════════════════════════════
// data/realloc-scheduler.jsonl, una riga per passo più una riga di referto per ciclo. È append-only e
// sopravvive ai riavvii: serve a rispondere, a giorni di distanza, alla domanda «perché quel mercato è
// sparito dal piano e chi ha cancellato quell'ordine».

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

// ── IL CARICATORE DI `.env` — PERCHÉ UN RIAVVIO AUTOMATICO NON DEVE ROMPERE NIENTE ──────────────────
//
// ═══ COS'ERA ═══════════════════════════════════════════════════════════════════════════════════════
// Questo processo NON aveva un caricatore, a differenza di agent40 e del dashboard. Le sue variabili
// arrivavano dall'ambiente EREDITATO dalla shell che lo aveva avviato la prima volta e conservato nella
// descrizione in memoria di pm2 — 63 variabili fra cui `DATABASE_URL`, `KEY_CUSTODY_MASTER`,
// `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`, `MANUAL_ORDER_PLACEMENT`, nessuna delle quali sta nel
// blocco `env` di ecosystem.config.js né nel demone pm2 (misurato l'8 agosto 2026, CLAUDE.md §5 §3).
//
// La conseguenza era operativa e sgradevole: riavviare agent41 richiedeva di RICOSTRUIRE l'ambiente a
// mano leggendo `/proc/<pid>/environ` del processo vivo. Una procedura che funziona quando c'è una
// persona davanti, e che non esiste alle tre di notte — perché un riavvio AUTOMATICO (crash, OOM,
// `max_restarts` di pm2) non la esegue. Un crash notturno poteva quindi lasciare in piedi un processo
// senza le variabili che gli servono per leggere il saldo, firmare o parlare col database.
//
// ═══ PERCHÉ QUESTO LO RISOLVE ══════════════════════════════════════════════════════════════════════
// Le variabili tornano a venire da un FILE su disco, che sopravvive a qualunque riavvio e non dipende
// da chi ha lanciato il processo. Un crash a qualunque ora riparte con lo stesso ambiente della prima
// volta. Ed è esattamente lo stesso caricatore di agent40 (righe 56-62): non una seconda strada, la
// stessa — se un domani il formato del `.env` cambia, cambia per entrambi.
//
// ═══ LA REGOLA CHE LO RENDE SICURO: NON SOVRASCRIVE MAI ════════════════════════════════════════════
// `process.env[k] === undefined` è la condizione. Ciò che pm2 già passa VINCE sul file, quindi questo
// caricatore non può cambiare il comportamento di un processo che oggi parte bene: può solo riempire i
// buchi. È la ragione per cui aggiungerlo non è un rischio anche a fronte di una descrizione pm2 che
// contiene già tutto — e per cui `REALLOC_SCHEDULER_DRY_RUN`, che vive in quella descrizione e che
// l'operatore ha deciso di lasciare, resta esattamente dov'è e continua a essere inerte.
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file assente → si prosegue con l'ambiente che c'è */ }
}

const { runReallocCycle, INTERVAL_MS } = require('../lib/maker/realloc-cycle');
const { runAllocationReset } = require('../lib/maker/allocation-reset');
const { runBulkAllocation } = require('../lib/maker/bulk-allocate');
const { diagnoseExposure } = require('../lib/maker/manual-reset');
const { listManualOrders, cancelManualOrder, resolveCaps, OPERATOR_USER } = require('../lib/maker/manual-order');
const { readUsage } = require('../lib/safety/usage');
const { readAutoRepriceConfig, setAutoReprice } = require('../lib/maker/auto-reprice-config');
const { readTrackingConfig, setTracking } = require('../lib/maker/mm-tracking-config');
const { setManualMode } = require('../lib/maker/manual-mode');
const { setAutoClose } = require('../lib/maker/auto-close-config');
const { fetchVenuePositions } = require('../lib/maker/manual-reset');
const { resolveMarketRules } = require('../lib/maker/manual-order');
const { writeAllocatedCapital, readAllocatedCapitalAll } = require('../lib/maker/allocated-capital');
const { writeCollectorPriority } = require('../lib/rewards/collector-priority');
const { gambeDiUnaRiga } = require('../lib/rewards/plan-to-orders');
const { capPerMarketUsd, mercatiNecessari, MARKET_CAP_FIXED_USD } = require('../lib/rewards/concentration');
const TRIG = require('../lib/maker/trigger-capitale-fermo');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const killSwitch = require('../lib/safety/kill-switch');
const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
const UTIL = require('../lib/maker/utilizzo-capitale');
// ── IL FRENO DI PROVA (12 agosto 2026) ────────────────────────────────────────────────────────────
// Fino a oggi `REALLOC_SCHEDULER_DRY_RUN` non era letto da NESSUNA riga: era decorativo, e per due
// giorni ha fatto credere che agent41 fosse in prova mentre non lo era. Adesso frena davvero, su
// TUTTI i percorsi che possono arrivare al venue, ed e' fail-closed: assente o ambiguo ⇒ non piazza.
const FRENO = require('../lib/maker/freno-prova');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'realloc-scheduler.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'realloc-scheduler-state.json');
const POOLS_FILE = path.join(DATA_DIR, 'realloc-plan-pools.json');
// L'ULTIMO PIANO, RIDOTTO ALL'OSSO. Serve al mini-ciclo del trigger, che deve poter scegliere un
// mercato senza ricalcolare il piano — il ricalcolo costa ~52s e 687 MB, ed e' esattamente la cosa che
// il trigger esiste per non fare. Si scrivono solo i campi che servono a costruire le due gambe: il
// corpo intero del piano porta la curva dei fill tick per tick e pesa megabyte.
const ULTIMO_PIANO_FILE = path.join(DATA_DIR, 'realloc-ultimo-piano.json');

const ENABLED = process.env.REALLOC_SCHEDULER_ENABLED === '1';
// Il trigger a capitale fermo. Acceso per difetto quando lo scheduler e' acceso — e' una reattivita'
// dello stesso processo, non una funzione nuova — e si spegne con TRIGGER_CAPITALE_FERMO=0 senza
// toccare il ciclo fisso. NON e' un secondo interruttore sul piazzamento: quello resta AVVIA/FERMA,
// che il mini-ciclo rilegge a ogni controllo esattamente come il ciclo delle sei ore.
const TRIGGER_ATTIVO = process.env.TRIGGER_CAPITALE_FERMO !== '0';
// ── L'INTERRUTTORE FRA «RACCONTA» E «FA» È UNO SOLO, E NON È UNA VARIABILE D'AMBIENTE ────────────────
// Fino al 7 agosto 2026 era `REALLOC_SCHEDULER_DRY_RUN`, letta una volta all'avvio: per passare a
// ordini veri servivano una modifica a ecosystem.config.js e un riavvio, cioè due gesti che non
// somigliano a «premo avvia». Adesso decide `lib/maker/bot-enabled`, che l'operatore commuta dalla
// dashboard e che si rilegge A OGNI GIRO — quindi FERMA ha effetto dal ciclo successivo senza riavviare
// niente.
//
// La vecchia variabile è stata RIMOSSA, non lasciata come ripiego: né da qui, né da ecosystem.config.js.
// Due interruttori per la stessa decisione sono peggio di quello sbagliato da solo, perché chi ne
// spegne uno crede di aver spento la cosa. Se `bot-enabled` non è leggibile la risposta è FERMO — il
// ripiego è già dentro quel modulo e non ha bisogno di una seconda variabile che lo duplichi.
const { statoBot, botAttivo, apertureDallAvvio, registraMercatoAperto, FILE: FILE_INTERRUTTORE } = require('../lib/maker/bot-enabled');
const DASHBOARD = (process.env.REALLOC_DASHBOARD_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CLOB_BASE = process.env.POLY_CLOB_BASE || 'https://clob.polymarket.com';
// Un ciclo non parte mai nel primo minuto di vita del processo: un riavvio in serie di pm2 non deve
// tradursi in una raffica di reset. E se l'ultimo ciclo è più recente dell'intervallo, si aspetta il
// resto del tempo invece di ricominciare il conto — lo stato su disco è ciò che rende il timer
// indipendente dal ciclo di vita del processo.
const STARTUP_DELAY_MS = 60_000;
const VENUE_TIMEOUT_MS = 12_000;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// ── REGISTRO ────────────────────────────────────────────────────────────────────────────────────────
function scrivi(rec) {
  const riga = JSON.stringify({ ...rec, pid: process.pid });
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, riga + '\n'); }
  catch (e) { console.error('[realloc] registro non scrivibile:', e.message); }
}
function annuncia(livello, testo, dati) {
  const riga = `[realloc] ${testo}`;
  if (livello === 'error') console.error(riga, dati ? JSON.stringify(dati) : '');
  else console.log(riga, dati ? JSON.stringify(dati) : '');
}

// ── STATO PERSISTENTE ───────────────────────────────────────────────────────────────────────────────
function leggiStato() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function scriviStato(patch) {
  const st = { ...leggiStato(), ...patch };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }
  catch (e) { annuncia('error', 'stato non scrivibile', { error: e.message }); }
  return st;
}

function leggiPoolDelPiano() {
  try {
    const j = JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8'));
    return j && typeof j.pools === 'object' && j.pools ? j.pools : {};
  } catch { return {}; }
}
function scriviPoolDelPiano(pools) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(POOLS_FILE, JSON.stringify({ at: new Date().toISOString(), pools }, null, 2));
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 4_000_000) { req.destroy(new Error('risposta troppo grande')); } });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('risposta non JSON: ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout dopo ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

// ── IL VENUE ────────────────────────────────────────────────────────────────────────────────────────
// La fonte è il CLOB, non la cache locale: è la cache locale che il 3 agosto raccontava $124/g mentre il
// venue diceva $3/g. Qualunque cosa vada storta — rete, HTTP, JSON, campi mancanti — produce
// `readable:false`, che in market-validity.js NON è «invalido»: non fa scattare nulla e si riprova dopo.
async function leggiVenue({ marketId }) {
  let j;
  try { j = await getJson(`${CLOB_BASE}/markets/${encodeURIComponent(marketId)}`, VENUE_TIMEOUT_MS); }
  catch (e) { return { readable: false, error: e.message }; }
  if (!j || typeof j !== 'object' || j.error) return { readable: false, error: (j && j.error) || 'risposta vuota' };

  // Il montepremi è la somma delle righe di rate pubblicate. Un array VUOTO è un fatto letto («questo
  // mercato non paga»), l'ASSENZA dell'array non lo è: la prima diventa 0, la seconda resta illeggibile.
  const rates = j.rewards && Array.isArray(j.rewards.rates) ? j.rewards.rates : null;
  let pot = null;
  if (rates) {
    pot = 0;
    for (const r of rates) {
      const v = Number(r && r.rewards_daily_rate);
      if (!Number.isFinite(v)) { pot = null; break; }   // una riga illeggibile rende illeggibile il totale
      pot += v;
    }
  }
  const maxSpread = j.rewards ? Number(j.rewards.max_spread) : NaN;
  const minSize = j.rewards ? Number(j.rewards.min_size) : NaN;

  return {
    readable: true,
    closed: j.closed === true,
    active: typeof j.active === 'boolean' ? j.active : null,
    acceptingOrders: typeof j.accepting_orders === 'boolean' ? j.accepting_orders : null,
    rewardsDailyRate: pot,
    maxSpreadCents: Number.isFinite(maxSpread) ? maxSpread : null,
    minSizeShares: Number.isFinite(minSize) ? minSize : null,
    endDate: typeof j.end_date_iso === 'string' ? j.end_date_iso : null,
  };
}

// ── IL SALDO ────────────────────────────────────────────────────────────────────────────────────────
// Il lettore on-chain è lib/poly-chain-read.ts, TypeScript, che da un processo node semplice non si può
// richiedere. La dashboard però lo espone già in sola lettura su /api/rewards/balance — nessuna
// credenziale, nessuna firma, solo un eth_call sul saldo del proxy — e riusare quella strada evita di
// scrivere un SECONDO lettore di saldo che possa dire un numero diverso dal primo.
//
// `stale:true` significa che il refresh è fallito e si sta servendo una lettura precedente: qui vale
// come non leggibile. Un saldo di ieri farebbe calcolare un piano su capitale che potrebbe non esserci,
// e il ciclo si ripresenta fra sei ore comunque.
async function leggiSaldo() {
  let j;
  try { j = await getJson(`${DASHBOARD}/api/rewards/balance`, 15_000); }
  catch (e) { return { readable: false, error: `dashboard irraggiungibile: ${e.message}` }; }
  if (!j || j.rpcReachable !== true) return { readable: false, error: 'RPC non raggiungibile', payload: j || null };
  if (j.stale === true) return { readable: false, error: `saldo stantio (${j.ageSeconds}s): il refresh on-chain è fallito`, payload: j };
  if (!fin(j.pusdBalance)) return { readable: false, error: 'saldo mai letto (pusdBalance null): sconosciuto, non zero', payload: j };
  return { readable: true, usd: j.pusdBalance, readAt: j.readAt, ageSeconds: j.ageSeconds };
}

// ── IL PIANO, CALCOLATO IN UN PROCESSO FIGLIO CHE POI MUORE ─────────────────────────────────────────
//
// ═══ PERCHÉ NON PIÙ IN-PROCESS ═════════════════════════════════════════════════════════════════════
// Fino al 4 agosto 2026 `planFromCollection` si richiedeva qui dentro, con questa motivazione: «siamo in
// node semplice, non c'è il webpack che costringeva /api/rewards/allocate a spawnare un figlio». La
// ragione webpack era vera — e non era l'unica ragione per cui quella route spawna un figlio. Il suo
// commento lo dice per esteso: «frees the heavy journal memory when the child exits».
//
// Misurato: il calcolo del piano porta il processo da 41 MB a 687 MB (48 ore di journal + tape caricati
// in memoria), contro il tetto pm2 di questo processo, che è 400 MB. pm2 lo fermava e lo riavviava —
// con un arresto PULITO, `Stopping app` + SIGINT + exit code 0, indistinguibile da un `pm2 restart`
// manuale, e con `unstable restarts` a zero perché il processo era vissuto ben oltre `min_uptime`.
// Il 4 agosto è successo quattro volte su cinque cicli, sempre ~29 secondi dopo l'inizio del ciclo,
// cioè nel mezzo del calcolo.
//
// IN DRY RUN non è costato niente. In LIVE sarebbe l'incidente peggiore che questo processo possa
// causare: allocation-reset CANCELLA per primo e PIAZZA per ultimo, quindi un arresto in mezzo lascia
// il libro vuoto e il capitale fermo fino al ciclo successivo — sei ore dopo, senza che nessuno lo sappia.
//
// ═══ LA CORREZIONE ═════════════════════════════════════════════════════════════════════════════════
// La stessa di /api/rewards/allocate: il piano lo calcola un figlio che nasce, calcola, stampa e muore.
// I 687 MB vivono e muoiono con lui; questo processo resta sui suoi ~18 MB e il tetto di 400 MB torna a
// significare qualcosa. Le opzioni viaggiano su STDIN e non su argv: `onlyMarketIds` ed
// `excludeMarketIds` sono liste di conditionId, e su argv sarebbero un problema di escaping e di
// lunghezza massima che su stdin semplicemente non esiste.
const RUNNER_PIANO = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require("/root/prediction-market/lib/rewards/allocator").planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';
// Il piano misurato costa ~22s. 120s lascia margine per una macchina carica senza che un blocco vero
// resti appeso: se scade, il ciclo tratta il piano come fallito, che è già un esito previsto.
const PLAN_TIMEOUT_MS = 120_000;
// Il corpo del piano porta per ogni riga la curva dei fill tick per tick e il registro dei candidati:
// su un universo da ~110 valutati sono megabyte, non kilobyte.
const PLAN_MAX_BUFFER = 48 * 1024 * 1024;

/** Il piano, fuori da questo processo. Rifiuta invece di restituire un piano parziale o indovinato. */
function calcolaPianoFuoriProcesso(opzioni) {
  return new Promise((resolve, reject) => {
    const figlio = execFile('node', ['-e', RUNNER_PIANO],
      { timeout: PLAN_TIMEOUT_MS, maxBuffer: PLAN_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const coda = (stderr || '').trim().slice(-400);
          return reject(new Error(`il processo figlio del piano è fallito (${err.killed ? `timeout dopo ${PLAN_TIMEOUT_MS}ms` : err.message})${coda ? ` — ${coda}` : ''}`));
        }
        let piano = null;
        try { piano = JSON.parse(stdout); }
        catch (e) { return reject(new Error(`il processo figlio del piano non ha restituito JSON: ${e.message}`)); }
        resolve(piano);
      });
    figlio.on('error', (e) => reject(new Error(`impossibile avviare il processo figlio del piano: ${e.message}`)));
    try { figlio.stdin.end(JSON.stringify(opzioni)); }
    catch (e) { reject(new Error(`impossibile passare le opzioni al processo figlio: ${e.message}`)); }
  });
}

// `horizonFilter: true` è la stessa modalità «auto» del pannello: scarta i mercati troppo vicini alla
// risoluzione prima del knapsack.
// `onlyMarketIds`, quando c'è, restringe l'universo ai mercati già in gestione: è il piano di paragone
// del trigger di valore, non un piano da mettere in opera.
// `excludeMarketIds`, quando c'è, toglie dall'universo i mercati che la verifica al venue ha appena
// bocciato: il piano si rifà senza di loro e quel capitale va altrove. Un piano così NON è un piano
// ristretto — l'universo resta intero meno quei mercati — quindi le priorità del raccoglitore si
// scrivono lo stesso.
/** ── IL RENDICONTO DELLA SCALA SULLA PROFONDITÀ, UNA RIGA PER PIANO ─────────────────────────────────
 *
 *  Serve a rispondere nel tempo a una domanda sola: «quanto reward APPARENTE stiamo lasciando fuori, e
 *  il piano ne sta soffrendo?». Il primo numero è `lordoApparente` — la cifra con cui quei mercati
 *  avrebbero vinto il knapsack — e NON è capitale perso: è ottimismo che non viene più contabilizzato.
 *  Il secondo è il rapporto superstiti/minimi, che è ciò che rende il cancello sicuro: sotto 1 starebbe
 *  affamando il piano, e va visto subito invece di essere dedotto da una copertura bassa.
 *
 *  Sta qui e non nell'allocatore perché l'allocatore è puro e non ha un canale di log; e sta in una
 *  funzione sola perché i due percorsi che calcolano un piano (ciclo da 6h e ricalcolo leggero del
 *  mini-ciclo) devono raccontarlo con le stesse parole, altrimenti l'audit storico non è confrontabile. */
function annunciaScalaProfondita(piano, dove) {
  const s = piano && piano.selezione;
  if (!s || s.filtroProfondita !== true) return;
  const superstiti = s.profonditaSuperstiti, minimi = s.profonditaMinimiPerCoprire;
  const margine = (Number.isFinite(superstiti) && Number.isFinite(minimi) && minimi > 0)
    ? (superstiti / minimi) : null;
  annuncia('log',
    `scala profondità (${dove}): ${s.profonditaRidotti ?? 0} mercato/i con size RIDOTTA`
    + ` (−$${(s.profonditaRidottiCapitaleTagliatoUsd ?? 0).toFixed(2)} di capitale rispetto al tetto per mercato)`
    + ` · ${s.profonditaSottili} esclusi perché nessuna size piazzabile resta sotto la quota ${Math.round((s.profonditaSoglia || 0) * 100)}%`
    + ` (${s.profonditaTroppoSottili ?? 0} book troppo sottile, ${s.profonditaSottoMinimo ?? 0} sotto il minimo del venue)`
    + ` — lordo APPARENTE lasciato fuori $${(s.profonditaSottiliLordoApparenteUsd ?? 0).toFixed(2)}/g`
    + ` su montepremi $${(s.profonditaSottiliPotUsd ?? 0).toFixed(2)}/g`
    + (s.profonditaSottiliQuotaMediana != null ? ` (quota mediana ${(s.profonditaSottiliQuotaMediana * 100).toFixed(1)}%)` : '')
    + ` · superstiti ${superstiti} contro ${minimi} minimi per coprire il capitale`
    + (margine != null ? ` = ${margine.toFixed(1)}x` : '')
    + (margine != null && margine < 1 ? ' ⚠ LA SCALA STA AFFAMANDO IL PIANO' : ''),
    {
      esclusi: s.profonditaSottili,
      // Le tre cifre che il cancello non poteva produrre: quanti mercati sono entrati con meno soldi
      // invece di sparire, quanto capitale la profondità ha tolto loro, e come si dividono gli esclusi.
      ridotti: s.profonditaRidotti ?? null,
      capitaleTagliatoUsd: s.profonditaRidottiCapitaleTagliatoUsd ?? null,
      troppoSottili: s.profonditaTroppoSottili ?? null,
      sottoMinimo: s.profonditaSottoMinimo ?? null,
      lordoApparenteUsd: s.profonditaSottiliLordoApparenteUsd ?? null,
      potUsd: s.profonditaSottiliPotUsd ?? null,
      quotaMediana: s.profonditaSottiliQuotaMediana ?? null,
      soglia: s.profonditaSoglia ?? null,
      superstiti, minimiPerCoprire: minimi, margine,
      // Il confronto che il requisito chiede: cosa dichiara il piano DOPO il cancello. Il «prima» non
      // si ricalcola — costerebbe un secondo piano da tredici secondi — ma `lordoApparente` è
      // esattamente la differenza, quindi i due numeri insieme lo ricostruiscono.
      lordoDelPiano: piano.totals ? piano.totals.grossPerDay : null,
      realisticoDelPiano: piano.totals ? piano.totals.realisticPerDay : null,
      righeCapate: s.mercatiCapati ?? null,
    });
}

async function calcolaPiano({ capital, maxPerMarketUsd, onlyMarketIds = null, excludeMarketIds = null }) {
  const piano = await calcolaPianoFuoriProcesso({ capital, maxPerMarketUsd, onlyMarketIds, excludeMarketIds, horizonFilter: true });
  try { annunciaScalaProfondita(piano, onlyMarketIds ? 'piano ristretto' : 'ciclo 6h'); } catch (_) { /* un log non fa cadere un piano */ }

  // Il piano LIBERO dice al raccoglitore cosa tenere caldo: le righe scelte e i migliori candidati
  // valutati. Si scrive SEMPRE, anche in dry run e anche quando nessun trigger scatta — non è un'azione
  // sul capitale, è la lista di cosa guardare, e serve proprio nei cicli in cui non si fa niente.
  // Il piano RISTRETTO (onlyMarketIds) non la scrive: guarda solo dove siamo già, e prenderla per buona
  // congelerebbe la copertura sui mercati attuali, che è l'opposto del punto.
  //
  // La scrittura UNISCE, non sostituisce: quello che questo piano non sceglie più resta caldo ancora per
  // ore. È il motivo per cui questa riga conta anche — soprattutto — nei cicli automatici: una lista
  // scritta adesso non fa in tempo ad aiutare QUESTO ciclo, ma è quella che rende eseguibile il prossimo.
  if (!onlyMarketIds) {
    try {
      const pr = writeCollectorPriority(piano);
      annuncia('log', `priorità del raccoglitore aggiornate: ${pr.marketIds.length} mercati (${pr.freschi} da questo piano, ${pr.trattenuti} tenuti caldi dai piani precedenti, ${pr.scaduti} lasciati raffreddare)`);
    } catch (e) { annuncia('error', 'priorità del raccoglitore non scritte', { error: e.message }); }
    // ── E LO STESSO PIANO, RIDOTTO, PER IL MINI-CICLO DEL TRIGGER ────────────────────────────────
    // Anche questa si scrive SEMPRE, per lo stesso motivo della riga qui sopra: e' la memoria che
    // permette al trigger di scegliere un mercato senza ricalcolare niente. Un piano ristretto
    // (`onlyMarketIds`) non la scrive — guarda solo dove siamo gia', e congelerebbe la scelta.
    try { scriviUltimoPiano(piano); } catch (e) { annuncia('error', 'ultimo piano non salvato per il trigger', { error: e.message }); }
  }
  return piano;
}

// ── IL PIANO LEGGERO — «QUAL È IL MIGLIOR USO DEL CAPITALE LIBERO ADESSO» ───────────────────────────
//
// ═══ IL DIFETTO CHE CHIUDE ═══════════════════════════════════════════════════════════════════════════
// Il mini-ciclo del trigger sceglieva SOLO dal piano già salvato su disco. Se quel piano non esisteva
// (macchina appena avviata, `data/` ripulita, primo AVVIA), o se era vecchio, o se i suoi mercati non
// avevano più spazio per il capitale libero, il trigger rispondeva «nessuna azione» e il capitale
// restava fermo — pur essendoci mercati validi che nessuno stava guardando. Non era un caso di
// laboratorio: l'8 agosto 2026 il primo AVVIA ha prodotto esattamente quello per ore.
//
// ═══ PERCHÉ «LEGGERO», E QUANTO LEGGERO — MISURATO, NON STIMATO ═════════════════════════════════════
// Il piano pesante del ciclo a sei ore carica 48 ore di giornale e di tape: è quello che porta il
// processo figlio a oltre un gigabyte. Ma la finestra è un PARAMETRO, e la domanda del trigger è più
// stretta di quella del ciclo: non «come dovrebbe essere composto il portafoglio» ma «dove va il
// capitale libero adesso». Misurato l'8 agosto 2026 su questo conto ($620, tetto 20%), due esecuzioni
// per finestra:
//
//   finestra    tempo        RSS di picco      righe scelte
//   48h        20,9-24,4 s   1074-1086 MB      7   ← il ciclo pesante
//   12h        15,9 s          464 MB          7
//   6h         12,3-13,1 s     208-254 MB      7   ← SCELTA
//   3h         12,2-12,6 s     151-348 MB      7
//   1h         12,4 s          322 MB          7   ma la COMPOSIZIONE cambia
//
// A sei ore il piano è lo STESSO del pesante — stessi sette mercati, stesso capitale per mercato, in
// entrambe le esecuzioni — a un quarto della memoria e in metà tempo. A un'ora cambia: due righe si
// spostano ($24→$36 e $96→$84), cioè la finestra è diventata troppo corta perché le stime siano le
// stesse. Sei ore stanno a fattore sei dal punto in cui la risposta comincia a muoversi: è margine
// misurato, non un numero tondo.
//
// Sotto i tredici secondi c'è un pavimento che la finestra non tocca (board, feature, punteggi di fill):
// è il costo fisso del piano, ed è quello che rende possibile la promessa dei due minuti dall'AVVIA.
//
// ═══ COSA NON FA ════════════════════════════════════════════════════════════════════════════════════
// NON scrive `realloc-ultimo-piano.json` e NON tocca le priorità del raccoglitore: quelle due sono la
// memoria del ciclo pesante, e un piano calcolato su sei ore di storico non deve poter sostituire la
// memoria di uno calcolato su quarantotto. Per questo chiama `calcolaPianoFuoriProcesso` e non
// `calcolaPiano`.
const FINESTRA_LEGGERA_ORE = (() => {
  const v = Number(process.env.REALLOC_PIANO_LEGGERO_ORE);
  // Stessa regola di fine scala e dell'orizzonte: un valore illeggibile o assurdo viene SCARTATO in
  // favore del difetto misurato. Sotto le 2 ore la composizione cambia, e non si lascia che un `.env`
  // sbagliato peggiori una scelta presa con la misura in mano.
  return Number.isFinite(v) && v >= 2 && v <= 48 ? v : 6;
})();

async function pianoLeggero({ capital, maxPerMarketUsd, excludeMarketIds = null }) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - FINESTRA_LEGGERA_ORE * 3_600_000).toISOString();
  const p = await calcolaPianoFuoriProcesso({
    capital, maxPerMarketUsd, from, to,
    // TUTTE le protezioni restano quelle del piano pesante: il muro dell'orizzonte, la quota della coda
    // lunga, il tetto di categoria sui book vuoti, il tetto di credibilità della quota e — dal 9 agosto
    // 2026 — il cancello sulla profondità. «Leggero» vuol dire meno storico, non meno regole, e nessuna
    // di queste è un parametro che si passa da qui.
    horizonFilter: true, excludeMarketIds,
  });
  try { annunciaScalaProfondita(p, 'piano leggero'); } catch (_) { /* un log non fa cadere un piano */ }
  return p;
}

// ── L'ULTIMO PIANO, RIDOTTO ALL'OSSO ────────────────────────────────────────────────────────────────
// Solo i campi che servono a `gambeDiUnaRiga` per costruire le due gambe, piu' quelli che servono a
// scegliere fra i mercati. NON si salva `fillsByTick` ne' `realisticByTick`: sono la curva tick per tick
// di ogni riga, cioe' la parte che rende il corpo del piano un oggetto da megabyte.
const CAMPI_RIGA = [
  'marketId', 'name', 'shortId', 'capital', 'mid', 'tick', 'maxSpreadCents', 'sizePerSideShares',
  'pairCostUsd', 'computedDefaultOffsetTicks', 'minSizeShares', 'rif', 'grossPerDay', 'netPerDay',
  'realisticBestPerDay', 'realisticBestTick', 'snappedBid', 'snappedAsk', 'newestTsMs',
];
function scriviUltimoPiano(piano) {
  const righe = ((piano && piano.rows) || []).map((r) => {
    const o = {};
    for (const k of CAMPI_RIGA) if (r[k] !== undefined) o[k] = r[k];
    return o;
  });
  const corpo = {
    at: new Date().toISOString(),
    capitale: piano && piano.capital != null ? piano.capital : null,
    boardAtMs: piano && piano.board ? piano.board.atMs : null,
    righe,
  };
  const tmp = `${ULTIMO_PIANO_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(corpo, null, 2));
  fs.renameSync(tmp, ULTIMO_PIANO_FILE);
  return corpo;
}
function leggiUltimoPiano() {
  try {
    const d = JSON.parse(fs.readFileSync(ULTIMO_PIANO_FILE, 'utf8'));
    return { ok: Array.isArray(d.righe) && d.righe.length > 0, ...d };
  } catch (e) {
    return { ok: false, righe: [], motivo: e.code === 'ENOENT' ? 'nessun piano salvato finora: il primo ciclo completo lo scrive' : `piano salvato illeggibile (${e.message})` };
  }
}

// ── IL RESET ────────────────────────────────────────────────────────────────────────────────────────
// Cablaggio identico a quello di /api/maker/manual/bulk-allocate: stesse funzioni, stessa corsia
// cancel-only, stesso runBulkAllocation. Non esiste una seconda strada verso il venue, e questo processo
// non ne apre una: passa dalla stessa porta del bottone.
// ── QUANTE POSIZIONI — NESSUN TETTO, ED È UNA DECISIONE DEL 9 AGOSTO 2026 ──────────────────────────
// Qui c'era `MAX_POSIZIONI = 10`, e `applicaPolitiche` troncava le righe del piano a dieci con motivo
// `tetto-posizioni`. Veniva dalla mediana dei 21 maker misurati (Q1 6 · Q3 22) — una ricerca su una
// strategia che l'operatore non segue più — ed era tarato su un mondo in cui il tetto per mercato era
// una PERCENTUALE: con $620 e il 20%, dieci posizioni bastavano sempre e il tetto non mordeva mai.
//
// Col tetto FISSO a $130 quel numero diventa il vincolo che decide, e decide male. Misurato in
// diagnosi, stesso board e stesso capitale:
//
//     capitale   righe scelte dal piano   dopo il troncamento a 10   copertura
//     $1.200              10                      $1.200               100%
//     $1.400              13                      $1.120                80%
//     $1.800              15                      $1.044                58%
//     $2.000              15                      $1.200                60%
//
// Cioè: sopra ~$1.300 il tetto di posizioni faceva crollare la copertura invece di limitare il rischio,
// e la faceva crollare in modo BRUSCO — perché il troncamento prende le prime dieci righe e butta via
// proprio quelle grosse. Un limite che tagliava il capitale al lavoro senza ridurre l'esposizione per
// mercato (che è già limitata dai $130) non stava proteggendo niente.
//
// ADESSO IL NUMERO DI MERCATI È UNA CONSEGUENZA, NON UN PARAMETRO: `capitale ÷ 130`, limitato solo da
// quanti mercati qualificati il board offre davvero — cioè da quelli che passano banda, orizzonte, size
// minima del venue e il cancello di profondità. Se il pool non basta il piano copre meno del 90% e lo
// DICHIARA (`profonditaSuperstiti` contro `profonditaMinimiPerCoprire` nel referto), invece di essere
// tagliato in silenzio da una costante.
//
// L'ESPOSIZIONE RESTA LIMITATA, e va detto quale protezione fa quel lavoro adesso: il tetto per mercato
// ($130, YES+NO), l'obiettivo di utilizzo del capitale (90%, che è il tetto sul TOTALE impegnato), il
// tetto di apertura per giro nel mini-ciclo (`MAX_NUOVI_PER_GIRO = 6`, che limita la velocità) e il
// guardiano delle perdite. Nessuna di queste è stata toccata.

/**
 * Applica la politica di apertura alle righe del piano, PRIMA che diventino ordini.
 *
 * ═══ QUI C'ERANO DUE POLITICHE, E UNA E' STATA TOLTA IL 9 AGOSTO 2026 ═══════════════════════════════
 * La prima era la RAMPA — 5 mercati nuovi ogni 24h dall'AVVIA — e su QUESTO percorso era anche
 * incoerente, non solo troppo stretta: il reset CANCELLA tutto e ripiazza, quindi ogni riga del piano
 * si presenta come un mercato «nuovo» ogni sei ore, e un contatore che non si azzera mai avrebbe
 * bloccato la riallocazione periodica dopo il primo giorno. Non e' mai successo solo perche' la rampa
 * scadeva prima; la forma era sbagliata comunque.
 *
 * Resta il TETTO DI POSIZIONI, che e' la protezione vera di questo percorso e non e' un calendario: dice
 * quante posizioni si tengono aperte contemporaneamente, cioe' vincola l'esposizione e non l'anzianita'
 * della sessione. Quante aperture per giro le governa il target di utilizzo nel mini-ciclo
 * (`utilizzo-capitale.aperturaNuoviMercati`), che e' il posto dove quella domanda ha una risposta.
 */
function applicaPolitiche(rows, gestiti) {
  const inGestione = new Set((gestiti || []).map((x) => String(x).trim().toLowerCase()));
  // NESSUN TRONCAMENTO. Le righe del piano passano tutte: quante sono lo ha già deciso il knapsack
  // contro il tetto per mercato, e non c'è una seconda politica che le riduca dopo. `scartate` resta
  // (vuoto) perché il chiamante e il referto ne leggono la forma, e perché se un giorno tornasse una
  // politica di apertura questo è il posto dove vivrebbe.
  const tenute = (rows || []).slice();
  return { tenute, scartate: [], tetto: null, gestiti: inGestione.size };
}

async function eseguiReset({ rows, dryRunOnly }) {
  const diag = diagnoseExposure({});
  // LA POLITICA DI APERTURA SI APPLICA QUI, sulle righe che stanno per diventare ordini — non nel
  // piano. Il piano deve continuare a dire cosa sarebbe meglio fare; il tetto dice quanto di quel
  // meglio ci concediamo oggi, e la differenza fra i due va registrata invece che appianata.
  const gestiti = (() => { try { return readAutoRepriceConfig({}).enabledMarketIds || []; } catch { return []; } })();
  const pol = applicaPolitiche(rows, gestiti);
  if (pol.scartate.length) {
    scrivi({ tipo: 'politiche-apertura', tetto: pol.tetto, tenute: pol.tenute.length, scartate: pol.scartate });
    annuncia('log', `politiche di apertura: ${pol.tenute.length} righe tenute, ${pol.scartate.length} scartate`
      + ` dal tetto di ${pol.tetto} posizioni`);
  }
  return runAllocationReset(
    { rows: pol.tenute, dryRunOnly },
    {
      readEnabled: () => readAutoRepriceConfig({}).enabledMarketIds || [],
      readTracking: () => readTrackingConfig().marketIds || [],
      listOrders: ({ marketId }) => listManualOrders({ marketId }),
      // ── LA MANO CHE DISTINGUE I PROPRI ORDINI DA QUELLI DI UNA PERSONA ────────────────────────
      // Iniettata SOLO qui. Il pannello non la passa, e per il pannello e' giusto cosi': li' a premere
      // il bottone c'e' davvero l'operatore, quindi «cancella tutto cio' che e' a riposo» resta la cosa
      // che ha chiesto. Questo processo invece si sveglia da solo ogni sei ore, e senza questa riga
      // cancellerebbe anche gli ordini messi a mano dieci minuti prima.
      leggiOrigini: () => require('../lib/maker/origine-ordine').mappaOrigini(),
      cancelOrder: ({ orderId, marketId }) => cancelManualOrder({ orderId, marketId }, 'manual-ui'),
      setTrackingOff: ({ marketId, reason }) => setTracking({ marketId, enabled: false, by: 'riallocatore periodico', reason }),
      setEnabled: ({ marketId, enabled, reason }) => setAutoReprice({ scope: 'market', marketId, enabled, by: 'riallocatore periodico', reason }),
      setManual: ({ marketId, manual, reason }) => setManualMode({ marketId, manual, by: 'riallocatore periodico', reason }),
      // OGNI mercato del piano ha l'uscita automatica accesa PRIMA di avere ordini (fase 3 del reset).
      setAutoClose: ({ marketId, enabled, reason }) => setAutoClose({ scope: 'market', marketId, enabled, by: 'riallocatore periodico', reason }),
      // LA COPIA DI SICUREZZA DELLE REGOLE, sullo STESSO percorso del mini-ciclo (`copiaRegoleNelRipiego`).
      // Una funzione sola per i due chiamanti: due copie divergerebbero, e questo e' il posto in cui la
      // divergenza costerebbe di piu' — il ciclo delle sei ore accende tutto il piano in una volta.
      registraCatalogo: ({ marketId }) => copiaRegoleNelRipiego({ marketId }, 'riallocatore periodico'),
      // Serve solo a decidere se SPEGNERE l'uscita su un mercato che esce dal piano. Le posizioni si
      // leggono dal VENUE, e si incrociano con i due token del mercato: una posizione su uno dei due
      // libri è una posizione su questo mercato. Illeggibile ⇒ `leggibile:false`, e allora l'uscita
      // resta accesa — non si abbandona capitale per un dato che non si è riusciti a leggere.
      posizioneAperta: async ({ marketId }) => {
        try {
          const rules = resolveMarketRules(marketId);
          const pos = await fetchVenuePositions();
          if (!pos || pos.ok !== true || !Array.isArray(pos.positions)) {
            return { leggibile: false, aperta: null, error: (pos && pos.reason) || 'posizioni non leggibili' };
          }
          const token = new Set([rules && rules.tokenId, rules && rules.tokenIdNo].filter(Boolean).map(String));
          const aperta = pos.positions.some((p) => {
            const t = String(p.tokenId ?? p.asset ?? '');
            return t && token.has(t) && Number(p.size) > 0;
          });
          return { leggibile: true, aperta };
        } catch (e) { return { leggibile: false, aperta: null, error: e.message }; }
      },
      // `cancelOrder` non è una strada nuova verso il venue: è la stessa corsia cancel-only che il reset
      // usa già due righe più sopra. Serve a runBulkAllocation per RITIRARE una gamba rimasta sola
      // quando la sua controparte viene rifiutata — senza, una coppia a metà resterebbe sul libro.
      placeBulk: ({ rows: r, dryRunOnly: d }) => runBulkAllocation(
        // `origine: 'auto'` — QUI a premere il bottone non c'è nessuno. Il pannello lascia il difetto
        // manuale, perché lì una persona c'è davvero; questo processo si dichiara per quello che è, e
        // il timbro finisce nel registro accanto a ogni ordine. È quel timbro che, sei ore dopo, gli
        // permette di riconoscere i propri ordini e di NON cancellare quelli messi a mano.
        { rows: r, dryRunOnly: d, origine: 'auto' },
        {
          openNotionalUsd: diag.readable ? (diag.openNotionalUsd || 0) : 0,
          cancelOrder: ({ orderId, marketId }) => cancelManualOrder({ orderId, marketId }, 'manual-ui'),
          // Quanti ordini sono già stati inviati nella finestra del rate limit. Serve a fermarsi al
          // confine di una COPPIA invece di spezzarla a metà: con due gambe per mercato il ventunesimo
          // ordine rifiutato non è un mercato in meno, è mezza posizione viva. Non leggibile ⇒ 0, e il
          // gate per-ordine resta comunque l'ultima parola.
          ordersInWindow: (() => {
            try { const u = readUsage({ userId: OPERATOR_USER }); return Number.isFinite(u.ordersInWindow) ? u.ordersInWindow : 0; }
            catch { return 0; }
          })(),
        },
      ),
      audit: (rec) => { try { appendMakerAudit(rec); } catch { /* l'audit non blocca */ } },
    },
  );
}

// ── UN GIRO ─────────────────────────────────────────────────────────────────────────────────────────
let inCorso = false;

async function giro(motivoAvvio) {
  if (inCorso) { annuncia('log', 'giro già in corso, questo si salta'); return null; }
  inCorso = true;
  const avvio = Date.now();
  // IL FLAG SI RILEGGE ADESSO, non all'avvio del processo: FERMA deve avere effetto dal giro
  // successivo, non dal prossimo riavvio.
  const bot = statoBot();
  const r = apertureDallAvvio({ now: avvio });
  // `dryRunOnly` resta il nome del parametro a valle (runReallocCycle non cambia): qui significa
  // «calcola tutto ma non toccare il venue». Con il bot fermo è esattamente quello che vogliamo, e il
  // ciclo continua a girare per intero — verifica, saldo, piano — così il pannello ha sempre da mostrare.
  // Il freno di prova si somma al bot FERMO: basta uno dei due perche' il giro racconti senza toccare
  // il venue. Si RILEGGE a ogni giro, come l'interruttore — un freno che vale solo dal riavvio non e'
  // un freno.
  const frenoGiro = FRENO.statoFreno();
  const soloRacconto = !bot.enabled || frenoGiro.attivo;
  scrivi({ at: new Date(avvio).toISOString(), tipo: 'ciclo-avvio', motivoAvvio, dryRun: soloRacconto,
    botEnabled: bot.enabled, botBy: bot.by, botAt: bot.atIso, aperture: r,
    intervalloOre: INTERVAL_MS / 3_600_000, tettoPerMercatoUsd: MARKET_CAP_FIXED_USD });
  annuncia('log', `ciclo avviato (${motivoAvvio}) — bot ${bot.enabled ? 'AVVIATO' : 'FERMO'}`
    + (bot.enabled ? ` (${r.motivo})` : `: ${bot.motivo || 'nessun piazzamento, solo piano'}`));

  let referto;
  try {
    referto = await runReallocCycle({ dryRunOnly: soloRacconto }, {
      readEnabled: () => readAutoRepriceConfig({}).enabledMarketIds || [],
      readTracking: () => readTrackingConfig().marketIds || [],
      readVenue: leggiVenue,
      readPlanPools: leggiPoolDelPiano,
      writePlanPools: scriviPoolDelPiano,
      readBalance: leggiSaldo,
      // Il tetto di esposizione aperta, dalla STESSA fonte che il gate per-ordine consulta
      // (lib/safety/risk-limits). Il piano non può allocare più di quanto il libro possa portare:
      // sarebbe un piano che si ferma a metà sul cap cumulativo invece di essere il miglior piano
      // possibile dentro il limite. Si taglia il capitale, mai il tetto.
      readExposureCap: () => {
        const caps = resolveCaps({ userId: OPERATOR_USER });
        return { readable: caps.readable === true, maxOpenNotionalUsd: caps.maxOpenNotionalUsd, error: caps.error || null };
      },
      makePlan: calcolaPiano,
      runReset: eseguiReset,
      writeAllocatedCapital: (snap) => writeAllocatedCapital(snap),
      log: (rec) => scrivi({ tipo: 'passo', ...rec }),
      now: () => Date.now(),
    });
  } catch (e) {
    // Un'eccezione qui non è prevista: il ciclo cattura i suoi guasti. Se arriva, è un difetto del
    // cablaggio, e la risposta resta la stessa — non si tocca niente e si riprova fra sei ore.
    referto = { ok: false, azione: 'fermato', motivo: `eccezione non gestita nel cablaggio: ${e.message}`, stack: e.stack };
    annuncia('error', '!!! ECCEZIONE NEL CICLO — nessun ordine toccato', { error: e.message });
  }

  scrivi({ at: new Date().toISOString(), tipo: 'ciclo-referto', motivoAvvio, ...referto });
  scriviStato({ lastRunAt: avvio, lastRunIso: new Date(avvio).toISOString(), lastAzione: referto.azione, lastMotivo: referto.motivo });

  if (referto.azione === 'fermato') {
    annuncia('error', '!!! CICLO FERMATO — nessun ordine parziale, si riprova al prossimo giro fra 6 ore', { motivo: referto.motivo });
  } else if (referto.azione === 'reset') {
    annuncia('log', 'RESET ESEGUITO', {
      motivo: referto.motivo,
      piazzati: referto.reset && referto.reset.piazzamento ? referto.reset.piazzamento.placed : null,
      capitaleUsd: referto.piano ? referto.piano.capitale : null,
    });
  } else {
    annuncia('log', 'nessuna azione', { motivo: referto.motivo });
  }

  inCorso = false;
  return referto;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// IL MINI-CICLO: IL CAPITALE FERMO TORNA AL LAVORO SENZA ASPETTARE SEI ORE
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// Complementare al ciclo fisso, non alternativo: quello ogni sei ore RIBILANCIA (ricalcola il piano,
// cancella, ripiazza), questo reagisce nel giro di due minuti a un fatto solo — c'e' collaterale libero
// sopra soglia. Non ricalcola, non cancella, non sceglie mercati nuovi: prende il mercato che l'ultimo
// piano aveva gia' scelto e che adesso ha spazio, e gli rimette sopra il capitale liberato.
//
// LE SEI COSE CHE NON PUO' FARE, e sono strutturali, non promesse:
//   1. non cancella niente — l'unica azione che questo percorso non conosce. E' anche la risposta
//      completa a «e gli ordini messi a mano?»: non li tocca perche' non tocca NESSUN ordine esistente,
//      di nessuna origine. Aggiunge e basta.
//   2. non piazza a bot FERMO — stesso cancello del ciclo fisso, riletto a ogni controllo.
//   3. non si sovrappone al ciclo fisso — condivide `inCorso`, lo stesso lucchetto.
//   4. non piazza su un saldo illeggibile — un'incognita non e' uno zero.
//   5. non piazza su un board vecchio — il prezzo esce dal tocco vivo, e un tocco di venti minuti fa
//      non e' vivo.
//   6. non forza — se nessun mercato ha spazio, il capitale resta liquido e si riprova dopo.
//
// E passa dalla STESSA porta di tutto il resto: `gambeDiUnaRiga` per costruire le due gambe (la stessa
// funzione del piano e del pannello) e la stessa corsia di piazzamento del reset, col timbro
// `origine: 'auto'` — cosi' fra sei ore il ciclo fisso riconoscera' questi ordini come propri.
let ultimoTriggerAt = null;

/**
 * La corsia di piazzamento, con lo STESSO cablaggio del reset — timbro `origine: 'auto'`, stessa corsia
 * cancel-only per ritirare una gamba orfana, stesso conteggio degli ordini nella finestra del rate
 * limit. Estratta qui perche' due cablaggi diversi verso la stessa porta sono due modi di divergere.
 */
function piazzaCoppia(rows, diag) {
  return runBulkAllocation(
    // QUI c'era `dryRunOnly: false` CABLATO: il mini-ciclo piazzava a prescindere da qualunque flag.
    // E' il secondo dei due percorsi di agent41 verso il venue, e senza questa riga il freno avrebbe
    // coperto solo il ciclo da sei ore — cioe' avrebbe frenato il percorso che scatta ogni sei ore e
    // lasciato libero quello che scatta ogni dieci minuti.
    { rows, dryRunOnly: FRENO.statoFreno().attivo, origine: 'auto' },
    {
      openNotionalUsd: diag && diag.readable ? (diag.openNotionalUsd || 0) : 0,
      cancelOrder: ({ orderId, marketId }) => cancelManualOrder({ orderId, marketId }, 'manual-ui'),
      ordersInWindow: (() => {
        try { const u = readUsage({ userId: OPERATOR_USER }); return Number.isFinite(u.ordersInWindow) ? u.ordersInWindow : 0; }
        catch { return 0; }
      })(),
    },
  );
}

// Ogni effetto collaterale e' iniettabile — la stessa disciplina del resto del maker. Serve a poter
// eseguire QUESTA funzione, non una sua imitazione, con il piazzamento sostituito da un registratore:
// una simulazione che gira su una copia del codice non dimostra niente sul codice che gira davvero.
// QUANTO PUÒ ESSERE VECCHIO IL PIANO SALVATO perché valga ancora la pena partire da lui invece di
// ricalcolare. Un'ora: è la soglia che il Requisito 5 nomina, ed è coerente con il resto — il board si
// riscrive ogni 15 minuti, quindi a un'ora un piano ha visto passare quattro fotografie del mercato.
// Oltre, il ricalcolo leggero costa tredici secondi e risponde alla domanda di ADESSO.
const PIANO_FRESCO_MAX_MS = Number(process.env.REALLOC_PIANO_FRESCO_MAX_MS || 60 * 60_000);

/**
 * LE DUE PRECONDIZIONI DI UN MERCATO CHE NON ABBIAMO MAI TOCCATO, nell'ordine in cui contano.
 *
 * Non e' una regola nuova: e' la fase 3 di `runAllocationReset` (lib/maker/allocation-reset.js:302-353)
 * applicata al percorso che non l'aveva. Le stesse TRE scritture, nello stesso ordine, con lo stesso
 * verso di fallimento.
 *
 * ── PERCHE' SONO TRE E NON DUE (corretto sui dati vivi l'8 agosto 2026) ────────────────────────────
 * La prima stesura ne faceva due, omettendo `setEnabled` di proposito: il ragionamento era che la
 * allowlist di auto-reprice governa `MAKER_MODE=live-min`, che agent41 non usa — il suo processo ha
 * `MAKER_MODE=off`. Il ragionamento guardava la variabile sbagliata. La corsia manuale costruisce
 * l'adapter con `mode: 'live-min'` CABLATO (lib/maker/manual-order.js:733), qualunque cosa dica
 * l'ambiente del processo: quindi `evaluateLiveMinMarketGate` si applica SEMPRE a chi passa di qui,
 * agent41 compreso. Misurato dopo il riavvio delle 21:35: `manual-mode-inactive` era sparito — le due
 * scritture funzionavano — e ogni gamba moriva un gradino piu' in la', su `live-min-market-mismatch`.
 * La lezione: l'ambiente di un processo non dice quale modalita' una corsia CHIEDE.
 *
 * Il permesso resta comunque stretto dove conta: e' `manual: true` — la seconda scrittura — a tenere
 * agent35 fuori da questo libro, e quella non si allenta. La allowlist dice «qui si puo' operare», la
 * proprieta' manuale dice «e a operarci e' questo processo, non il motore».
 *
 * SE UNA RIESCE E LA SUCCESSIVA NO, si lascia com'e': niente ordini su quel mercato, e nessuna
 * scrittura di ritorno. E' il comportamento del reset, e si tiene per non divergere — la scrittura di
 * ritorno sarebbe essa stessa una scrittura che puo' fallire, e un mercato abilitato su cui nessuno
 * piazza costa un'occasione, non capitale. Il ciclo delle sei ore rimette ordine.
 *
 * @returns {Promise<{ok: boolean, motivo: string|null}>}
 */
// ── LA RIGA DEL BOARD NORMALIZZATO ──────────────────────────────────────────────────────────────────
// STESSO FILE che `resolveMarketRules` legge come prima scelta (lib/maker/manual-order.js:89). Il
// percorso e' ripetuto qui e non importato perche' li' e' una costante di modulo non esportata; se un
// giorno diventasse esportabile, questa e' la riga da sostituire. Il test verifica che i due percorsi
// coincidano leggendo entrambi i sorgenti, cosi' una divergenza non puo' passare inosservata.
//
// Sola lettura, e non solleva mai: un board illeggibile vale «nessuna riga», che a valle diventa
// «nessuna copia di sicurezza» — annotato, mai indovinato.
const BOARD_NORMALIZZATO = '/tmp/liquidity-rewards.json';

function rigaBoardNormalizzata(marketId, file = BOARD_NORMALIZZATO) {
  const id = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
  if (!id) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const righe = raw && Array.isArray(raw.markets) ? raw.markets : [];
    return righe.find((m) => m && String(m.marketId || '').toLowerCase() === id) || null;
  } catch { return null; }
}

/**
 * LA COPIA DI SICUREZZA DELLE REGOLE DI VENUE nel catalogo di ripiego.
 *
 * UNA funzione per i DUE percorsi che aprono mercati — il mini-ciclo del trigger e la fase 3 del reset
 * delle sei ore. Erano due closure separate nella prima stesura: due copie della stessa traduzione sono
 * due copie che possono divergere, e qui la divergenza costerebbe caro perche' il ciclo delle sei ore
 * accende tutto il piano in una volta.
 *
 * La fonte e' il board normalizzato, cioe' lo stesso file che `resolveMarketRules` legge come prima
 * scelta: il ripiego non puo' contenere numeri diversi da quelli su cui il mercato e' stato scelto.
 * Non solleva mai e non inventa: senza riga non si registra niente, e `upsertMarket` rifiuta da solo
 * un record a cui manchi uno dei quattro campi obbligatori.
 */
function copiaRegoleNelRipiego({ marketId }, by) {
  const riga = rigaBoardNormalizzata(marketId);
  if (!riga) return { ok: false, error: 'riga di board non trovata: nessuna regola da copiare nel ripiego' };
  const CATALOGO = require('../lib/maker/market-catalog');
  const rec = CATALOGO.recordDaRigaBoard(riga);
  if (!rec) return { ok: false, error: 'riga di board non traducibile in un record di catalogo' };
  return CATALOGO.upsertMarket(rec, { by,
    reason: 'copia di sicurezza delle regole di venue: se il mercato esce dal board — per rotazione o perche\' sta per risolvere — la gestione deve poter continuare' });
}

async function preparaMercatoNuovo(marketId, abilita, prendiInGestione, accendiUscita, registraCatalogo) {
  if (typeof abilita !== 'function') {
    return { ok: false, motivo: 'nessuna funzione setEnabled cablata: non si piazza su un mercato che la corsia manuale rifiutera per allowlist' };
  }
  if (typeof prendiInGestione !== 'function') {
    return { ok: false, motivo: 'nessuna funzione setManual cablata: non si piazza su un mercato che agent35 puo ancora scrivere' };
  }
  if (typeof accendiUscita !== 'function') {
    return { ok: false, motivo: 'nessuna funzione setAutoClose cablata: non si piazza su un mercato di cui non si puo accendere l uscita automatica' };
  }
  let en = null;
  try {
    en = await abilita({ marketId, enabled: true,
      reason: 'trigger a capitale fermo: mercato scelto dal ricalcolo, la corsia manuale deve poterci operare' });
  } catch (e) { en = { ok: false, error: e && e.message ? e.message : String(e) }; }
  if (!(en && en.ok)) {
    return { ok: false, motivo: `abilitazione non scritta (${(en && en.error) || 'esito non leggibile'})` };
  }
  let mn = null;
  try {
    mn = await prendiInGestione({ marketId, manual: true,
      reason: 'trigger a capitale fermo: il motore automatico si tiene fuori da questo mercato' });
  } catch (e) { mn = { ok: false, error: e && e.message ? e.message : String(e) }; }
  if (!(mn && mn.ok)) {
    return { ok: false, motivo: `gestione manuale non presa (${(mn && mn.error) || 'esito non leggibile'})` };
  }
  let ac = null;
  try {
    ac = await accendiUscita({ marketId, enabled: true,
      reason: 'trigger a capitale fermo: l uscita automatica e pronta PRIMA che il mercato abbia ordini' });
  } catch (e) { ac = { ok: false, error: e && e.message ? e.message : String(e) }; }
  if (!(ac && ac.ok)) {
    return { ok: false, motivo: `uscita automatica non accesa (${(ac && ac.error) || 'esito non leggibile'})` };
  }

  // ── LA QUARTA SCRITTURA, E L'UNICA CHE NON E' UN FERMO DURO ────────────────────────────────────
  // Le tre sopra decidono se il mercato e' operabile ADESSO: senza, ogni gamba muore a un gate, quindi
  // non ha senso proseguire. Questa decide se sara' gestibile DOPO, e la differenza cambia il verso del
  // fallimento.
  //
  // Il problema che chiude (9 agosto 2026): un mercato aperto da qui vive sulle regole del board, e il
  // board ruota ogni 15 minuti tenendo i primi 120 per montepremi. Quando un mercato ne esce mentre la
  // posizione e' ancora aperta, `resolveMarketRules` non trova piu' tick, banda, minSize e negRisk, e si
  // fermano insieme chiusura automatica, riprezzatura, tracking e qualunque ordine — cioe' la posizione
  // resta senza via d'uscita. Misurato: 10 mercati su 39 in gestione, quattro aperti la sera prima.
  // Il ripiego (`market-catalog`) esisteva gia' ed e' letto da `resolveMarketRules`; mancava solo chi lo
  // riempisse per i mercati aperti in automatico. Lo si riempie ADESSO, mentre il board ha ancora i dati:
  // dopo la rotazione non ci sarebbe piu' nessuna fonte locale da cui prenderli.
  //
  // PERCHE' NON E' UN FERMO DURO. Un catalogo non scritto non impedisce niente oggi — il board ha le
  // regole, il mercato e' operabile, gli ordini partono. Rinunciare al piazzamento per una copia di
  // sicurezza mancata sarebbe scambiare un danno certo (capitale fermo adesso) con uno possibile
  // (gestione persa se e quando il board ruota). Si registra il fallimento e si va avanti.
  let cat = null;
  if (typeof registraCatalogo === 'function') {
    try { cat = await registraCatalogo({ marketId }); }
    catch (e) { cat = { ok: false, error: e && e.message ? e.message : String(e) }; }
  } else {
    cat = { ok: false, error: 'nessuna funzione di registrazione cablata' };
  }
  return {
    ok: true, motivo: null,
    catalogo: cat && cat.ok === true,
    catalogoMotivo: cat && cat.ok === true ? null : ((cat && (cat.error || cat.motivo)) || 'esito non leggibile'),
  };
}

async function miniCiclo(decisione, deps = {}) {
  const leggiPiano = deps.leggiPiano || leggiUltimoPiano;
  const leggiOrdini = deps.listOrders || (() => listManualOrders({}));
  const piazza = deps.piazza || piazzaCoppia;
  const ricalcola = deps.pianoLeggero || pianoLeggero;
  const posizioni = deps.leggiPosizioni || readVenuePositions;
  const quantiNuovi = deps.aperturaNuovi || UTIL.aperturaNuoviMercati;
  const registra = deps.registraMercatoAperto || registraMercatoAperto;
  // ── LE DUE SCRITTURE CHE TRASFORMANO UN MERCATO SCELTO IN UN MERCATO PIAZZABILE ─────────────────
  // Stessa forma della fase 3 del reset (`runAllocationReset`), stesso `by` distinguibile: chi legge
  // l'audit deve poter separare «preso in gestione dal ciclo delle sei ore» da «preso in gestione dal
  // trigger a capitale fermo», perche' sono due decisioni con due raggi d'azione diversi.
  const abilita = deps.setEnabled
    || (({ marketId, enabled, reason }) => setAutoReprice({ scope: 'market', marketId, enabled, by: 'riallocatore · trigger capitale fermo', reason }));
  const prendiInGestione = deps.setManual
    || (({ marketId, manual, reason }) => setManualMode({ marketId, manual, by: 'riallocatore · trigger capitale fermo', reason }));
  const accendiUscita = deps.setAutoClose
    || (({ marketId, enabled, reason }) => setAutoClose({ scope: 'market', marketId, enabled, by: 'riallocatore · trigger capitale fermo', reason }));
  // La COPIA DI SICUREZZA delle regole di venue, presa dal board mentre il board ce le ha ancora.
  // La fonte e' lo STESSO file che `resolveMarketRules` legge come prima scelta
  // (`manual-order.js:89` → /tmp/liquidity-rewards.json): cosi' il ripiego non puo' contenere numeri
  // diversi da quelli su cui il mercato e' stato scelto. Se il board non ha la riga non si inventa
  // niente e non si registra niente.
  const registraCatalogo = deps.registraCatalogo
    || (({ marketId }) => copiaRegoleNelRipiego({ marketId }, 'riallocatore · trigger capitale fermo'));
  const etaBoard = deps.etaBoardMs !== undefined
    ? () => deps.etaBoardMs
    : () => { try { return Date.now() - fs.statSync(path.join(DATA_DIR, 'liquidity-rewards.json')).mtimeMs; } catch { return null; } };

  const t0 = Date.now();
  const referto = { tipo: 'mini-ciclo', at: new Date(t0).toISOString(), reason: 'capital-idle-trigger',
    saldoUsd: decisione.saldoUsd, sogliaUsd: TRIG.SOGLIA_USD, forzato: decisione.forzato === true };

  // 1 · IL BOARD DEVE ESSERE FRESCO. Il prezzo delle gambe esce dal tocco vivo (`rif`), che viene dalla
  //     fotografia del board: se quella e' vecchia, il «vivo» non e' vivo. Si guarda l'eta' del FILE,
  //     che e' l'unica cosa che dice davvero quando agent24 lo ha riscritto. Va PRIMA di tutto il resto
  //     perche' senza board non serve ne' leggere gli ordini ne' — soprattutto — ricalcolare un piano.
  const etaBoardMs = etaBoard();
  if (etaBoardMs == null || etaBoardMs > TRIG.ETA_BOARD_MAX_MS) {
    return { ...referto, esito: 'nessuna-azione', etaBoardMs,
      motivo: `il board ha ${etaBoardMs == null ? 'eta ignota' : Math.round(etaBoardMs / 60000) + ' minuti'} (limite ${TRIG.ETA_BOARD_MAX_MS / 60000}): il tocco su cui si quota non e' vivo` };
  }

  // 2 · QUANTO C'E' GIA' A RIPOSO, per mercato. E' l'unica lettura del venue di questo percorso, e
  //     avviene SOLO adesso — non a ogni controllo dei due minuti.
  let ordini;
  try { ordini = await leggiOrdini(); }
  catch (e) { return { ...referto, esito: 'nessuna-azione', motivo: `ordini a riposo non leggibili: ${e.message}` }; }
  if (!ordini || ordini.ok === false) {
    return { ...referto, esito: 'nessuna-azione', motivo: `ordini a riposo non leggibili: ${(ordini && ordini.error) || 'risposta vuota'}` };
  }
  const perMercato = TRIG.notionalePerMercato(ordini.orders || []);
  const aRiposo = Object.values(perMercato).reduce((t, x) => t + x, 0);

  // 3 · L'UTILIZZO DEL CAPITALE, MISURATO PRIMA DI AGIRE. Non e' un cancello: e' il metro che dice
  //     quanto di questo giro serve davvero, e che finisce nel referto perche' «il capitale e' fermo»
  //     smetta di essere un'impressione. Una lettura delle posizioni che fallisce NON ferma il giro —
  //     il cancello del trigger e' il saldo, e quello e' gia' stato letto — ma si dichiara.
  let posLette = null;
  try { posLette = posizioni(); } catch (e) { posLette = { readable: false, reason: e.message, positions: [] }; }
  const valorePos = posLette && posLette.readable === true ? UTIL.valorePosizioni(posLette.positions || []) : null;
  const utilPrima = UTIL.misuraUtilizzo({
    saldoUsd: decisione.saldoUsd, ordiniARiposoUsd: +aRiposo.toFixed(4), posizioniUsd: valorePos,
  });
  // Il capitale TOTALE per il tetto di concentrazione. Se le posizioni non si leggono si usa il solo
  // liquido — NON `liquido + ordini`, che era la stima gonfiata del doppio conteggio: un BUY a riposo e'
  // gia' coperto da quel liquido. Il ripiego e' quindi la stima piu' BASSA possibile, quindi il tetto
  // per mercato piu' stretto, e sbagliare in difetto qui vuol dire piazzare meno: il verso sicuro.
  // ── LA RICONCILIAZIONE, PRIMA DI AGIRE ────────────────────────────────────────────────────────
  // Il saldo con cui il TRIGGER ha deciso di svegliarsi e quello con cui la MISURA calcola quanto
  // impegnare devono essere lo stesso conto. Finche' nessuno li confrontava, uno dei due poteva
  // essere assurdo senza che niente lo dicesse — ed e' esattamente cio' che e' successo il 12 agosto.
  // Oltre soglia si FERMA il giro dichiarando il motivo: agire su un capitale che non si sa quanto
  // sia vuol dire impegnare denaro gia' impegnato altrove.
  // ⚠ SI RICONCILIA SOLO SE C'E' QUALCOSA DA CONFRONTARE. Una misura non leggibile perche' le
  // POSIZIONI non si leggono e' un caso tollerato per progetto — «il cancello del trigger e' il saldo,
  // e quello e' gia' stato letto» — e trattarlo come divergenza fermerebbe giri sani. La divergenza da
  // prendere e' fra due letture ENTRAMBE presenti che dicono numeri diversi: quella si', ferma.
  const ric = utilPrima.leggibile
    ? UTIL.riconcilia({
      a: decisione.saldoUsd, b: utilPrima.saldoUsd,
      etichettaA: 'saldo del trigger', etichettaB: 'saldo della misura di utilizzo',
    })
    : { concorde: true, scartoUsd: null, sogliaUsd: null, motivo: 'misura di utilizzo non leggibile: nessun confronto possibile, si prosegue col saldo del trigger (comportamento documentato)' };
  if (!ric.concorde) {
    annuncia('log', `mini-ciclo FERMATO — ${ric.motivo}`);
    scrivi({ at: new Date().toISOString(), tipo: 'mini-ciclo', esito: 'fermato-capitale-incoerente',
      motivo: ric.motivo, scartoUsd: ric.scartoUsd, sogliaUsd: ric.sogliaUsd,
      saldoTrigger: decisione.saldoUsd, saldoMisura: utilPrima.leggibile ? utilPrima.saldoUsd : null, pid: process.pid });
    return { azione: 'nessuna', motivo: ric.motivo, riconciliazione: ric };
  }
  const capitaleTotale = utilPrima.leggibile ? utilPrima.capitaleTotaleUsd : decisione.saldoUsd;
  const capMercato = capPerMarketUsd(capitaleTotale);
  // ── QUANTO SI PUNTA A IMPEGNARE IN QUESTO GIRO ──────────────────────────────────────────────────
  // Il deficit rispetto al 90%, mai piu' del LIBERO VERO. Fino al 9 agosto 2026 qui c'era
  // `decisione.saldoUsd`, cioe' il saldo PIENO: ma una parte di quel saldo copre gia' gli ordini BUY a
  // riposo (su questo venue il collaterale resta nel wallet fino al match), quindi il trigger poteva
  // puntare a impegnare capitale gia' promesso altrove. Misurato il 9 agosto: saldo $633,90 contro un
  // libero vero di $526,44 — $107,46 contati due volte. Ora si usa `utilPrima.liberoUsd`, che quel
  // nozionale lo ha gia' sottratto.
  const obiettivoUsd = utilPrima.leggibile ? Math.min(utilPrima.liberoUsd, utilPrima.deficitUsd) : decisione.saldoUsd;
  // ── QUANTO SI PUO' DAVVERO SPENDERE ────────────────────────────────────────────────────────────
  // Stesso difetto, secondo punto: `pianificaGiro` riceveva il saldo PIENO come disponibile, quindi
  // poteva allocare capitale gia' impegnato in ordini a riposo. Il libero vero lo ha gia' sottratto.
  // Ripiego sul saldo grezzo solo se la misura non e' leggibile, che e' il comportamento di prima.
  const spendibileUsd = utilPrima.leggibile ? utilPrima.liberoUsd : decisione.saldoUsd;

  // 4 · LE RIGHE FRA CUI SCEGLIERE. Prima l'ultimo piano se e' fresco (costa una lettura di file), e
  //     solo se quello non produce niente si RICALCOLA. E' l'ordine giusto: il caso comune — un piano
  //     di venti minuti fa con un mercato svuotato da una chiusura — non paga tredici secondi.
  const gambeCostruibili = (riga) => {
    const g = gambeDiUnaRiga(riga, riga.computedDefaultOffsetTicks);
    if (g.scarto) return { ok: false, motivo: `${g.scarto.motivo} — ${g.scarto.dettaglio}` };
    if (!g.rows) return { ok: false, motivo: 'nessuna riga costruita' };
    return { ok: true };
  };
  // ── QUANTI MERCATI NUOVI PUO' APRIRE QUESTO GIRO ────────────────────────────────────────────────
  // Fino al 9 agosto 2026 il numero veniva dalla RAMPA: 5 nuovi ogni 24h dall'AVVIA, e una volta finiti
  // il giro si fermava anche a capitale interamente libero — misurato, per diciotto ore di fila. Adesso
  // il numero viene dall'utilizzo appena misurato al passo 3: si apre finche' il capitale non e' al
  // lavoro, mai piu' di sei per giro. Il vincolo non ha memoria, quindi si riapre da se' non appena il
  // capitale torna libero — che e' esattamente il caso che la rampa gestiva al contrario.
  const ap = quantiNuovi({ utilizzo: utilPrima });
  const comuni = {
    notionalePerMercato: perMercato, capPerMercatoUsd: capMercato, gambeCostruibili,
    obiettivoImpegnoUsd: obiettivoUsd,
    nuoviAmmessi: ap.ammessi,
    motivoNuoviEsauriti: ap.motivo,
    mercatiGiaAperti: Object.keys(perMercato),
  };

  let righeCandidate = [];
  let motivoPassate = null;
  const piano = leggiPiano();
  const etaPianoMs = piano.ok && piano.at ? Date.now() - Date.parse(piano.at) : null;
  const pianoFresco = piano.ok && Number.isFinite(etaPianoMs) && etaPianoMs <= PIANO_FRESCO_MAX_MS;
  let giro = { scelte: [], motivoStop: piano.ok ? null : (piano.motivo || 'nessun piano salvato') };
  let fonte = null;
  if (pianoFresco) {
    righeCandidate = piano.righe;
    giro = TRIG.pianificaGiro({ ...comuni, righe: righeCandidate, disponibileUsd: spendibileUsd });
    fonte = `piano salvato (${Math.round(etaPianoMs / 60000)} min)`;
  }

  // ── IL RICALCOLO, QUANDO IL PIANO SALVATO NON BASTA ────────────────────────────────────────────
  // Tre casi, e sono tutti «il piano vecchio non risponde alla domanda di adesso»: non c'e', e' piu'
  // vecchio di un'ora, oppure c'e' ed e' fresco ma nessuna delle sue righe ha spazio per il capitale
  // libero. Il terzo e' quello che il Requisito 2 chiama per nome: prima il trigger si fermava li'.
  let pianoRicalcolato = null;
  if (!giro.scelte.length) {
    const perche = !piano.ok ? (piano.motivo || 'nessun piano salvato')
      : !pianoFresco ? `il piano salvato ha ${etaPianoMs == null ? 'eta ignota' : Math.round(etaPianoMs / 60000) + ' minuti'} (limite ${PIANO_FRESCO_MAX_MS / 60000})`
        : `il piano salvato non ha righe utilizzabili adesso (${giro.motivoStop})`;
    annuncia('log', `mini-ciclo: ricalcolo leggero — ${perche}`);
    const tRic = Date.now();
    try {
      pianoRicalcolato = await ricalcola({ capital: decisione.saldoUsd, maxPerMarketUsd: capMercato });
    } catch (e) {
      return { ...referto, esito: 'nessuna-azione', utilizzo: utilPrima,
        motivo: `${perche}, e il ricalcolo leggero e' fallito: ${e.message}` };
    }
    const righeFresche = (pianoRicalcolato && pianoRicalcolato.rows) || [];
    referto.ricalcolo = { motivo: perche, durataMs: Date.now() - tRic, righe: righeFresche.length,
      finestraOre: FINESTRA_LEGGERA_ORE };
    if (!righeFresche.length) {
      return { ...referto, esito: 'nessuna-azione', utilizzo: utilPrima,
        motivo: `${perche} — e il ricalcolo leggero non ha trovato nessun mercato ammissibile adesso:`
          + ' il capitale resta liquido perche' + ' non c\'e\' dove metterlo, non perche\' non si e\' guardato' };
    }
    righeCandidate = righeFresche;
    giro = TRIG.pianificaGiro({ ...comuni, righe: righeFresche, disponibileUsd: spendibileUsd });
    fonte = `ricalcolo leggero (${FINESTRA_LEGGERA_ORE}h, ${Date.now() - tRic}ms)`;
  }

  if (!giro.scelte.length) {
    return { ...referto, esito: 'nessuna-azione', motivo: giro.motivoStop, fonte,
      esaminate: (giro.esaminate || []).slice(0, 6), utilizzo: utilPrima,
      capitaleTotale: +capitaleTotale.toFixed(2), aRiposoUsd: +aRiposo.toFixed(2) };
  }

  // 4-bis · I TETTI DI CAPITALE, ALLINEATI AL PIANO DI ADESSO E AL CAPITALE DI ADESSO.
  //
  // Il tetto per mercato lo scriveva solo il ciclo da 6h, dopo un reset. Il mini-ciclo ricalcolava un
  // piano ogni dieci minuti e non lo scriveva mai: la fotografia restava quella delle 03:42 del 9 agosto
  // — dodici tetti per $600 in tutto, il capitale di ALLORA — mentre il capitale era salito a $850,82.
  // Da qui due guasti misurati: il 90% di utilizzo era irraggiungibile per costruzione (il massimo
  // teorico era 70,5%) e i mercati che il piano fresco sceglieva restavano senza tetto, cioe' senza
  // permesso di esporsi (`saltato-tetto-non-leggibile`, dieci volte su Dallas).
  //
  // Va QUI, prima del passo 5: i tetti devono esistere PRIMA che le gambe partano, altrimenti il primo
  // fill trova ancora la fotografia vecchia. La regola sta nel modulo puro (`TRIG.decidiTetti`), qui c'e'
  // solo il cablaggio: leggere, decidere, scrivere se serve.
  //
  // FALLISCE MORBIDO, di proposito. Un tetto non scritto vuol dire «niente esposizione nuova» a valle,
  // che e' il verso sicuro; fermare il giro per una scrittura fallita significherebbe invece lasciare
  // fermo del capitale per un file. Si dichiara nel referto e si prosegue.
  const leggiTetti = deps.leggiTetti || readAllocatedCapitalAll;
  const scriviTetti = deps.scriviTetti || writeAllocatedCapital;
  try {
    // Dove c'e' del denaro nostro: ordini a riposo PIU' posizioni aperte. Se le posizioni non si sono
    // potute leggere non si pota NIENTE — un mercato con una posizione viva che perdesse il tetto
    // resterebbe ingestibile, e «non ho potuto guardare» non e' «non c'e' niente».
    const attivi = posLette && posLette.readable === true
      ? Object.keys(perMercato).concat((posLette.positions || []).map((p) => String(p && (p.conditionId || p.marketId) || '')).filter(Boolean))
      : null;
    const tetti = TRIG.decidiTetti({
      righe: righeCandidate, capPerMercatoUsd: capMercato, capitaleTotaleUsd: capitaleTotale,
      snapshot: leggiTetti(), mercatiAttivi: attivi,
    });
    if (tetti.scrivi) {
      const w = scriviTetti({ rows: tetti.rows, capital: tetti.capital, by: 'riallocatore · trigger capitale fermo' });
      referto.tetti = { scritti: w && w.ok === true, motivo: tetti.motivo, mercati: tetti.rows.length,
        capitaleUsd: tetti.capital, aggiunti: tetti.aggiunti, aggiornati: tetti.aggiornati, potati: tetti.potati };
      annuncia('log', `mini-ciclo: tetti ${w && w.ok === true ? 'aggiornati' : 'NON scritti'} — ${tetti.motivo}`
        + ` (${tetti.rows.length} mercati, capitale $${tetti.capital == null ? '?' : tetti.capital.toFixed(2)})`);
    } else {
      referto.tetti = { scritti: false, motivo: tetti.motivo, mercati: tetti.rows.length };
    }
  } catch (e) {
    referto.tetti = { scritti: false, motivo: `decisione sui tetti fallita: ${e.message}` };
  }

  // 5 · LE GAMBE DI OGNI MERCATO SCELTO, con la STESSA funzione del piano e del pannello. Se una delle
  //     due non e' piazzabile non si piazza NESSUNA delle due di QUEL mercato — gli altri proseguono.
  // ── LE PASSATE: UN MERCATO RIFIUTATO NON FERMA IL GIRO ──────────────────────────────────────────
  // Il difetto che questo chiude (misurato il 9 agosto 2026, quattro cicli di fila): il mini-ciclo
  // sceglieva il mercato migliore del piano, la gamba veniva rifiutata da `mai-primo-sul-libro`, e il
  // giro finiva li'. Al giro dopo — dieci minuti — sceglieva LO STESSO mercato, perche' il piano non e'
  // cambiato e quel mercato e' ancora il migliore. Risultato: `0 piazzati, 1 rifiutati` alle 03:49,
  // 04:13, 04:25, 04:35, con $644 fermi e altri mercati del piano mai provati.
  //
  // `mai-primo-sul-libro` NON viene toccata, ed e' il punto: resta un rifiuto assoluto. Cambia solo cosa
  // si fa DOPO — si esclude quel mercato e si ripianifica sul resto del piano, invece di rinunciare.
  //
  // IL TETTO E' QUELLO CHE C'E' GIA': `MAX_MERCATI_PER_GIRO` (6). Non e' un numero nuovo, ed e' il
  // limite giusto perche' misura la stessa cosa — quanti mercati un solo giro puo' toccare. Senza, un
  // piano con trenta righe tutte rifiutate produrrebbe trenta tentativi di piazzamento in un giro.
  //
  // SI RIPROVA SOLO SU UN RIFIUTO ATTRIBUIBILE A UN MERCATO. Un rifiuto che non nomina un mercato (kill,
  // saldo, errore di rete) non si cura cambiando mercato: insistere sarebbe spam. Quindi si guarda il
  // campo `gate` dei risultati, e si esclude solo chi ha un gate della lista qui sotto.
  const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const GATE_DI_MERCATO = new Set(['mai-primo-sul-libro', 'live-min-market-mismatch', 'manual-mode-inactive',
    'rules-unreadable', 'mid-stale', 'end-of-scale', 'market-not-accepting-orders', 'market-closed']);
  const esclusi = new Set();
  const passate = [];

  const costruisciGambe = (scelte) => {
    const righeOrdine = [];
    const mercati = [];
    const nonPreparati = [];
    const senzaRipiego = [];
    return { righeOrdine, mercati, nonPreparati, senzaRipiego, scelte };
  };
  let acc = costruisciGambe(giro.scelte);
  let righeOrdine = acc.righeOrdine;
  let mercati = acc.mercati;
  const nonPreparati = acc.nonPreparati;
  const senzaRipiego = acc.senzaRipiego;
  const preparaScelte = async (scelte, righeOrdine, mercati) => {
  for (const s of scelte) {
    const g = gambeDiUnaRiga(s.riga, s.riga.computedDefaultOffsetTicks);
    if (g.scarto || !g.rows) continue;   // gia' filtrato dal predicato, ma il verdetto vale solo se ricontrollato

    // ── 5-bis · UN MERCATO NUOVO VA PRESO IN GESTIONE PRIMA DI RICEVERE ORDINI ────────────────────
    // Il difetto che questa riga chiude: il mini-ciclo sceglieva i mercati e piazzava, ma non faceva
    // MAI le tre scritture che la fase 3 del reset fa su ogni mercato del piano. Finche' sceglieva dal
    // piano salvato non si vedeva — quei mercati il reset li aveva gia' preparati. Dal momento in cui
    // puo' RICALCOLARE (piano vecchio, assente o senza spazio) sceglie mercati che nessuno ha mai
    // preparato, e allora ogni singola gamba veniva rifiutata al gate 1 di `placeManualOrder`
    // (`manual-mode-inactive`, lib/maker/manual-order.js:546). L'8 agosto 2026: 5 mercati scelti,
    // 5 rifiuti, 0 ordini, con il bot su AVVIA e $291 liquidi.
    //
    // Il gate NON viene toccato ne' allentato, ed e' il punto: resta esattamente com'e' per chiunque
    // altro, e continua a impedire che agent35 e questo processo scrivano sullo stesso libro. Qui si
    // soddisfa la sua PRECONDIZIONE — prendere davvero il mercato in gestione — invece di piazzare
    // sperando che qualcun altro l'abbia fatto. Su un mercato che questo giro non tocca, agent35
    // resta padrone come prima.
    //
    // SOLO I NUOVI. `nuovo` significa «nessun ordine nostro a riposo qui» (trigger-capitale-fermo.js:358):
    // un mercato che ordini gia' ce li ha e' gia' stato preparato da chi ce li ha messi, e riscriverlo
    // a ogni giro sporcherebbe due file di stato e i loro audit ogni dieci minuti per nulla —
    // `setManualMode` riscrive il record e appende una riga a ogni chiamata, non e' idempotente.
    //
    // E L'USCITA SI ACCENDE PRIMA DEGLI ORDINI, non dopo: e' la stessa regola della fase 3 del reset,
    // e vale qui per la stessa ragione. `runAutoCloseCycle` visita SOLO i mercati con l'opt-in acceso
    // (agent40 gli passa `readAutoCloseConfig().enabledMarketIds`), quindi un mercato aperto senza
    // questa riga avrebbe due gambe vive e nessuno che le chiuda su un fill. Tutte e tre sono FERMI
    // DURI: se una delle scritture non riesce, quel mercato esce dal giro e gli altri proseguono —
    // meglio un mercato in meno che un mercato con ordini e senza via d'uscita.
    //
    // La QUARTA (la copia delle regole nel catalogo di ripiego, 9 agosto 2026) NON e' un fermo duro:
    // riguarda la gestibilita' futura, non l'operabilita' di adesso. Si annota e si prosegue.
    if (s.nuovo === true) {
      const p = await preparaMercatoNuovo(s.riga.marketId, abilita, prendiInGestione, accendiUscita, registraCatalogo);
      if (!p.ok) {
        nonPreparati.push({ marketId: s.riga.marketId, titolo: s.riga.name || null, motivo: p.motivo });
        continue;
      }
      if (p.catalogo !== true) {
        senzaRipiego.push({ marketId: s.riga.marketId, titolo: s.riga.name || null, motivo: p.catalogoMotivo });
      }
    }

    righeOrdine.push(...g.rows);
    mercati.push({ marketId: s.riga.marketId, titolo: s.riga.name || null, allocatoUsd: s.allocatoUsd, nuovo: s.nuovo });
  }
  };
  await preparaScelte(giro.scelte, righeOrdine, mercati);
  if (nonPreparati.length) {
    annuncia('log', `mini-ciclo: ${nonPreparati.length} mercato/i NUOVI esclusi — non si e' potuto prenderli in gestione`
      + ` (${nonPreparati.map((x) => `${String(x.marketId).slice(0, 10)}…: ${x.motivo}`).join(' · ')})`);
  }
  // Non blocca niente, ma va DETTO: un mercato aperto senza copia delle regole e' un mercato che perde
  // la gestione il giorno in cui esce dal board, e nessun log successivo lo collegherebbe a questo giro.
  if (senzaRipiego.length) {
    annuncia('log', `mini-ciclo: ${senzaRipiego.length} mercato/i aperti SENZA copia delle regole nel catalogo di ripiego`
      + ` — resteranno gestibili solo finche' sono sul board`
      + ` (${senzaRipiego.map((x) => `${String(x.marketId).slice(0, 10)}…: ${x.motivo}`).join(' · ')})`);
  }
  if (!righeOrdine.length) {
    return { ...referto, esito: 'nessuna-azione', fonte, utilizzo: utilPrima, nonPreparati, senzaRipiego,
      motivo: nonPreparati.length
        ? `nessun mercato piazzabile: ${nonPreparati.length} scelti erano nuovi e non si e' potuto prenderli in gestione (${nonPreparati[0].motivo})`
        : 'nessuna gamba costruibile fra i mercati scelti' };
  }

  // 6 · IL PIAZZAMENTO, UNA SOLA CHIAMATA per tutte le gambe del giro. Stessa corsia del reset, stesso
  //     timbro. NESSUNA cancellazione: la corsia riceve `cancelOrder` solo perche' la usa per RITIRARE
  //     una gamba rimasta sola se l'altra viene rifiutata — e' l'unico uso, e riduce esposizione.
  const diag = deps.diag !== undefined ? deps.diag : diagnoseExposure({});
  let esito = await piazza(righeOrdine, diag);
  passate.push({ n: 1, mercati: mercati.map((m) => m.marketId), piazzati: esito && esito.placed, rifiutati: esito && esito.refused, saltati: esito && esito.skipped });

  // ── LE PASSATE SUCCESSIVE ───────────────────────────────────────────────────────────────────────
  // Si riprova SOLO se nessun ordine e' passato: se anche uno solo e' andato a segno il giro ha fatto il
  // suo lavoro, e insistere sugli altri mercati vorrebbe dire allargare il raggio d'azione oltre quello
  // che il tetto per giro concede. E si riprova SOLO escludendo i mercati che hanno un gate attribuibile
  // a loro: un rifiuto che non nomina un mercato (kill, saldo, rete) non si cura cambiando mercato.
  const gateDiMercato = (ris) => [...new Set((ris || [])
    .filter((r) => r && r.status === 'refused' && GATE_DI_MERCATO.has(String(r.gate)))
    .map((r) => normId(r.marketId)).filter(Boolean))];

  while (esito && esito.placed === 0 && passate.length < TRIG.MAX_MERCATI_PER_GIRO) {
    const bloccati = gateDiMercato(esito.results);
    if (!bloccati.length) break;                       // rifiuto non attribuibile: non si insiste
    const primaN = esclusi.size;
    bloccati.forEach((id) => esclusi.add(id));
    if (esclusi.size === primaN) break;                // niente di nuovo da escludere: si smette
    const restanti = (righeCandidate || []).filter((r) => !esclusi.has(normId(r.marketId)));
    if (!restanti.length) { motivoPassate = `tutti i mercati del piano sono stati provati (${esclusi.size} esclusi)`; break; }
    const g2 = TRIG.pianificaGiro({ ...comuni, righe: restanti, disponibileUsd: spendibileUsd });
    if (!g2.scelte.length) { motivoPassate = `nessun altro mercato del piano ha spazio (${g2.motivoStop})`; break; }
    const r2 = [];
    const m2 = [];
    await preparaScelte(g2.scelte, r2, m2);
    if (!r2.length) { motivoPassate = 'nessuna gamba costruibile fra i mercati rimasti'; break; }
    annuncia('log', `mini-ciclo: passata ${passate.length + 1} — ${bloccati.length} mercato/i esclusi`
      + ` (${bloccati.map((x) => x.slice(0, 10)).join(', ')}), si prova ${m2.map((x) => String(x.marketId).slice(0, 10)).join(', ')}`);
    esito = await piazza(r2, diag);
    passate.push({ n: passate.length + 1, mercati: m2.map((m) => m.marketId), piazzati: esito && esito.placed, rifiutati: esito && esito.refused, saltati: esito && esito.skipped, esclusi: bloccati });
    righeOrdine = r2; mercati = m2;
  }
  if (esito && esito.placed === 0 && passate.length >= TRIG.MAX_MERCATI_PER_GIRO) {
    motivoPassate = `tetto di ${TRIG.MAX_MERCATI_PER_GIRO} passate raggiunto: gli altri mercati si provano al giro dopo`;
  }

  // 7 · IL REGISTRO DELLE APERTURE. Dal 9 agosto 2026 non limita piu' niente — il tetto giornaliero e'
  //     stato tolto — ma resta la memoria di cosa ha aperto il bot da quando e' stato acceso, ed e'
  //     l'unica traccia che sopravvive a un riavvio. Si registra solo dopo un piazzamento riuscito.
  const registrati = [];
  if (esito && esito.placed > 0) {
    for (const m of mercati) {
      try { const rr = registra({ marketId: m.marketId }); if (rr && rr.ok && !rr.giaPresente) registrati.push(m.marketId); }
      catch { /* il registro non deve poter far fallire un ordine gia' mandato */ }
    }
  }

  // 8 · L'UTILIZZO DOPO, con il capitale che questo giro ha impegnato. E' una STIMA dichiarata come
  //     tale: il venue conferma gli ordini in modo asincrono, e la misura vera torna al giro dopo
  //     leggendo di nuovo saldo e ordini. Serve a rispondere subito a «quanto ci siamo avvicinati».
  const impegnatoOra = giro.allocatoUsd;
  // ── DERIVATO DALLA MISURA DI PRIMA, NON RICALCOLATO DA CAPO ────────────────────────────────────
  // Qui c'era `saldoUsd: Math.max(0, decisione.saldoUsd - impegnatoOra)` insieme a
  // `ordiniARiposoUsd: aRiposo + impegnatoOra`: lo STESSO importo sottratto dal saldo E aggiunto agli
  // ordini, cioe' contato due volte. Su questo venue un BUY a riposo tiene il collaterale nel wallet
  // fino al match, quindi piazzare NON abbassa il saldo. Il 12 agosto produceva «$273,11 al lavoro /
  // $273,11 totali · liberi $0,00» a fronte di un saldo vero di $663,11.
  // `misuraDopo` non accetta il saldo come parametro: l'errore non e' piu' esprimibile.
  const utilDopo = UTIL.misuraDopo(utilPrima, impegnatoOra, { motivoDeficit: giro.motivoStop });

  // 9 · L'AUDIT, con un motivo TUTTO SUO. Serve a poter contare nel tempo quante volte il trigger e'
  //     scattato e quanto capitale ha rimesso al lavoro, senza confonderlo coi cicli fissi.
  try {
    appendMakerAudit({
      ts: Date.now(), venue: 'polymarket', source: 'realloc-scheduler', op: 'capital-idle-trigger',
      reason: 'capital-idle-trigger',
      marketId: mercati.map((m) => m.marketId).join(','), capitaleUsd: impegnatoOra,
      saldoPrimaUsd: decisione.saldoUsd, sogliaUsd: TRIG.SOGLIA_USD,
      placed: esito && esito.placed, refused: esito && esito.refused,
      observed: { fonte, mercati: mercati.length, forzato: decisione.forzato === true,
        utilizzoPrimaPct: utilPrima.pct, utilizzoDopoPct: utilDopo.pct, targetPct: utilPrima.targetPct },
    });
  } catch { /* l'audit non blocca un ordine gia' mandato */ }

  return {
    ...referto, esito: 'allocato', fonte,
    mercati, marketId: mercati[0] && mercati[0].marketId, titolo: mercati[0] && mercati[0].titolo,
    allocatoUsd: impegnatoOra, residuoUsd: giro.residuoUsd, motivoStop: giro.motivoStop,
    apertureRegistrate: registrati, aperturaNuovi: ap,
    utilizzo: utilPrima, utilizzoStimatoDopo: utilDopo,
    capitaleTotale: +capitaleTotale.toFixed(2), aRiposoUsd: +aRiposo.toFixed(2),
    piazzati: esito && esito.placed, rifiutati: esito && esito.refused,
    // ── I SALTATI, CHE PRIMA SPARIVANO ─────────────────────────────────────────────────────────
    // `skipped` non entra ne' in `placed` ne' in `refused`: il 12 agosto tutte e 12 le gambe sono
    // tornate `skipped` per il tetto di esposizione, e il referto diceva «0 piazzati, 0 rifiutati» —
    // cioe' descriveva un blocco TOTALE con la stessa riga con cui descriverebbe l'inazione.
    saltati: esito && esito.skipped,
    // E il PERCHE', non solo il numero: senza il motivo un saltato resta invisibile quanto prima.
    motiviSaltati: (() => {
      const c = {};
      for (const x of ((esito && esito.results) || [])) {
        if (!x || x.status !== 'skipped') continue;
        const k = String(x.reason || 'motivo non dichiarato').slice(0, 120);
        c[k] = (c[k] || 0) + 1;
      }
      return Object.entries(c).map(([motivo, quante]) => ({ motivo, quante }));
    })(),
    nonPreparati, senzaRipiego, passate, motivoPassate,
    durataMs: Date.now() - t0, risultati: esito && esito.results,
  };
}

/** Il controllo periodico. Costa una lettura di saldo (in cache) e niente altro finche' non scatta. */
async function controlloCapitaleFermo({ forzatoDa = null } = {}) {
  if (inCorso) return;                    // il lucchetto, prima di qualunque I/O
  // ── I CANCELLI GRATUITI PRIMA DI QUELLO CHE COSTA (8 agosto 2026) ──────────────────────────────
  // `leggiSaldo` e' una chiamata HTTP al dashboard che a sua volta fa una lettura on-chain (cache TTL
  // 45s, sotto la cadenza di 120s: quindi ogni giro ne provocava una nuova). Farla PRIMA di guardare
  // se il bot e' avviato significava ~720 letture al giorno per una decisione gia' presa: a bot FERMO
  // il trigger non scatta comunque. I due controlli che non costano niente vanno prima.
  //
  // E da oggi c'e' un terzo cancello gratuito, il KILL: da quando il mini-ciclo puo' RICALCOLARE, un
  // giro sprecato non costa piu' una lettura ma tredici secondi e centinaia di megabyte.
  if (!TRIGGER_ATTIVO || !botAttivo()) return;
  let kill = { effectivelyKilled: false, readable: true };
  try { kill = killSwitch.killStatus(); } catch { kill = { effectivelyKilled: true, readable: false }; }
  const killAttivo = kill.effectivelyKilled === true || kill.readable === false;
  if (killAttivo) {
    if (forzatoDa) annuncia('log', `avvio forzato ignorato: kill-switch ${kill.readable === false ? 'NON LEGGIBILE' : 'ATTIVO'} — nessun piazzamento`);
    return;
  }
  let saldo = null;
  try { saldo = await leggiSaldo(); } catch (e) { saldo = { readable: false, error: e.message }; }
  const st = leggiStato();
  const d = TRIG.decidiTrigger({
    abilitato: TRIGGER_ATTIVO,
    botAttivo: botAttivo(),
    cicloInCorso: inCorso,
    killAttivo,
    saldo,
    ultimoCicloAt: fin(st.lastRunAt) ? st.lastRunAt : null,
    ultimoTriggerAt,
    now: Date.now(),
    // Un AVVIA non e' un timer che scatta: salta quiete e cooldown, e NIENTE ALTRO.
    ignoraAttese: !!forzatoDa,
    motivoForzatura: forzatoDa,
  });
  if (!d.scatta) {
    if (forzatoDa) annuncia('log', `avvio forzato: nessuna azione — ${d.motivo}`);
    return;
  }

  // Il lucchetto si prende ADESSO: fino a qui non si e' fatto niente che vada protetto, e prenderlo
  // prima avrebbe bloccato il ciclo delle sei ore per tutta la durata di una lettura di saldo.
  if (inCorso) return;
  inCorso = true;
  ultimoTriggerAt = Date.now();
  annuncia('log', `TRIGGER capitale fermo — ${d.motivo}`);
  let r;
  try { r = await miniCiclo(d); }
  catch (e) {
    r = { tipo: 'mini-ciclo', at: new Date().toISOString(), reason: 'capital-idle-trigger',
      esito: 'fermato', motivo: `eccezione non gestita: ${e.message}`, stack: e.stack };
    annuncia('error', '!!! MINI-CICLO FERMATO', { error: e.message });
  } finally { inCorso = false; }

  scrivi(r);
  if (r.esito === 'allocato') {
    annuncia('log', `mini-ciclo${r.forzato ? ' FORZATO' : ''}: $${r.allocatoUsd} rimessi al lavoro su ${(r.mercati || []).length} mercato/i`
      + ` (${r.piazzati} ordini piazzati, ${r.rifiutati} rifiutati`
      + `${r.saltati ? `, ${r.saltati} SALTATI` : ''}) · fonte: ${r.fonte}`
      + `${(r.motiviSaltati || []).length ? ` · saltati perche': ${r.motiviSaltati.map((m) => `${m.quante}x ${m.motivo}`).join(' | ')}` : ''}`
      + ` · ${UTIL.formattaUtilizzo(r.utilizzoStimatoDopo)}`);
  } else if (r.esito === 'nessuna-azione') {
    annuncia('log', `mini-ciclo: nessuna azione — ${r.motivo}`);
  }
}

// ── IL SORVEGLIANTE DELL'INTERRUTTORE — «AVVIA» DEVE PIAZZARE IN MINUTI, NON IN ORE ─────────────────
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// Premere AVVIA non anticipava niente. Il ciclo fisso conta dalle sei ore dell'ultimo `lastRunAt` su
// disco, quindi l'8 agosto 2026 un AVVIA alle 12:07 aveva il primo ciclo utile alle 16:16 — quattro ore
// dopo, con il capitale fermo nel frattempo. E il trigger a capitale fermo non poteva coprirlo, perche'
// leggeva un piano salvato che a macchina fredda non esiste ancora.
//
// ═══ LA CORREZIONE, E PERCHE' NON TOCCA IL TIMER ════════════════════════════════════════════════════
// Questo sorvegliante NON sposta `lastRunAt` e non anticipa il ciclo delle sei ore: quello ribilancia e
// cancella, e farlo partire da un bottone sarebbe un'azione molto piu' grande di quella che il bottone
// promette. Fa la cosa piccola: si accorge che l'interruttore e' passato a AVVIA e lancia UN mini-ciclo
// forzato, che adesso sa ricalcolare da solo. Il ciclo pesante resta sul suo orologio.
//
// ═══ IL CONTO DEI DUE MINUTI ════════════════════════════════════════════════════════════════════════
//   rilevazione     ≤ 15 s   (questo timer)
//   saldo           ~1 s     (cache 45 s, lettura locale)
//   ordini a riposo ~1-3 s   (una chiamata al venue)
//   ricalcolo       ~13 s    (piano leggero a 6 h — misurato, vedi FINESTRA_LEGGERA_ORE)
//   piazzamento     ~2-6 s   (una sola chiamata per tutte le gambe del giro)
//   ───────────────────────
//   totale          ~20-40 s, con il margine dei due minuti tutto ancora davanti.
//
// ═══ PERCHE' L'ISTANTE E NON UN BOOLEANO ════════════════════════════════════════════════════════════
// Si confronta `statoBot().at` — l'istante in cui l'interruttore e' stato scritto — e non «prima era
// falso, adesso e' vero». Con un booleano, un AVVIA premuto mentre questo processo era giu' sarebbe
// stato visto come «acceso da sempre» al riavvio successivo. Con l'istante si distingue, e all'avvio si
// parte dall'istante corrente PROPRIO per non far scattare un piazzamento come effetto di un riavvio:
// un pm2 restart non e' un bottone premuto da una persona.
const AVVIO_CADENZA_MS = Number(process.env.REALLOC_AVVIO_CADENZA_MS || 15_000);
let ultimoAvvioVisto = null;

async function sorvegliaAvvio() {
  let s;
  try { s = statoBot(); } catch { return; }
  if (!s || s.leggibile !== true || !Number.isFinite(s.at)) return;
  if (ultimoAvvioVisto == null) { ultimoAvvioVisto = s.at; return; }
  if (s.at <= ultimoAvvioVisto) return;
  ultimoAvvioVisto = s.at;
  if (s.enabled !== true) { annuncia('log', 'interruttore commutato su FERMA: nessun ciclo, i piazzamenti nuovi si fermano dal prossimo giro'); return; }
  annuncia('log', `AVVIA rilevato (${s.by || 'ignoto'}) — mini-ciclo forzato subito: non si aspetta ne' il cooldown ne' il ciclo delle sei ore`);
  await controlloCapitaleFermo({ forzatoDa: 'AVVIA appena premuto' });
}

// ── IL TIMER ────────────────────────────────────────────────────────────────────────────────────────
function prossimoRitardo() {
  const st = leggiStato();
  const last = fin(st.lastRunAt) ? st.lastRunAt : null;
  if (last == null) return STARTUP_DELAY_MS;
  const trascorso = Date.now() - last;
  if (trascorso >= INTERVAL_MS) return STARTUP_DELAY_MS;      // il turno era già scaduto: si parte (dopo il minuto di grazia)
  return Math.max(STARTUP_DELAY_MS, INTERVAL_MS - trascorso); // il turno non è ancora arrivato: si aspetta il resto
}

function pianificaProssimo(motivo) {
  const ms = prossimoRitardo();
  annuncia('log', `prossimo ciclo fra ${(ms / 60_000).toFixed(1)} minuti (${motivo})`);
  setTimeout(async () => { await giro('timer'); pianificaProssimo('dopo un ciclo'); }, ms);
}

// `--once` esegue UN ciclo subito e esce: serve a guardarlo lavorare senza aspettare sei ore. Rispetta
// esattamente gli stessi due cancelli del processo lungo — REALLOC_SCHEDULER_ENABLED per esistere,
// `bot-enabled` per poter piazzare — e non è una scorciatoia per scavalcare né l'uno né l'altro.
async function unaVolta() {
  if (!ENABLED) {
    annuncia('error', '--once rifiutato: REALLOC_SCHEDULER_ENABLED non vale 1');
    process.exit(2);
  }
  annuncia('log', `esecuzione singola forzata — bot ${botAttivo() ? 'AVVIATO' : 'FERMO'}`);
  const r = await giro('forzato --once');
  console.log('\n' + JSON.stringify(r, null, 2));
  process.exit(r && r.azione === 'fermato' ? 1 : 0);
}

function main() {
  if (process.argv.includes('--once')) return void unaVolta();
  if (!ENABLED) {
    annuncia('log', 'SPENTO: REALLOC_SCHEDULER_ENABLED non vale 1 — nessuna verifica, nessun piano, nessun ordine.');
    scrivi({ at: new Date().toISOString(), tipo: 'avvio', stato: 'spento', motivo: 'REALLOC_SCHEDULER_ENABLED != 1' });
    // Vivo e inerte, non uscito: un processo che esce fa ripartire pm2 in ciclo e riempie i log di rumore.
    setInterval(() => {}, 1 << 30);
    return;
  }
  const bot0 = statoBot();
  // LO STATO DEL FRENO, PRIMA DI TUTTO IL RESTO: e' la domanda «sto piazzando davvero?», e finora la
  // risposta era deducibile solo leggendo il codice. Va scritta anche su disco, perche' il pannello
  // non puo' leggere l'ambiente di un altro processo.
  {
    const f = FRENO.statoFreno();
    annuncia('log', FRENO.rigaLog(f));
    try {
      const fs_ = require('fs');
      const p_ = require('path').join(require('../lib/safety/store').DATA_DIR, 'freno-prova.json');
      const tmp_ = `${p_}.tmp`;
      fs_.writeFileSync(tmp_, JSON.stringify({ ...f, agente: 'agent41-realloc-scheduler', pid: process.pid, atIso: new Date().toISOString() }, null, 1));
      fs_.renameSync(tmp_, p_);
    } catch { /* il pannello lo mostrera' come sconosciuto: non e' un motivo per non partire */ }
  }
  annuncia('log', `ACCESO — intervallo ${INTERVAL_MS / 3_600_000}h`
    + (() => {
      // IL TETTO IN VIGORE E DA QUALE CAPITALE NASCE. Dal 12 agosto 2026 non e' piu' una costante:
      // e' derivato da `f_min`, e il numero di mercati e' la conseguenza. Chi legge il log deve
      // vedere il numero VERO di adesso, non quello di riferimento.
      try {
        const CO = require('../lib/rewards/concentration');
        const cap = (() => { try { const a = readAllocatedCapitalAll(); return Number(a && a.capital); } catch { return null; } })();
        const t = CO.capPerMarketUsd(cap);
        const f = CO.finestraMid(cap);
        return `, tetto per mercato $${t} DERIVATO da capitale $${Number.isFinite(cap) ? cap.toFixed(2) : 'non letto'}`
          + ` (f_min obiettivo ${(CO.F_MIN_OBIETTIVO * 100).toFixed(0)}%) · $${(t / 2).toFixed(2)} per lato`
          + ` · ${CO.mercatiSostenibili(cap)} mercati sostenibili (tetto di carico ${CO.MAX_MERCATI})`
          + ` · tetto per ordine $${CO.liveMinOrderCapUsd(cap)} · finestra mid [${f.lo} · ${f.hi}]`;
      } catch { return ', tetto per mercato non calcolabile'; }
    })()
    + ` · il bot e' ${bot0.enabled ? 'AVVIATO (ordini veri quando le regole lo consentono)' : 'FERMO (solo piano, nessun ordine)'}`
    + ` · l'interruttore e' ${FILE_INTERRUTTORE}, si commuta dalla tab «Mercati ottimizzati»`);
  scrivi({ at: new Date().toISOString(), tipo: 'avvio', stato: 'acceso', botEnabled: bot0.enabled,
    botMotivo: bot0.motivo, intervalloOre: INTERVAL_MS / 3_600_000 });
  pianificaProssimo('avvio');

  // ── IL POLLER DEL CAPITALE FERMO ────────────────────────────────────────────────────────────────
  // Parte DOPO il minuto di grazia dell'avvio, per la stessa ragione del ciclo fisso: appena riavviato
  // il processo non sa ancora niente, e un mini-ciclo su un saldo letto un secondo dopo l'avvio
  // sarebbe una decisione presa senza contesto. `unref()` non serve — questo processo vive comunque.
  if (TRIGGER_ATTIVO) {
    annuncia('log', `trigger capitale fermo ACCESO — cadenza operativa ${TRIG.CADENZA_OPERATIVA_MS / 60000} min`
      + ` (rilevazione del saldo ogni ${TRIG.CADENZA_MS / 1000}s), soglia $${TRIG.SOGLIA_USD}`
      + ` · non cancella niente, rilegge AVVIA/FERMA e il kill a ogni controllo`
      + ` · obiettivo di utilizzo ${Math.round(UTIL.TARGET_UTILIZZO * 100)}%, fino a ${TRIG.MAX_MERCATI_PER_GIRO} mercati per giro`
      + ` · se il piano salvato manca, e' vecchio (> ${PIANO_FRESCO_MAX_MS / 60000} min) o non ha spazio, RICALCOLA (piano leggero a ${FINESTRA_LEGGERA_ORE}h)`);
    setTimeout(() => {
      setInterval(() => { controlloCapitaleFermo().catch((e) => annuncia('error', 'controllo capitale fermo fallito', { error: e.message })); }, TRIG.CADENZA_MS);
    }, STARTUP_DELAY_MS);
    // Il sorvegliante dell'interruttore parte SUBITO e non dopo il minuto di grazia: la sua prima
    // esecuzione non piazza niente per costruzione (inizializza l'istante), e serve proprio a essere
    // gia' in ascolto se qualcuno preme AVVIA nel primo minuto di vita del processo.
    annuncia('log', `sorveglianza dell'interruttore ACCESA — controllo ogni ${AVVIO_CADENZA_MS / 1000}s: un AVVIA fa partire un mini-ciclo forzato entro ~2 minuti`);
    sorvegliaAvvio().catch(() => {});
    setInterval(() => { sorvegliaAvvio().catch((e) => annuncia('error', 'sorveglianza avvio fallita', { error: e.message })); }, AVVIO_CADENZA_MS);
  } else {
    annuncia('log', 'trigger capitale fermo SPENTO (TRIGGER_CAPITALE_FERMO=0) — resta solo il ciclo fisso');
  }
}

if (require.main === module) main();

module.exports = { leggiVenue, leggiSaldo, prossimoRitardo, scriviUltimoPiano, leggiUltimoPiano,
  miniCiclo, preparaMercatoNuovo, pianoLeggero, sorvegliaAvvio, LOG_FILE, STATE_FILE, POOLS_FILE, ULTIMO_PIANO_FILE,
  FINESTRA_LEGGERA_ORE, PIANO_FRESCO_MAX_MS, AVVIO_CADENZA_MS,
  rigaBoardNormalizzata, copiaRegoleNelRipiego, BOARD_NORMALIZZATO };
