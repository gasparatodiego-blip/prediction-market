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

const { runReallocCycle, CONCENTRATION_CAP_FRAC, INTERVAL_MS } = require('../lib/maker/realloc-cycle');
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
const { writeAllocatedCapital } = require('../lib/maker/allocated-capital');
const { writeCollectorPriority } = require('../lib/rewards/collector-priority');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'realloc-scheduler.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'realloc-scheduler-state.json');
const POOLS_FILE = path.join(DATA_DIR, 'realloc-plan-pools.json');

const ENABLED = process.env.REALLOC_SCHEDULER_ENABLED === '1';
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
const { statoBot, botAttivo, rampa, FILE: FILE_INTERRUTTORE } = require('../lib/maker/bot-enabled');
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
async function calcolaPiano({ capital, maxPerMarketUsd, onlyMarketIds = null, excludeMarketIds = null }) {
  const piano = await calcolaPianoFuoriProcesso({ capital, maxPerMarketUsd, onlyMarketIds, excludeMarketIds, horizonFilter: true });

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
  }
  return piano;
}

// ── IL RESET ────────────────────────────────────────────────────────────────────────────────────────
// Cablaggio identico a quello di /api/maker/manual/bulk-allocate: stesse funzioni, stessa corsia
// cancel-only, stesso runBulkAllocation. Non esiste una seconda strada verso il venue, e questo processo
// non ne apre una: passa dalla stessa porta del bottone.
// ── QUANTE POSIZIONI, E QUANTE NUOVE AL PRIMO GIORNO ───────────────────────────────────────────────
// Il tetto vive QUI e non nell'allocatore: `maxCount` di planAllocation governa solo la curva
// `frontier` che il pannello disegna, non le righe del piano (verificato il 7 agosto 2026 —
// data/indagine-offset.md §3). Il numero di posizioni che teniamo davvero e' una politica operativa
// dello scheduler, e questo e' lo scheduler.
//
// 10 e' la mediana dei 21 maker misurati (data/manuale-operativo-maker-v2.md, Q1 6 · Q3 22). Con $620
// sono ~$62 a mercato, cioe' ~$31 per lato: dentro la forchetta del nozionale osservato ($16-74).
const MAX_POSIZIONI = 10;

/**
 * Applica le due politiche di apertura alle righe del piano, PRIMA che diventino ordini.
 *
 * Ordine deliberato: prima la rampa (che limita solo i mercati NUOVI), poi il tetto complessivo. Al
 * contrario un mercato gia' in gestione potrebbe essere tagliato dal tetto per far posto a uno nuovo
 * che la rampa avrebbe comunque fermato.
 */
function applicaPolitiche(rows, gestiti, now) {
  const inGestione = new Set((gestiti || []).map((x) => String(x).trim().toLowerCase()));
  const r = rampa({ now });
  const tenute = [];
  const scartate = [];
  let nuoviAmmessi = r.attiva ? r.residuo : Infinity;
  for (const riga of rows || []) {
    const id = String(riga.marketId || '').toLowerCase();
    const nuovo = !inGestione.has(id);
    if (nuovo && nuoviAmmessi <= 0) {
      scartate.push({ marketId: riga.marketId, motivo: 'rampa', dettaglio: r.motivo });
      continue;
    }
    if (tenute.length >= MAX_POSIZIONI) {
      scartate.push({ marketId: riga.marketId, motivo: 'tetto-posizioni', dettaglio: `gia' ${MAX_POSIZIONI} posizioni nel piano` });
      continue;
    }
    if (nuovo) nuoviAmmessi -= 1;
    tenute.push(riga);
  }
  return { tenute, scartate, rampa: r, tetto: MAX_POSIZIONI };
}

async function eseguiReset({ rows, dryRunOnly }) {
  const diag = diagnoseExposure({});
  // LE POLITICHE DI APERTURA SI APPLICANO QUI, sulle righe che stanno per diventare ordini — non nel
  // piano. Il piano deve continuare a dire cosa sarebbe meglio fare; il tetto e la rampa dicono quanto
  // di quel meglio ci concediamo oggi, e la differenza fra i due va registrata invece che appianata.
  const gestiti = (() => { try { return readAutoRepriceConfig({}).enabledMarketIds || []; } catch { return []; } })();
  const pol = applicaPolitiche(rows, gestiti, Date.now());
  if (pol.scartate.length) {
    scrivi({ tipo: 'politiche-apertura', tetto: pol.tetto, rampa: pol.rampa,
      tenute: pol.tenute.length, scartate: pol.scartate });
    annuncia('log', `politiche di apertura: ${pol.tenute.length} righe tenute, ${pol.scartate.length} scartate`
      + ` (${pol.scartate.filter((x) => x.motivo === 'rampa').length} dalla rampa, `
      + `${pol.scartate.filter((x) => x.motivo === 'tetto-posizioni').length} dal tetto di ${pol.tetto})`);
  }
  return runAllocationReset(
    { rows: pol.tenute, dryRunOnly },
    {
      readEnabled: () => readAutoRepriceConfig({}).enabledMarketIds || [],
      readTracking: () => readTrackingConfig().marketIds || [],
      listOrders: ({ marketId }) => listManualOrders({ marketId }),
      cancelOrder: ({ orderId, marketId }) => cancelManualOrder({ orderId, marketId }, 'manual-ui'),
      setTrackingOff: ({ marketId, reason }) => setTracking({ marketId, enabled: false, by: 'riallocatore periodico', reason }),
      setEnabled: ({ marketId, enabled, reason }) => setAutoReprice({ scope: 'market', marketId, enabled, by: 'riallocatore periodico', reason }),
      setManual: ({ marketId, manual, reason }) => setManualMode({ marketId, manual, by: 'riallocatore periodico', reason }),
      // OGNI mercato del piano ha l'uscita automatica accesa PRIMA di avere ordini (fase 3 del reset).
      setAutoClose: ({ marketId, enabled, reason }) => setAutoClose({ scope: 'market', marketId, enabled, by: 'riallocatore periodico', reason }),
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
        { rows: r, dryRunOnly: d },
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
  const r = rampa({ now: avvio });
  // `dryRunOnly` resta il nome del parametro a valle (runReallocCycle non cambia): qui significa
  // «calcola tutto ma non toccare il venue». Con il bot fermo è esattamente quello che vogliamo, e il
  // ciclo continua a girare per intero — verifica, saldo, piano — così il pannello ha sempre da mostrare.
  const soloRacconto = !bot.enabled;
  scrivi({ at: new Date(avvio).toISOString(), tipo: 'ciclo-avvio', motivoAvvio, dryRun: soloRacconto,
    botEnabled: bot.enabled, botBy: bot.by, botAt: bot.atIso, rampa: r,
    intervalloOre: INTERVAL_MS / 3_600_000, tettoFrazione: CONCENTRATION_CAP_FRAC });
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
  annuncia('log', `ACCESO — intervallo ${INTERVAL_MS / 3_600_000}h, tetto per mercato ${Math.round(CONCENTRATION_CAP_FRAC * 100)}% del capitale`
    + ` · il bot e' ${bot0.enabled ? 'AVVIATO (ordini veri quando le regole lo consentono)' : 'FERMO (solo piano, nessun ordine)'}`
    + ` · l'interruttore e' ${FILE_INTERRUTTORE}, si commuta dalla tab Mercati`);
  scrivi({ at: new Date().toISOString(), tipo: 'avvio', stato: 'acceso', botEnabled: bot0.enabled,
    botMotivo: bot0.motivo, intervalloOre: INTERVAL_MS / 3_600_000 });
  pianificaProssimo('avvio');
}

if (require.main === module) main();

module.exports = { leggiVenue, leggiSaldo, prossimoRitardo, LOG_FILE, STATE_FILE, POOLS_FILE };
