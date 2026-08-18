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
const { listManualOrders, cancelManualOrder, placeManualOrder, replaceManualOrder, resolveCaps, OPERATOR_USER } = require('../lib/maker/manual-order');
const { readUsage } = require('../lib/safety/usage');
const { readAutoRepriceConfig, setAutoReprice } = require('../lib/maker/auto-reprice-config');
const { readTrackingConfig, setTracking } = require('../lib/maker/mm-tracking-config');
const { setManualMode } = require('../lib/maker/manual-mode');
const { setAutoClose } = require('../lib/maker/auto-close-config');
const { fetchVenuePositions } = require('../lib/maker/manual-reset');
const { resolveMarketRules } = require('../lib/maker/manual-order');
const { writeAllocatedCapital, readAllocatedCapitalAll } = require('../lib/maker/allocated-capital');
const { writeCollectorPriority } = require('../lib/rewards/collector-priority');

// ── I CANDIDATI DA SEMINARE NEL FEED (13 agosto 2026) ─────────────────────────────────────────────
// L'allocatore SCARTA un mercato la cui profondità non è VERIFICATA (`allocator.js:1068`,
// `status:'scartato', capital:0`), e la verifica accetta solo campioni **websocket**
// (`allocator.js:109`, `r.src === 'ws'`). Il websocket è agent34, che sottoscrive `collector-priority`,
// che agent41 scriveva **dal proprio piano**: un anello chiuso, misurato il 13 agosto alle 00:20 —
// dei 17 mercati che superavano ogni filtro d'ingresso, solo **3** erano nel feed.
//
// Un candidato è un mercato che il piano POTREBBE scegliere se lo vedesse: `minSize` compatibile con il
// tetto per mercato di ADESSO e orizzonte ancora valido. Non è una promessa di allocarci capitale — è
// solo il permesso di guardarlo, che oggi non ha.
//
// ⚠ SI LEGGE IL BOARD, NON SI INVENTA NIENTE: stessa fonte del pianificatore
// (`/tmp/liquidity-rewards.json`), così un candidato non può essere un mercato che il piano non
// potrebbe comunque valutare. Ordinati per montepremi decrescente perché, se eccedono il tetto della
// corsia, a cedere il posto siano i più poveri.
function candidatiPerIlFeed() {
  try {
    const CONC = require('../lib/rewards/concentration');
    const board = JSON.parse(require('fs').readFileSync(BOARD_NORMALIZZATO, 'utf8'));
    const righe = Array.isArray(board && board.markets) ? board.markets : [];
    if (!righe.length) return [];
    // Il tetto si deriva dal capitale VERO, non da una costante: è lui a decidere quale `minSize` è
    // alla portata, e cambia col saldo.
    // Il capitale si legge dalla mappa dei tetti, che il mini-ciclo aggiorna col saldo vero: è la
    // stessa fonte su cui il tetto per mercato viene deciso a valle. Illeggibile ⇒ il capitale di
    // riferimento, che è conservativo (tetto più basso ⇒ meno candidati, mai di più).
    let capitale = CONC.CAPITALE_RIFERIMENTO_USD;
    try {
      const t = JSON.parse(require('fs').readFileSync('data/maker-allocated-capital.json', 'utf8'));
      if (Number(t && t.capital) > 0) capitale = Number(t.capital);
    } catch { /* si tiene il riferimento */ }
    const tetto = CONC.capPerMarketUsd(capitale);
    const ORA = Date.now();
    const MIN_ORE = 18;
    return righe
      .filter((r) => {
        const pav = CONC.pavimentoPremiante(r && r.minSize);
        if (pav == null || pav > tetto) return false;              // fuori portata del tetto
        if (!r.endDate) return false;                              // scadenza non determinabile ⇒ esclude
        const ore = (Date.parse(r.endDate) - ORA) / 3_600_000;
        return Number.isFinite(ore) && ore >= MIN_ORE;
      })
      .sort((a, b) => (Number(b.dailyPool) || 0) - (Number(a.dailyPool) || 0))
      .map((r) => String(r.marketId));
  } catch { return []; }   // board illeggibile ⇒ nessun candidato: si torna al comportamento di prima
}

/** I mercati dove il capitale è GIÀ esposto. Fail-closed: snapshot illeggibile ⇒ lista vuota. */
function mercatiConPosizione() {
  try {
    const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
    const snap = readVenuePositions();
    if (!snap || snap.readable !== true) return [];
    return (snap.positions || [])
      .filter((p) => Number(p && p.size) > 0)
      .map((p) => String((p.conditionId || p.marketId) || '').trim().toLowerCase())
      .filter(Boolean);
  } catch { return []; }
}
const { gambeDiUnaRiga } = require('../lib/rewards/plan-to-orders');
// Il ripristino della gamba mancante (17 agosto 2026): decisione PURA nel modulo, esecuzione qui
// attraverso `piazzaCoppia`. Il lucchetto e' lo STESSO di `auto-reprice`, non una seconda serratura.
const RIP = require('../lib/maker/ripristino-gambe');
// ⚠ E DAL 17 AGOSTO SERA IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA: una sola funzione decide la
// size di ENTRAMBE nello stesso istante (§4.13, `coppia-simmetrica`). Decisione dell'operatore.
const COPS = require('../lib/maker/coppia-simmetrica');
const LOCK = require('../lib/maker/lock-mercato');
const { capPerMarketUsd, mercatiNecessari, MARKET_CAP_FIXED_USD } = require('../lib/rewards/concentration');
const TRIG = require('../lib/maker/trigger-capitale-fermo');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const killSwitch = require('../lib/safety/kill-switch');
// R10 · per marcare eseguita la richiesta di chiusura: scrittura atomica, o agent43 potrebbe leggere
// mezzo file e riscrivere una richiesta che qualcuno sta gia' eseguendo.
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
// R4 · le sospensioni per erosione: agent40 le scrive quando toglie una gamba dal libro, questo
// processo le legge per NON rimetterla prima del tempo. Senza, l'uscita da 5 minuti durerebbe due.
const SOSPE = require('../lib/maker/sospensione-erosione');
const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
const UTIL = require('../lib/maker/utilizzo-capitale');
const CAPLAV = require('../lib/maker/capitale-al-lavoro');
const SENT = require('../lib/maker/sentinella-vuoto');
// ── LA SENTINELLA SUL COLLASSO DELLA COPERTURA (CLAUDE.md §5.2 p.9) ─────────────────────────────
// Accanto a quella sul vuoto, non al suo posto: la prima guarda il LIVELLO (zero ordini), questa la
// DERIVATA (un calo dell'85% dal massimo mobile a 10 minuti). Sono due guasti diversi — «non parte
// piu' niente» e «e' crollato quello che c'era» — e la prima non puo' vedere il secondo, perche' il
// suo ramo `ordiniARiposo > 0` azzera l'orologio anche a 2 ordini su 23.
const COLL = require('../lib/maker/sentinella-collasso');
const QUAR = require('../lib/maker/quarantena-venue');
const DATA_DIR_A41 = path.join(__dirname, '..', 'data');
const COER = require('../lib/maker/coerenza-soglie');
const SBLOCCO = require('../lib/maker/sblocco-progressivo');
// Il tetto per ORDINE arriva da dove è già dichiarato una volta sola: non nasce una settima copia qui.
const { liveMinOrderCapUsd } = require('../lib/rewards/concentration');

// ── I PERCORSI PRIMA DI TUTTO — 17 agosto 2026 ─────────────────────────────────────────────────────
// Se `data/`, la directory di servizio o un file di servizio gia' esistente non sono utilizzabili da
// QUESTO processo, ci si ferma qui e lo si dice. Non e' prudenza generica: il 17 agosto nove file di
// `/tmp` erano di un altro utente, gli scrittori prendevano EACCES e **i lettori continuavano a leggere
// la copia vecchia, che da quel momento non invecchiava piu'**. Un processo «online» che decide su una
// fotografia ferma e' peggio di un processo caduto. Dettagli in `lib/safety/percorsi-critici.js`.
require('../lib/safety/percorsi-critici').verificaOMuori('agent41-realloc-scheduler');
const CO = { liveMinOrderCapUsd };

// ── LO STATO DELLA DIAGNOSI DEL CAPITALE FERMO ────────────────────────────────────────────────────
// Vive in memoria e non su disco di proposito: descrive un EPISODIO in corso, e dopo un riavvio la
// risposta onesta è «riparto a contare» — scrivere la diagnosi subito dopo un riavvio direbbe «sotto
// soglia da 30 minuti» su un processo che è vivo da dieci secondi.
let statoDiagnosiFermo = { sottoDa: null, giaScritta: false };

/**
 * IL CAPITALE AL LAVORO, DETTO A OGNI GIRO. Una riga di log e una voce di audit, dalla stessa misura
 * che il ciclo ha già fatto — non una seconda lettura, che potrebbe divergere.
 * Quando resta sotto la soglia di diagnosi abbastanza a lungo, aggiunge la RIPARTIZIONE in dollari.
 */
function raccontaCapitaleAlLavoro(utilizzo, referto, quale) {
  let c;
  try { c = CAPLAV.capitaleAlLavoro({ utilizzo }); } catch { return; }
  try {
    annuncia('log', `CAPITALE AL LAVORO · ${c.leggibile
      ? `$${c.alLavoroUsd.toFixed(2)} su $${c.totaleUsd.toFixed(2)} = ${c.pct}% · obiettivo ${c.obiettivoPct}%`
        + `${c.raggiunto ? ' ✓ RAGGIUNTO' : ` · mancano $${c.mancanoUsd.toFixed(2)}`}`
      : c.motivo}`);
  } catch { /* il log non deve poter fermare il ciclo */ }

  const d = CAPLAV.valutaDiagnosi({ frazione: c.leggibile ? c.frazione : null, ora: Date.now(), stato: statoDiagnosiFermo });
  statoDiagnosiFermo = { sottoDa: d.sottoDa, giaScritta: d.giaScritta };

  let rip = null;
  if (d.scrivi && c.leggibile) {
    // Le cause arrivano da chi le conosce — il referto del giro — e NON si indovinano qui: quello che
    // nessuno ha misurato resta `non attribuito`, che è il segnale che manca un osservatore.
    const senzaRighe = /nessun mercato del piano ha spazio sufficiente|non ha righe utilizzabili/.test(String(referto && referto.motivo || ''))
      || /spazio sufficiente/.test(String(referto && referto.motivoStop || ''));
    rip = CAPLAV.ripartizioneFermo({
      fermoUsd: c.fermoUsd,
      // Il residuo che il giro ha dichiarato di non aver saputo allocare è la stima migliore che
      // abbiamo di «fermo perché il piano non offre righe»: viene dal referto, non da un'ipotesi.
      pianoSenzaRigheUsd: senzaRighe && Number.isFinite(referto && referto.residuoUsd) ? referto.residuoUsd : 0,
      tettoMercatoPienoUsd: 0,
      rifiutatiDalVenueUsd: 0,
      nonQuotabiliUsd: 0,
      rateLimitUsd: 0,
    });
    annuncia('log', `⚠ CAPITALE FERMO DA ${Math.round((Date.now() - d.sottoDa) / 60000)} MINUTI — ${rip.riga}`);
  }

  try {
    appendMakerAudit({
      ts: Date.now(), venue: 'polymarket', source: 'realloc-scheduler', op: 'capitale-al-lavoro',
      outcome: c.leggibile ? (c.raggiunto ? 'obiettivo-raggiunto' : 'sotto-obiettivo') : 'non-misurabile',
      reason: c.motivo,
      observed: {
        quale,
        alLavoroUsd: c.alLavoroUsd, totaleUsd: c.totaleUsd, fermoUsd: c.fermoUsd,
        pct: c.pct, obiettivoPct: c.obiettivoPct, mancanoUsd: c.mancanoUsd,
        ripartizione: rip ? rip.voci : null, ripartizioneChiude: rip ? rip.chiude : null,
      },
    });
  } catch { /* l'audit non deve poter fermare il ciclo */ }
}
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
// ⚠ `impostaBot` È PARTE DI QUESTO IMPORT, E LA SUA ASSENZA È COSTATA IL GRADINO 6. Fino al 13 agosto
// 2026 la destrutturazione si fermava a `registraMercatoAperto`: il gradino «fermati-in-sicurezza»
// chiamava `impostaBot` da uno scope che non lo conteneva, quindi ogni volta che la scala arrivava in
// fondo l'ultima difesa moriva con un ReferenceError catturato dal `try` che la avvolge — e il bot
// restava su AVVIA credendo di essersi fermato. Misurato: raggiunto 2 volte in 11h20m, sempre fallito.
// Falliva CHIUSO (nessun rischio di capitale), ma il gradino non esisteva. `bot-enabled.test.js` non
// poteva vederlo: la funzione c'era, mancava il filo. Vedi §5-bis p.153.
const { statoBot, botAttivo, impostaBot, apertureDallAvvio, registraMercatoAperto, FILE: FILE_INTERRUTTORE } = require('../lib/maker/bot-enabled');
// Il saldo pUSD del funder, dalla cache condivisa IN PROCESSO — la stessa che usano agent40, il trigger
// a capitale fermo e agent45. Ha sostituito la fetch al dashboard su 127.0.0.1:3000 il 16 agosto 2026:
// vedi `leggiSaldo` piu' sotto. `saldo-cache` fa un eth_call in sola lettura e non sa piazzare niente.
// ⚠ SE QUESTA RIGA SPARISCE, `leggiSaldo` NON esplode in modo visibile: il suo `try` restituirebbe
// `readable:false` e il bot pianificherebbe su capitale zero, in silenzio. E' la forma di §5-bis p.153,
// ed e' il motivo per cui `saldo-da-cache-non-da-dashboard.test.js` asserisce l'import PER NOME.
const { leggiSaldoUsd } = require('../lib/maker/saldo-cache');
// Il riconciliatore della copertura: niente doppioni, nessuno slot vuoto. Vedi `riconciliaCopertura`.
const DOPP = require('../lib/maker/doppioni');
const COP = require('../lib/maker/copertura-gambe');
// Il presidio che impedisce un'altra FL-27 da cinque ore. Indipendente dalla scala d'uscita: vedi
// `presidio-posizioni-vecchie` per perche' e' deliberatamente stupido e quando andra' tolto.
const PRESIDIO = require('../lib/maker/presidio-posizioni-vecchie');
const PRESIDIO_FILE = require('path').join(require('../lib/safety/store').DATA_DIR, 'presidio-posizioni.json');
// R10 · la richiesta depositata da agent43. Chi la scrive non puo' eseguirla, chi la esegue non puo'
// deciderla: e' la stessa separazione del referto di cancellazione.
const CHIUSURA_EMERGENZA_FILE = require('path').join(require('../lib/safety/store').DATA_DIR, 'chiusura-emergenza-richiesta.json');
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
    // LA SCADENZA NON SI LEGGE PIÙ QUI (12 agosto 2026). Fino a oggi questa riga restituiva
    // `end_date_iso` grezzo, e il pianificatore leggeva invece il board: due letture della stessa cosa,
    // e sul ciclo delle 15:41:31Z due mercati sono stati scelti con 32,3 h e 20,3 h di vita e poi
    // rifiutati con «mancano 8,3 h» — tre ricalcoli e il ciclo fermato, senza che nessuna delle due
    // fosse sbagliata: il CLOB tronca a mezzanotte, Gamma pubblica l'ora vera.
    //
    // Adesso la riconciliazione avviene UNA VOLTA in agent24 (lib/rewards/scadenza-mercato) e il board
    // porta il verdetto. Qui si legge da lì, così pianificatore e verifica usano lo stesso numero PER
    // COSTRUZIONE e non per coincidenza. La lettura grezza del venue resta accanto, dichiarata, perché
    // «le due fonti concordano» resti verificabile dall'esterno.
    endDate: scadenzaDalBoard(marketId, typeof j.end_date_iso === 'string' ? j.end_date_iso : null),
    endDateVenueGrezza: typeof j.end_date_iso === 'string' ? j.end_date_iso : null,
  };
}

/**
 * La scadenza riconciliata del board — l'UNICO punto da cui la verifica la legge.
 *
 * Ripiego dichiarato: se il board non porta la riga (mercato uscito dal tabellone) si usa la lettura
 * grezza del venue, che è la più prudente delle due e quindi il ripiego sicuro. Mai il contrario.
 */
function scadenzaDalBoard(marketId, grezzaVenue) {
  try {
    const r = rigaBoardNormalizzata(marketId);
    if (r && typeof r.endDate === 'string' && r.endDate.trim()) return r.endDate;
  } catch { /* board illeggibile: si ripiega sulla lettura del venue, che è la più prudente */ }
  return grezzaVenue;
}

// ── IL SALDO ────────────────────────────────────────────────────────────────────────────────────────
// ═══ ERA UNA CHIAMATA HTTP AL DASHBOARD, E IL DASHBOARD NON ESISTE PIÙ (16 agosto 2026) ═════════════
// Qui c'era `GET ${DASHBOARD}/api/rewards/balance` su 127.0.0.1:3000, e la ragione di allora era buona:
// il lettore on-chain era `lib/poly-chain-read.ts`, TypeScript, che da un processo node semplice non si
// può richiedere — quindi si riusava la strada che c'era invece di scrivere un SECONDO lettore capace di
// dire un numero diverso dal primo.
//
// Quella premessa è caduta due volte. Il `dashboard` è uscito dalla flotta il 15 agosto (le decisioni si
// prendono da `scripts/cli/`), quindi la fetch dava `ECONNREFUSED` a ogni giro; e `lib/maker/saldo-cache`
// esiste ed è il lettore condiviso che agent40, il trigger e agent45 usano già — misurato nello stesso
// istante in cui questa riga leggeva $0,00: agent40 leggeva **$1.499,64**.
//
// ⚠ NON È UN SECONDO LETTORE: è ESATTAMENTE il primo. `saldo-cache` è la fonte unica in processo
// (eth_call su `balanceOf` del funder, nessuna credenziale, nessuna firma, nessuna superficie che sappia
// piazzare), e passare di lì RIMUOVE una divergenza invece di aggiungerne una — il dashboard leggeva a
// sua volta la stessa catena, con un salto HTTP in mezzo.
//
// ⚠ IL FALLIMENTO RESTA CHIUSO, E NELLA STESSA FORMA DI PRIMA. `affidabile:false` significa «la lettura
// non autorizza esposizione nuova» ed è il gemello esatto del vecchio `stale:true`: la cache può avere
// un `usd` in mano e dichiararlo comunque inaffidabile (lettura fallita, valore oltre il limite d'età).
// In quel caso si restituisce `readable:false` e NON si passa il numero — un saldo di minuti fa farebbe
// calcolare un piano su capitale che potrebbe non esserci, e il ciclo si ripresenta comunque.
// `usd` non finito ⇒ non leggibile: «mai letto» è sconosciuto, non zero (§5.3, `Number(null) === 0`).
async function leggiSaldo() {
  let s;
  try { s = await leggiSaldoUsd(); }
  catch (e) { return { readable: false, error: `lettura del saldo fallita: ${e && e.message ? e.message : String(e)}` }; }
  if (!s) return { readable: false, error: 'lettore del saldo senza risposta' };
  if (s.affidabile !== true) return { readable: false, error: s.motivo || 'saldo non affidabile', payload: { fonte: s.fonte || null, etaMs: s.etaMs ?? null } };
  if (!fin(s.usd)) return { readable: false, error: 'saldo mai letto (usd null): sconosciuto, non zero', payload: { fonte: s.fonte || null } };
  return { readable: true, usd: s.usd, readAt: fin(s.etaMs) ? Date.now() - s.etaMs : null,
    ageSeconds: fin(s.etaMs) ? Math.round(s.etaMs / 1000) : null, fonte: s.fonte || null };
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
// ⚠ IL PERCORSO DELL'ALLOCATORE E' RELATIVO A QUESTO FILE, NON PIU' ASSOLUTO (17 agosto 2026).
// Era `require("/root/prediction-market/lib/rewards/allocator")`, e in produzione e' lo stesso file (il
// symlink porta qui) — ma un percorso assoluto significa che il processo figlio del piano carica SEMPRE
// il codice e i dati di quel repo, qualunque repo stia eseguendo il padre. Misurato: un banco che gira
// in un worktree con un board simulato riceveva un piano calcolato sul board REALE — «l'allocatore ha
// valutato 0 candidati su 483 mercati con storico», cioe' zero righe per il mercato del banco, che nel
// board vero non esiste. Il ciclo da 6 ore non era esercitabile, e la causa era una stringa.
// Si risolve da `__dirname`, che per un agent e' sempre quello vero (nessuna rotta importa un agent —
// vedi `scripts/percorsi-dati.js`), quindi in produzione il file caricato e' identico a prima.
const PERCORSO_ALLOCATOR = path.join(__dirname, '..', 'lib', 'rewards', 'allocator');
const RUNNER_PIANO = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require('
  + JSON.stringify(PERCORSO_ALLOCATOR)
  + ').planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';
// Il piano misurato costa ~22s. 120s lascia margine per una macchina carica senza che un blocco vero
// resti appeso: se scade, il ciclo tratta il piano come fallito, che è già un esito previsto.
const PLAN_TIMEOUT_MS = 120_000;
// Il corpo del piano porta per ogni riga la curva dei fill tick per tick e il registro dei candidati:
// su un universo da ~110 valutati sono megabyte, non kilobyte.
const PLAN_MAX_BUFFER = 48 * 1024 * 1024;

/**
 * IL PIANO SI CALCOLA SOLO SUI MERCATI CHE LA SELEZIONE HA SCELTO — quando la selezione e' accesa.
 *
 * Questo e' il punto in cui la scelta dei mercati e la scelta delle SIZE si incontrano, e sta qui e non
 * nei due chiamanti perche' i chiamanti sono due (`calcolaPiano` per il ciclo da 6 h, `pianoLeggero`
 * per il mini-ciclo) e una regola scritta due volte e' una regola che un giorno vale una volta sola.
 *
 * ⚠ SI INTERSECA, NON SI SOSTITUISCE. `onlyMarketIds` ha gia' un significato — «il piano ristretto ai
 * mercati in gestione», il piano di paragone del trigger di valore — e sovrascriverlo lo cancellerebbe.
 * L'intersezione puo' solo STRINGERE l'universo, quindi non puo' introdurre un mercato che uno dei due
 * criteri escludeva.
 *
 * ⚠ E SE L'INTERSEZIONE E' VUOTA NON SI TOGLIE IL VINCOLO. Un elenco vuoto significa «nessun mercato
 * comune», e la risposta giusta e' un piano vuoto — non un piano su tutto il board, che e' esattamente
 * il modo in cui un filtro di sicurezza si trasforma nel suo contrario. Si passa un elenco impossibile
 * invece di `null`, cosi' l'allocatore risponde «nessuna riga» invece di «nessun vincolo».
 */
function restringiAllaSelezione(opzioni) {
  const sel = selezioneAttiva();
  if (!sel.attiva) return opzioni;
  // ⚠ `idsAttivi`, NON `ids`: il piano apre posizioni, e un mercato in gestione sta chiudendo la sua.
  // Aprirci sopra rifarebbe l'esposizione che la scala d'uscita sta smontando. La GESTIONE di quel
  // mercato non passa da qui — passa dalla regola di copertura di §4.8, che lo tiene dentro perche'
  // ha capitale esposto.
  const scelti = new Set(sel.idsAttivi);
  const prima = Array.isArray(opzioni.onlyMarketIds) ? opzioni.onlyMarketIds.map((x) => String(x).trim().toLowerCase()) : null;
  const dopo = prima ? prima.filter((x) => scelti.has(x)) : [...scelti];
  return { ...opzioni, onlyMarketIds: dopo.length ? dopo : ['0x' + '0'.repeat(64)] };
}

/** Il piano, fuori da questo processo. Rifiuta invece di restituire un piano parziale o indovinato. */
function calcolaPianoFuoriProcesso(opzioniGrezze) {
  const opzioni = restringiAllaSelezione(opzioniGrezze || {});
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

const QUAR_FILE = path.join(DATA_DIR_A41, 'quarantena-venue.json');
function leggiQuarantena() {
  try { return JSON.parse(fs.readFileSync(QUAR_FILE, 'utf8')).mercati || {}; } catch { return {}; }
}
function scriviQuarantena(reg) {
  try {
    const tmp = `${QUAR_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), atIso: new Date().toISOString(), mercati: reg }, null, 1));
    fs.renameSync(tmp, QUAR_FILE);
  } catch (e) { annuncia('log', `quarantena non scritta: ${e.message}`); }
}

// ⚠ LA QUARANTENA ENTRA NEL PIANO. Il ciclo pesante si fermava con «dopo 3 ricalcoli il piano contiene
// ancora mercati che il venue rifiuta»: l'esclusione veniva passata, ma il ricalcolo ripescava dallo
// STESSO board, sporco per una CLASSE di mercati (`premio-crollato`: montepremi da $100/g a $5/g), non
// per uno. Escluso il primo, la passata dopo trovava il secondo. Adesso l'esito della verifica
// sopravvive al ciclo e il pianificatore non li ripesca. La verifica NON e' toccata: si pulisce la
// fonte, non si allenta il controllo.
async function calcolaPiano({ capital, maxPerMarketUsd, onlyMarketIds = null, excludeMarketIds = null }) {
  const inQuarantena = QUAR.attivi({ registro: leggiQuarantena() });
  if (inQuarantena.length) {
    const u = new Set([...(excludeMarketIds || []), ...inQuarantena]);
    excludeMarketIds = [...u];
    annuncia('log', `piano: ${inQuarantena.length} mercato/i in quarantena (il venue li ha bocciati di recente) esclusi a monte`);
  }
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
      const pr = writeCollectorPriority(piano, {
        candidati: candidatiPerIlFeed(),
        posizioni: mercatiConPosizione(),
      });
      annuncia('log', `priorità del raccoglitore aggiornate: ${pr.marketIds.length} mercati`
        + ` (${pr.freschi} da questo piano, ${pr.conPosizione} con posizione aperta,`
        + ` ${pr.candidati} CANDIDATI seminati nel feed${pr.candidatiTagliati ? ` (${pr.candidatiTagliati} oltre il tetto)` : ''},`
        + ` ${pr.trattenuti} tenuti caldi, ${pr.scaduti} lasciati raffreddare)`);
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

function registraBocciatiDalVenue(esclusi) {
  try {
    if (!Array.isArray(esclusi) || !esclusi.length) return 0;
    const reg = QUAR.aggiorna({ registro: leggiQuarantena(), bocciati: esclusi });
    scriviQuarantena(reg);
    annuncia('log', `quarantena: ${esclusi.length} mercato/i bocciati dal venue non torneranno nel piano per ${QUAR.DURATA_MS / 60000} minuti`
      + ` — ${esclusi.map((x) => `${String(x.marketId || x).slice(0, 10)} ${x.stato || ''}`).join(' · ')}`);
    return esclusi.length;
  } catch (e) { annuncia('log', `quarantena non aggiornata: ${e.message}`); return 0; }
}

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
  // LA SELEZIONE PRIMA DEL PIANO, sempre: il piano si calcola sui mercati scelti, quindi sceglierli
  // dopo significherebbe pianificare su quelli di sei ore fa. Non solleva mai (vedi la funzione).
  try { await selezionaMercati(); }
  catch (e) { annuncia('log', `selezione automatica non eseguita: ${e.message} — il ciclo prosegue con la lista di prima`); }
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

  // I mercati che il venue ha bocciato entrano in QUARANTENA: è l'unica cosa che rende utile un
  // fail-closed che altrimenti si ripeterebbe identico al ciclo dopo, ripescando dallo stesso board.
  try { registraBocciatiDalVenue((referto && referto.esclusiDalVenue) || []); }
  catch { /* la quarantena non deve poter far fallire il referto */ }
  scrivi({ at: new Date().toISOString(), tipo: 'ciclo-referto', motivoAvvio, ...referto });
  // Il capitale al lavoro si dice anche qui, non solo nel mini-ciclo: il ciclo da 6h è quello che
  // RIBILANCIA, quindi è il punto in cui la misura cambia di più ed è più utile leggerla.
  raccontaCapitaleAlLavoro(referto && (referto.utilizzoStimatoDopo || referto.utilizzo), referto, 'ciclo-6h');
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
// ⚠ IL QUINTO LETTORE DEL BOARD NORMALIZZATO, e il 17 agosto era l'unico rimasto col letterale: gli altri
// quattro passano da `lib/maker/percorsi-feed` da stamattina. Conseguenza misurata dal banco al passo 16:
// `scadenzaDalBoard` leggeva il file VERO di /tmp mentre tutto il resto leggeva la fotografia del banco,
// quindi la scadenza del mercato «non era determinabile» e il rilascio dal perimetro non scattava mai.
// Un percorso cablato in un punto solo su cinque e' una divergenza che aspetta di succedere.
const BOARD_NORMALIZZATO = require('../lib/maker/percorsi-feed').fileBoardNormalizzato();

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

// ══ LA SELEZIONE AUTOMATICA DEI MERCATI ══════════════════════════════════════════════════════════
// Fino al 15 agosto 2026 la lista dei mercati quotabili si riempiva a mano. Da qui la riempie il bot,
// dentro i vincoli dell'operatore: `rewardsMinSize <= 20`, scadenza >= 48 h, niente famiglia meteo, al
// piu' 2 contemporaneamente, e uno slot che si libera SOLO a posizione chiusa.
//
// La decisione e' in `lib/maker/selezione-mercati.js` ed e' pura: qui c'e' solo il cablaggio, cioe' le
// letture (board, posizioni, quarantena) e le scritture. Le scritture NON sono una strada nuova verso
// la allowlist: chi entra passa da `preparaMercatoNuovo`, cioe' dalle stesse quattro scritture del
// mini-ciclo e della fase 3 del reset; chi esce passa da `setAutoReprice`, la stessa funzione del
// ciclo delle sei ore. Una seconda strada sarebbe una seconda verita' sullo stesso file.
const SELM = require('../lib/maker/selezione-mercati');
// R1 · quanti mercati contemporanei: dall'ambiente di QUESTO processo, non da una costante.
const QUANTI = require('../lib/maker/quanti-mercati');
const SCAD = require('../lib/maker/scadenza-fuori-perimetro');
const SELS = require('../lib/maker/selezione-stato');
const BOARD_REWARD = path.join(DATA_DIR_A41, 'liquidity-rewards.json');

/** Il board dei mercati premianti (l'uscita di agent24). `null` — MAI `[]` — se non si legge: la
 *  differenza decide se la selezione si astiene o crede che il mondo sia vuoto. */
function leggiBoardReward(file = BOARD_REWARD) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.markets) ? raw.markets : null;
  } catch { return null; }
}

/** I mercati con una posizione APERTA al venue, per conditionId. Dallo snapshot su disco: nessuna
 *  chiamata di rete, e quindi nessuna superficie che sappia piazzare. */
function posizioniPerSelezione(leggi = readVenuePositions) {
  let p;
  try { p = leggi(); } catch (e) { return { leggibile: false, motivo: e.message, conditionIds: [] }; }
  if (!p || p.readable !== true) return { leggibile: false, motivo: (p && p.reason) || 'snapshot non leggibile', conditionIds: [] };
  const ids = [];
  for (const x of (p.positions || [])) {
    const c = typeof x.conditionId === 'string' ? x.conditionId.trim().toLowerCase() : '';
    // Una riga senza size positiva non e' una posizione aperta; una size illeggibile NON vale zero.
    const s = Number(x.size);
    if (c && Number.isFinite(s) && s > 0 && !ids.includes(c)) ids.push(c);
  }
  return { leggibile: true, motivo: null, conditionIds: ids };
}

/**
 * IL TERZO MECCANISMO CHE PUO' SPEGNERE UN MERCATO, e l'unico nato nel 2026 dopo i primi due.
 *
 * Gli altri due sono `setTracking` (il ciclo delle sei ore, che rilascia cio' che il piano non vuole
 * piu') e `impostaBot` (il fermo di sicurezza dell'ultimo gradino). Questo e' il rilascio della
 * selezione automatica: un mercato che ha smesso di rispettare i vincoli non deve ricevere ordini
 * nuovi. Ha una funzione tutta sua, con un nome che si legge nel giornale e nel test, perche'
 * `trigger-capitale-fermo.test.js` pretende — giustamente — che ogni `enabled: false` del file
 * appartenga a un meccanismo DICHIARATO invece di essere contato e basta.
 *
 * ⚠ SPEGNE L'INGRESSO, NON L'USCITA. Non tocca `setAutoClose`, non tocca il tracking e non cancella
 * nessun ordine: gli ordini gia' a riposo muoiono per GTD o si riempiono, e la posizione resta gestita
 * per la regola di copertura di §4.8 («board ∪ mercati dove il capitale e' gia' esposto»). Se qui si
 * spegnesse anche l'uscita automatica, un mercato scaduto resterebbe senza via d'uscita — ed e'
 * esattamente il guasto di §5-bis p.44.
 */
async function rilasciaDallaSelezione({ marketId, motivo }) {
  try {
    return await setAutoReprice({
      scope: 'market', marketId, enabled: false, by: 'riallocatore · selezione automatica',
      reason: `fuori dai vincoli della selezione automatica (${motivo}): nessun ordine nuovo, la posizione resta gestita`,
    });
  } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
}

/** I mercati che la selezione ha scelto, quando e' accesa. `{attiva:false}` ⇒ il piano non si
 *  restringe e tutto resta come prima: la selezione spenta non deve poter cambiare nessun numero. */
function selezioneAttiva() {
  try {
    const s = SELS.leggiStato();
    if (!s.leggibile || s.attiva !== true) return { attiva: false, ids: [], idsAttivi: [] };
    const sel = s.stato.selezionati || {};
    // ⚠ DUE ELENCHI, E LA DIFFERENZA E' LA ROTAZIONE (15 agosto 2026).
    //   `ids`       tutti: attivi + in gestione. E' l'insieme che il bot sta seguendo.
    //   `idsAttivi` i soli che QUOTANO. E' l'insieme a cui il PIANO puo' aprire posizioni nuove.
    // Un mercato in gestione sta completando una coppia: aprirci sopra una gamba nuova rifarebbe
    // esattamente l'esposizione che si sta chiudendo.
    return {
      attiva: true,
      ids: Object.keys(sel),
      idsAttivi: Object.entries(sel).filter(([, v]) => v && v.inGestione !== true).map(([k]) => k),
    };
  } catch { return { attiva: false, ids: [], idsAttivi: [] }; }
}

/**
 * UN GIRO DI SELEZIONE. Si chiama a ogni ciclo (6 h) e a ogni controllo del capitale fermo (2 min):
 * un mercato che scade deve uscire in minuti, non in ore.
 *
 * Non piazza e non cancella niente. Non solleva mai: un guasto qui deve lasciare il bot esattamente
 * come lo ha trovato, non fermarlo.
 */
// ══ I NETTI DEI CANDIDATI, PER LA RICLASSIFICAZIONE DELLA SELEZIONE — 16 agosto 2026 ═══════════════
//
// La selezione ordina e spodesta col NETTO del knapsack (`selezione-mercati.valoreCandidato`), non col
// lordo del board. Il netto pero' nasce da `planFromCollection`, quindi va calcolato qui e iniettato:
// il modulo di selezione e' puro e non puo' chiamarlo.
//
// ⚠ NON SI PUO' RIUSARE IL PIANO DEL MINI-CICLO, ed e' il punto che rende necessaria questa funzione.
// `calcolaPianoFuoriProcesso` applica `restringiAllaSelezione`, cioe' restringe l'universo ai mercati
// GIA' SCELTI: un piano cosi' non sa niente degli SFIDANTI, che per definizione sono fuori dalla
// selezione. Chiedergli i netti dei candidati sarebbe chiedere a chi ha gia' deciso di rivalutare la
// propria decisione con i propri dati. Qui si chiama il pianificatore DIRETTAMENTE, senza restrizione.
//
// ⚠ E SI CHIAMA CON PARSIMONIA. Il processo figlio costa secondi e la selezione gira ogni 120 s, ma i
// netti si muovono col BOARD, che agent24 riscrive ogni 15 minuti: ricalcolarli piu' spesso del board
// e' lavoro buttato. Cache a 10 minuti — meno del periodo del board, cosi' un board nuovo viene sempre
// visto entro un giro.
const NETTI_TTL_MS = 10 * 60_000;
let _netti = { at: 0, mappa: null };

async function nettiDeiCandidati(board, orizzonteMassimoOre) {
  const ora = Date.now();
  if (_netti.mappa && (ora - _netti.at) < NETTI_TTL_MS) return _netti.mappa;
  try {
    const ammissibili = (board || [])
      .filter((r) => SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre }).ammissibile)
      .map((r) => String(r.conditionId || '').trim().toLowerCase())
      .filter(Boolean);
    if (!ammissibili.length) { _netti = { at: ora, mappa: {} }; return _netti.mappa; }
    const capitale = await (async () => { const s = await leggiSaldo(); return s && s.readable === true ? s.usd : null; })();
    if (!fin(capitale)) return null;   // capitale ignoto ⇒ nessun netto ⇒ nessuno spodestamento
    const piano = await new Promise((risolvi, rifiuta) => {
      const figlio = execFile('node', ['-e', RUNNER_PIANO],
        { timeout: PLAN_TIMEOUT_MS, maxBuffer: PLAN_MAX_BUFFER },
        (err, stdout) => {
          if (err) return rifiuta(new Error(err.killed ? `timeout ${PLAN_TIMEOUT_MS}ms` : err.message));
          try { risolvi(JSON.parse(stdout)); } catch (e) { rifiuta(new Error(`JSON non valido: ${e.message}`)); }
        });
      figlio.on('error', (e) => rifiuta(e));
      // ⚠ NIENTE `restringiAllaSelezione`: qui servono i netti degli SFIDANTI. La finestra e' 24 h e non
      // 6 h perche' sotto le 24 h molti mercati rispondono `nessun-fill-osservato`, cioe' netto `null`,
      // e un netto che non si sa non spodesta e non si fa spodestare: la selezione resterebbe congelata.
      // ⚠ IL TETTO SI DERIVA DAL CAPITALE, come in ogni altro punto che pianifica (§4.2). Qui c'era
      // `MARKET_CAP_FIXED_USD` nudo, ed e' stato preso da `coerenza-tetto-derivato.test.js`, che
      // pretende che nessun percorso di piano usi la costante per DECIDERE. Non era una svista senza
      // conseguenze: `capPerMarketUsd` si clampa al capitale, quindi con meno di $61,25 liquidi la
      // classifica degli sfidanti sarebbe stata calcolata su un piano che il bot non puo' finanziare.
      // Puo' solo STRINGERE — e' un `Math.min` — e `capitale` e' gia' garantito finito qui sopra.
      figlio.stdin.end(JSON.stringify({
        capital: capitale, maxPerMarketUsd: capPerMarketUsd(capitale),
        from: new Date(ora - 24 * 3_600_000).toISOString(), to: new Date(ora).toISOString(),
        horizonFilter: true, onlyMarketIds: ammissibili,
      }));
    });
    const mappa = {};
    for (const c of (piano && piano.candidates) || []) {
      const id = String(c.marketId || '').trim().toLowerCase();
      if (id && fin(c.bestNetPerDay)) mappa[id] = c.bestNetPerDay;
    }
    _netti = { at: ora, mappa };
    return mappa;
  } catch (e) {
    // ⚠ FALLISCE CHIUSO: `null` ⇒ la selezione ordina col lordo e NON spodesta nessuno. Non si tiene la
    // mappa vecchia: un netto di venti minuti fa deciderebbe di cancellare ordini di adesso.
    annuncia('log', `netti dei candidati non calcolabili (${e.message}) — la selezione ordina col lordo e non spodesta nessuno`);
    return null;
  }
}

/** I mercati con ordini a RIPOSO al venue, per la condizione ③ dello spodestamento.
 *  ⚠ FAIL-CLOSED: qualunque lettura fallita ⇒ `leggibile:false` ⇒ nessuno viene spodestato. Cancellare
 *  ordini vivi sulla base di una lista che non si e' potuta leggere e' il modo di perdere capitale che
 *  stava gia' maturando reward. */
async function mercatiConOrdiniVivi(deps = {}) {
  try {
    const leggi = deps.listOrders || (() => listManualOrders({}));
    const o = await leggi();
    if (!o || o.ok === false || !Array.isArray(o.orders)) return { leggibile: false, ids: [] };
    return { leggibile: true, ids: Object.keys(TRIG.notionalePerMercato(o.orders)) };
  } catch { return { leggibile: false, ids: [] }; }
}

// ══ IL RICONCILIATORE: NIENTE DOPPIONI, E NESSUNO SLOT VUOTO — 16 agosto 2026 ═══════════════════════
//
// Gira a ogni ciclo, PRIMA della selezione, e fa due cose che nessuno faceva:
//   ① toglie i doppioni gia' a libro (`doppioni.trovaDoppioni`), tenendone uno;
//   ② dichiara la copertura di ogni mercato attivo (`copertura-gambe.valutaCopertura`) e, quando un
//      mercato resta non quotabile oltre la soglia, lo marca come DA SOSTITUIRE.
//
// ⚠ NON PIAZZA. Il ripiazzamento delle gambe mancanti resta al percorso che gia' piazza — il piano e
// `piazzaCoppia` — e qui ci si limita a CHIEDERLO forzando il mini-ciclo. Una seconda strada verso il
// venue sarebbe una seconda verita' sui prezzi e sui gate, e il duplicato di stamattina e' nato proprio
// da due percorsi che credevano cose diverse sullo stesso ordine.
//
// ⚠ CANCELLARE SI', ED E' ASIMMETRICO DI PROPOSITO: togliere un doppione riduce esposizione e non ne
// crea, quindi puo' avvenire qui senza passare dal piano. E' la stessa asimmetria per cui il guardiano
// delle perdite puo' cancellare da solo e non puo' piazzare.
const _nonQuotabileDal = new Map();   // conditionId → epoch ms della prima osservazione consecutiva
const _ripristino = new Map();        // conditionId → {ultimoTentativo, fallimenti} (§ RIP.memoriaDopo)

// ══ IL RIPRISTINO DI UNA GAMBA MANCANTE — 17 agosto 2026 ═══════════════════════════════════════════
//
// LA MISURA CHE LO GIUSTIFICA (`data/ricerca/gambe-16-agosto.md`): il 16 agosto il bot ha avuto due
// gambe vive solo il **50,0%** del tempo, e **17 delle 22 cadute lunghe non sono mai tornate**.
// Nessun percorso rimetteva la gamba: il trigger a capitale fermo apre MERCATI, agent40 riprezza cio'
// che esiste, e su zero ordini non ha niente su cui iterare.
//
// ⚠ NON E' UNA SECONDA STRADA VERSO IL VENUE, ed e' la condizione che rende questa riga accettabile.
// Fin qui il commento sopra diceva «NON PIAZZA … una seconda strada sarebbe una seconda verita' sui
// prezzi e sui gate». Resta vero, e per questo il ripristino non costruisce niente di suo: prende la
// riga dal piano GIA' SALVATO, la converte con `gambeDiUnaRiga` — la stessa funzione del mini-ciclo —
// e la manda a `piazzaCoppia`, cioe' allo stesso `runBulkAllocation` di sempre, con lo stesso freno,
// gli stessi tetti e gli stessi gate. Non c'e' un prezzo nuovo e non c'e' un cancello nuovo.
//
// ⚠ E NON RICOSTRUISCE IL PIANO. E' la differenza esatta con `controlloCapitaleFermo`, la chiamata che
// il 16 agosto ha prodotto 799 ricostruzioni consecutive: se il piano salvato non contiene questo
// mercato, NON si ricalcola — si dichiara e si passa oltre. Ricalcolare qui rimetterebbe il ciclo
// dentro l'anello che sta osservando.
//
// ⚠ E NON ABILITA NIENTE. `controlloCapitaleFermo` chiama `preparaMercatoNuovo` su cio' che il piano
// sceglie, e il piano non conosce i tre slot: e' cosi' che nacque il quarto mercato in allowlist. Qui
// si itera `sel.idsAttivi`, cioe' mercati che la selezione ha GIA' scelto e che qualcuno ha GIA'
// preparato. Nessuna scrittura su allowlist, gestione manuale, uscita automatica o catalogo.
// ⚠ SI RICOSTRUISCE LA COPPIA, NON LA GAMBA — 17 agosto 2026, decisione dell'operatore.
//
// Il passo 13 del banco si fermava qui: `$28,00` a riposo (87,5 share) + `$39,17` di gamba nuova (62,2
// share) = `$67,17` contro un tetto di `$61,25`. **La causa non era il tetto: era l'asimmetria.** Una
// coppia simmetrica costa per costruzione esattamente il capitale della riga, quindi non lo puo'
// sfondare — le due size divergono perche' `gambeDiUnaRiga` calcola `Q = capitale/(p_yes+p_no)` e la
// gamba superstite porta addosso la size dell'ISTANTE in cui fu piazzata, con `p_yes+p_no` di allora.
//
// ⚠ E LA DIAGNOSI CHE AVEVO SCRITTO PRIMA ERA SBAGLIATA: «il riprezzo ricalcola la size». Non lo fa —
// `auto-reprice` passa `size: order.size` a `replaceManualOrder`, in undici punti. Il difetto era piu'
// generale e piu' semplice: nessuno riportava la gamba VIVA alla size di oggi.
//
// La cura sta in `coppia-simmetrica.dimensionaCoppia`: una size per tutte e due, `min(piano, tetto,
// gamba viva)`, mai piu' grande di quella viva. E l'ordine delle due azioni e' parte della cura —
// **prima si riduce, poi si piazza** — perche' il gate somma il nozionale a riposo: piazzare per primo
// incontrerebbe ancora il tetto vecchio. Se la riduzione fallisce NON si piazza: due gambe asimmetriche
// sono peggio di una gamba sola.
async function ripristinaGamba({ id, v, riga, ora, deps }) {
  // ⚠ IL CAMPO E' `id`, NON `conditionId` — e questa riga l'ha sbagliato alla prima stesura, cioe' la
  // quinta occorrenza della classe «nome sbagliato ⇒ valore di difetto che nessuno ha chiesto»
  // (§5.3). `some` su un campo inesistente e' sempre `false`, quindi il precontrollo non vedeva mai
  // il lucchetto: a salvare la situazione era solo `LOCK.prendi` piu' sotto, che rifiuta davvero.
  // L'ha preso il test dello scatto, non la rilettura. E si esclude chi e' SCADUTO: un lucchetto
  // scaduto non tiene piu' niente, e trattarlo come preso murerebbe il mercato per sempre.
  const lockPreso = LOCK.stato(ora).some((x) => x.id === id && x.scaduto !== true);
  const d = RIP.valutaRipristino({ stato: v.stato, mancanti: v.mancanti, ora, lockPreso,
    memoria: _ripristino.get(id) || null });
  if (!d.tenta) return { tentato: false, motivo: d.motivo };

  if (!riga) return { tentato: false, motivo: 'nessuna riga nel piano salvato per questo mercato: si dichiara e NON si ricalcola' };
  const g = gambeDiUnaRiga(riga, riga.computedDefaultOffsetTicks);
  if (g.scarto || !g.rows) {
    return { tentato: false, motivo: `gambe non costruibili: ${(g.scarto && g.scarto.motivo) || 'nessuna riga costruita'}` };
  }
  // I due token del mercato sono la tabella di traduzione token → book: `valutaCopertura` risponde in
  // token (sono gli ordini a portarlo), `gambeDiUnaRiga` produce righe con `book`. Vengono dalla
  // STESSA riga di board che ha alimentato il giudizio, non da una seconda lettura.
  const sel = RIP.gambeDaMandare({ gambe: g.rows, mancanti: v.mancanti,
    tokenIdYes: v.tokenIdYes, tokenIdNo: v.tokenIdNo });
  if (!sel.righe.length) return { tentato: false, motivo: sel.motivo };

  // ── LA SIZE DELLA COPPIA, DECISA UNA VOLTA SOLA PER TUTTE E DUE LE GAMBE ────────────────────────
  // ⚠ IL TETTO INIETTATO E' `MARKET_CAP_FIXED_USD` E NON `capPerMarketUsd(capitale)`, ed e' voluto: qui
  // non si sta pianificando, si sta dimostrando che l'ordine che stiamo per mandare NON verra' rifiutato.
  // Il gate che rifiuta (`valutaNozionaleMercato`, manual-order.js:827) confronta contro la costante, e
  // proporre contro un tetto diverso da quello che giudica e' la divergenza di §5-bis p.126: si
  // proporrebbe l'impossibile. Il vincolo del capitale e' gia' dentro `riga.capital`, cioe' in `qPiano`.
  const ordiniQui = (Array.isArray(deps.ordiniVivi) ? deps.ordiniVivi : [])
    .filter((o) => String((o && (o.marketId || o.conditionId)) || '').trim().toLowerCase() === id);
  const dim = COPS.dimensionaCoppia({ gambe: g.rows, ordiniVivi: ordiniQui,
    tokenIdYes: v.tokenIdYes, tokenIdNo: v.tokenIdNo,
    tettoUsd: MARKET_CAP_FIXED_USD, minSizeShares: riga.minSizeShares });
  if (!dim.ok) return { tentato: false, motivo: `coppia non dimensionabile: ${dim.motivo}`, dimensione: dim };
  // ⚠ LE DUE LETTURE DEVONO CONCORDARE, e se non concordano non si agisce. `gambeDaMandare` decide QUALI
  // lati mandare partendo da `v.mancanti` (il giudizio di copertura); `dimensionaCoppia` guarda gli ordini
  // vivi per conto proprio. Sono due osservazioni della stessa cosa: se dicono lati diversi, una delle due
  // e' vecchia — e piazzare sulla base di quella sbagliata e' esattamente il doppione che si sta togliendo.
  const latiDaMandare = [...new Set(sel.righe.map((r) => String(r.book)))].sort().join('+');
  const latiSenzaGamba = [...new Set(dim.daPiazzare.map((r) => String(r.book)))].sort().join('+');
  if (latiDaMandare !== latiSenzaGamba) {
    return { tentato: false, dimensione: dim,
      motivo: `le due letture non concordano su quali lati manchino (copertura: ${latiDaMandare || 'nessuno'}, ordini vivi: ${latiSenzaGamba || 'nessuno'}): non si piazza su una lettura vecchia` };
  }
  const righeDaPiazzare = sel.righe.map((r) => ({ ...r, size: dim.size }));

  // ⚠ IL LUCCHETTO SI PRENDE PER TUTTA LA SEQUENZA e si rilascia in un `finally`: e' la stessa
  // disciplina del riprezzo (§ lock-mercato), e serve perche' fra il giudizio di copertura e l'invio
  // passa una chiamata di rete, cioe' la finestra in cui agent40 potrebbe riprezzare la gamba viva.
  // ⚠ E ADESSO SERVE DI PIU': dentro il lucchetto ci stanno DUE azioni (riduci, poi piazza), e fra le due
  // c'e' l'istante in cui la coppia e' piu' piccola del piano. Un riprezzo che entrasse in quella finestra
  // rimetterebbe la gamba viva alla size di prima e l'asimmetria tornerebbe.
  if (!LOCK.prendi(id, { da: 'ripristino-gambe', ora }).preso) {
    return { tentato: false, motivo: 'lucchetto non ottenuto fra il giudizio e l\'invio', dimensione: dim };
  }
  let ref = null;
  const ridotte = [];
  try {
    // ── ① PRIMA SI RIDUCE LA GAMBA VIVA ───────────────────────────────────────────────────────────
    // Il prezzo si RICOPIA da quello che l'ordine ha adesso: decidere il prezzo e' mestiere del motore,
    // e `replaceManualOrder` rifa' comunque banda e «mai primo sul libro» — se il prezzo non e' piu'
    // conforme rifiuta con `oldCancelled:false`, cioe' lascia l'ordine dov'era.
    const riprezza = deps.riprezza || replaceManualOrder;
    for (const r of dim.ridimensionamenti) {
      let rr = null;
      try {
        rr = await riprezza({ orderId: r.orderId, marketId: id, book: r.book, side: 'BUY',
          price: r.price, size: dim.size, userId: OPERATOR_USER, source: 'ripristino-coppia' }, {});
      } catch (e) { rr = { ok: false, reason: e && e.message ? e.message : String(e) }; }
      ridotte.push({ orderId: r.orderId, book: r.book, daSize: r.daSize, aSize: dim.size,
        riuscito: !!(rr && rr.ok), gate: (rr && rr.gate) || null, reason: (rr && rr.reason) || null });
      if (!(rr && rr.ok)) {
        // ⚠ SI ESCE SENZA PIAZZARE. La coppia resterebbe asimmetrica e sopra il tetto: la gamba nuova
        // verrebbe rifiutata dal gate (nel migliore dei casi) o accettata su un totale che nessuno ha
        // autorizzato. Una gamba sola e' uno stato che il bot sa gestire; due asimmetriche no.
        ref = { ok: false, placed: 0, reason: `riduzione della gamba viva non riuscita (${(rr && rr.gate) || 'senza gate'}): non si piazza la gamba nuova`, results: [] };
        return { tentato: true, riuscito: false, messe: 0, righe: righeDaPiazzare.length,
          gate: [(rr && rr.gate) || 'riduzione-non-riuscita'], motiviRifiuto: [(rr && rr.reason) || ''].filter(Boolean),
          dimensione: dim, ridotte,
          motivo: `coppia NON ricostruita: la riduzione della gamba viva da ${r.daSize} a ${dim.size} share e' stata rifiutata`
            + ` (${(rr && rr.gate) || 'senza gate'}) — non si piazza la gamba nuova, o la coppia resterebbe asimmetrica`,
          referto: ref };
      }
    }
    // ── ② POI SI PIAZZA LA GAMBA MANCANTE, alla stessa size ───────────────────────────────────────
    const piazza = deps.piazza || piazzaCoppia;
    let diag = { readable: false };
    try { diag = readUsage({ userId: OPERATOR_USER }); } catch { diag = { readable: false }; }
    ref = await piazza(righeDaPiazzare, diag);
  } catch (e) {
    ref = { ok: false, reason: e && e.message ? e.message : String(e), placed: 0 };
  } finally {
    LOCK.rilascia(id);
  }
  const messe = Number(ref && ref.placed) || 0;
  // ⚠ IL RIFIUTO PORTA LA SUA CAUSA, dal 17 agosto 2026. Prima il record diceva «nessuna gamba piazzata
  // (rifiutata)» e nient'altro: il PERCHE' si leggeva solo incrociando il giornale maker, riga per riga,
  // sull'istante giusto. Un presidio che dichiara il fallimento senza dichiararne la causa e' verificabile
  // a meta' — ed e' proprio il caso in cui serve, perche' la causa decide la cura: un tetto che morde si
  // corregge in un modo, un mercato non quotabile in un altro, una lettura mancante in un terzo.
  // I gate arrivano da `runBulkAllocation`, che li elenca per riga rifiutata: si prendono quelli DISTINTI.
  // ⚠ `ref.refused` E' UN CONTEGGIO, non una lista (`bulk-allocate.js:85`): la lista e' `ref.results`
  // filtrata per `status`. La prima stesura leggeva `ref.refused` come array e otteneva sempre zero gate —
  // cioe' aggiungeva un campo vuoto e sembrava averlo risolto. E' §5.3, «Number(null) === 0» nella sua
  // versione con gli array.
  const rifiuti = Array.isArray(ref && ref.results)
    ? ref.results.filter((r) => r && (r.status === 'refused' || r.status === 'orphan' || r.status === 'rolled-back'))
    : [];
  const gate = [...new Set(rifiuti.map((x) => String((x && (x.gate || x.outcome)) || '')).filter(Boolean))];
  const motiviRifiuto = [...new Set(rifiuti.map((x) => String((x && x.reason) || '')).filter(Boolean))].slice(0, 3);
  return { tentato: true, riuscito: messe > 0, messe, righe: righeDaPiazzare.length,
    gate, motiviRifiuto, dimensione: dim, ridotte,
    motivo: messe > 0
      ? `coppia ricostruita: ${messe} gamba/e a ${dim.size} share`
        + `${ridotte.length ? ` dopo aver ridotto la gamba viva (${ridotte.map((x) => `${x.daSize}→${x.aSize}`).join(', ')})` : ''}`
        + ` — $${dim.totaleUsd.toFixed(2)} sul tetto di $${MARKET_CAP_FIXED_USD.toFixed(2)} (vincolo: ${dim.vincolo})`
      : `nessuna gamba piazzata — ${gate.length ? `gate: ${gate.join(', ')}` : ((ref && ref.reason) || 'rifiutata senza gate dichiarato')}`
        + `${motiviRifiuto.length ? ` · ${motiviRifiuto[0].slice(0, 160)}` : ''}`,
    referto: ref };
}

async function riconciliaCopertura(deps = {}) {
  const esito = { doppioniRimossi: [], copertura: [], daSostituire: [], ripristini: [], ordiniLetti: null, motivo: null };
  let ordini;
  try {
    const leggi = deps.listOrders || (() => listManualOrders({}));
    const o = await leggi();
    ordini = (o && o.ok !== false && Array.isArray(o.orders)) ? o.orders : null;
  } catch (e) { ordini = null; esito.motivo = e && e.message ? e.message : String(e); }
  // ⚠ FAIL-CLOSED: senza la lista non si cancella e non si giudica. Cancellare al buio significherebbe
  // togliere ordini che non si e' visti; giudicare al buio significherebbe ripiazzare sopra ordini vivi.
  if (!ordini) {
    esito.motivo = `ordini vivi non leggibili${esito.motivo ? `: ${esito.motivo}` : ''} — nessun doppione rimosso, nessuna copertura giudicata`;
    annuncia('log', `riconciliazione: ${esito.motivo}`);
    scrivi({ tipo: 'riconciliazione-copertura', esito: 'astenuta', motivo: esito.motivo });
    return esito;
  }
  esito.ordiniLetti = ordini.length;

  // ── ① I DOPPIONI ────────────────────────────────────────────────────────────────────────────────
  const d = DOPP.trovaDoppioni(ordini);
  for (const x of d.daCancellare) {
    let r = null;
    try { r = await (deps.cancella || cancelManualOrder)({ orderId: x.orderId }, 'riconciliatore-doppioni'); }
    catch (e) { r = { ok: false, reason: e && e.message ? e.message : String(e) }; }
    const rimosso = !!(r && r.ok);
    esito.doppioniRimossi.push({ orderId: x.orderId, chiave: x.chiave, rimosso, motivo: x.motivo,
      error: rimosso ? null : ((r && r.reason) || 'motivo ignoto') });
    scrivi({ tipo: 'riconciliazione-copertura', esito: rimosso ? 'doppione-rimosso' : 'doppione-non-rimosso',
      orderId: x.orderId, chiave: x.chiave, motivo: x.motivo, error: rimosso ? null : ((r && r.reason) || null) });
    annuncia('log', `doppione-rimosso: ${x.orderId.slice(0, 14)}… — ${x.motivo}${rimosso ? '' : ' ⚠ CANCELLAZIONE FALLITA'}`);
  }
  if (d.illeggibili) annuncia('log', `riconciliazione: ${d.illeggibili} ordine/i senza token o lato leggibili — non giudicati, non cancellati`);

  // ── ② LA COPERTURA DEI MERCATI ATTIVI ───────────────────────────────────────────────────────────
  // La selezione e' iniettabile come il board e gli ordini: senza, questo percorso — che adesso
  // PIAZZA — non sarebbe esercitabile da un test se non riscrivendo lo stato vero della macchina.
  const sel = (deps.selezione || selezioneAttiva)();
  const board = deps.leggiBoard ? deps.leggiBoard() : leggiBoardReward();
  const ora = Date.now();
  // Il piano SALVATO, letto una volta sola per tutto il giro. Non si ricalcola mai da qui — vedi la
  // nota su `ripristinaGamba`: ricalcolare rimetterebbe il ciclo dentro l'anello che osserva.
  const pianoSalvato = (deps.leggiPiano || leggiUltimoPiano)();
  const rigaDi = (id) => ((pianoSalvato && pianoSalvato.righe) || [])
    .find((r) => String(r.marketId || '').trim().toLowerCase() === id) || null;
  let scoperti = 0;
  for (const id of (sel.idsAttivi || [])) {
    const riga = (board || []).find((r) => String(r.conditionId || '').trim().toLowerCase() === id) || null;
    // La quotabilita' viene dal MOTORE, non da un secondo giudizio: se il mercato non e' sul board non
    // si puo' nemmeno provare, ed e' gia' una risposta.
    const quotabile = riga ? { ok: true } : { ok: false, motivo: 'mercato non piu\' sul board' };
    const v = COP.valutaCopertura({
      conditionId: id, tokenIdYes: riga && riga.tokenId, tokenIdNo: riga && riga.tokenIdNo,
      ordini, quotabile, ora, nonQuotabileDal: _nonQuotabileDal.get(id) ?? null,
    });
    if (v.nonQuotabileDal == null) _nonQuotabileDal.delete(id); else _nonQuotabileDal.set(id, v.nonQuotabileDal);
    esito.copertura.push({ id, stato: v.stato, gambeVive: v.gambeVive, mancanti: v.mancanti.length, motivo: v.motivo });
    if (v.stato === 'da-coprire' || v.stato === 'non-quotabile') scoperti += 1;
    if (v.stato === 'da-sostituire') esito.daSostituire.push({ id, motivo: v.motivo });
    if (v.stato !== 'coperto') {
      scrivi({ tipo: 'riconciliazione-copertura', esito: v.stato, marketId: id,
        gambeVive: v.gambeVive, mancanti: v.mancanti, motivo: v.motivo });
      annuncia('log', `copertura ${id.slice(0, 12)}…: ${v.stato} (${v.gambeVive}/2 gambe) — ${v.motivo}`);
    }

    // ── ②-bis · LA GAMBA MANCANTE TORNA A LIBRO ───────────────────────────────────────────────────
    // ⚠ SI SCRIVE SEMPRE A VERBALE, ANCHE QUANDO NON SI TENTA. Fino a ieri questo riconciliatore
    // parlava solo con `annuncia`, cioe' con i log di pm2: il giornale del 16 agosto porta ZERO
    // record di copertura, e per questo la ricostruzione del 17 non ha potuto dire QUALI gambe
    // avesse visto mancanti — solo che la funzione era stata chiamata (§5.2, lacuna di p.10).
    // Un presidio che non lascia traccia non e' verificabile, e uno non verificabile non e' un
    // presidio: e' una speranza.
    let r = { tentato: false, motivo: 'stato coperto' };
    // ══ R4 · UNA GAMBA TOLTA PER EROSIONE NON SI RIMETTE PRIMA DEL TEMPO — 18 agosto 2026 ═════════
    // «Cancella e resta fuori. Ma con un tetto: non più di 5 minuti fuori per volta.» (l'operatore)
    //
    // ⚠⚠ SENZA QUESTO CONTROLLO LA REGOLA NON ESISTEREBBE. `ripristinaGamba` ha una scala di
    // raffreddamento che parte SUBITO — il primo tentativo è immediato, perché la GTD è 23 minuti —
    // quindi rimetterebbe a libro entro 120 s la gamba che agent40 ha appena tolto. «Fuori 5 minuti»
    // sarebbe durato due, e il giornale avrebbe mostrato una cancellazione e un ripristino, cioè
    // quello che il bot fa già: la regola sarebbe stata invisibile oltre che inerte.
    //
    // ⚠ SI GUARDA IL LATO MANCANTE, non il mercato: i due book sono CLOB indipendenti e si erodono in
    // momenti diversi. Se manca la gamba YES per erosione e la NO è sana, si aspetta solo la YES.
    //
    // ⚠ FAIL-APERTO, come dichiara `sospensione-erosione`: registro illeggibile ⇒ nessuna sospensione
    // ⇒ si ripristina. Una sospensione è un'astensione dal premio, e un file che non si legge non deve
    // poter tenere il bot fuori dal libro per sempre.
    const sospensioni = (deps.leggiSospensioni || SOSPE.leggiStato)();
    const latiSospesi = [];
    for (const m of (v.mancanti || [])) {
      const lato = String((m && m.book) || '').toLowerCase() === 'no' ? 'no' : 'yes';
      const a = SOSPE.attiva(sospensioni.stato, { marketId: id, book: lato, now: ora });
      if (a.sospeso) { latiSospesi.push({ lato, restaSec: a.restaSec, motivo: a.motivo }); continue; }
      // ⚠ IL RIENTRO PER TETTO SI DICHIARA, ed è un requisito esplicito dell'operatore: vuol dire che
      // il libro NON si è ricostruito in cinque minuti. Misurato il 17 agosto: succede in 66 episodi
      // su 97. Se si rientrasse in silenzio, il giornale non distinguerebbe «la profondità è tornata»
      // da «ci siamo arresi», che sono la stessa azione e due fatti opposti.
      if (a.voce && a.scadutoDaSec !== null) {
        try {
          const rel = SOSPE.rilascia(sospensioni.stato, { marketId: id, book: lato, causa: 'tetto' });
          if (rel.rilasciata) {
            SOSPE.scriviStato(rel.stato);
            sospensioni.stato = rel.stato;
            scrivi({ tipo: 'sospensione-erosione', esito: 'rientro-per-tetto', marketId: id, book: lato,
              fuoriSec: +((ora - rel.voce.da) / 1000).toFixed(1), baseline: rel.voce.baseline,
              ratioPct: rel.voce.ratioPct, motivo: rel.motivo });
            annuncia('error', `⚠ R4 · ${id.slice(0, 12)}…/${lato}: ${rel.motivo}`);
          }
        } catch (e) { annuncia('log', `R4 · rilascio per tetto non riuscito: ${e.message}`); }
      }
    }
    if (latiSospesi.length && latiSospesi.length >= (v.mancanti || []).length) {
      r = { tentato: false, riuscito: false,
        motivo: `sospeso per EROSIONE: ${latiSospesi.map((x) => `${x.lato} ancora ${x.restaSec}s`).join(' · ')}`
          + ' — la gamba resta fuori dal libro finché la profondità non risale o scade il tetto' };
      scrivi({ tipo: 'ripristino-gamba', esito: 'sospeso-per-erosione', marketId: id,
        mancanti: v.mancanti, lati: latiSospesi, motivo: r.motivo });
      annuncia('log', `ripristino ${id.slice(0, 12)}…: ${r.motivo}`);
    } else if (v.stato === 'da-coprire') {
      // `riga` qui e' la riga di BOARD (quella che ha alimentato il giudizio di copertura), e porta i
      // due token. `rigaDi(id)` e' la riga di PIANO, che porta prezzo e size. Sono due cose diverse e
      // vengono da due file diversi: confonderle e' il modo di piazzare sul mercato sbagliato.
      r = await ripristinaGamba({
        id,
        v: { ...v, tokenIdYes: riga && riga.tokenId, tokenIdNo: riga && riga.tokenIdNo },
        riga: rigaDi(id), ora,
        // ⚠ GLI ORDINI VIVI SI PASSANO, NON SI RILEGGONO. Sono gli STESSI su cui `valutaCopertura` ha
        // appena giudicato: una seconda lettura potrebbe divergere, e la divergenza qui deciderebbe la
        // size di una coppia — cioe' sarebbe capitale deciso su due fotografie diverse.
        deps: { ...deps, ordiniVivi: ordini },
      });
      esito.ripristini.push({ id, ...r, referto: undefined });
      scrivi({ tipo: 'ripristino-gamba', esito: r.tentato ? (r.riuscito ? 'rimessa' : 'rifiutata') : 'non-tentato',
        marketId: id, mancanti: v.mancanti, messe: r.messe || 0, gate: r.gate || null, motiviRifiuto: r.motiviRifiuto || null, motivo: r.motivo,
        // La coppia decisa e le riduzioni eseguite finiscono a verbale: senza, «rimessa» non dice a che
        // size, e la simmetria — che e' la proprieta' che questa correzione difende — non e' verificabile
        // sul giornale ma solo ricostruendola dagli ordini del venue.
        coppia: r.dimensione ? { size: r.dimensione.size, vincolo: r.dimensione.vincolo,
          totaleUsd: r.dimensione.totaleUsd, qPiano: r.dimensione.qPiano, qTetto: r.dimensione.qTetto,
          qViva: r.dimensione.qViva } : null,
        ridotte: (r.ridotte && r.ridotte.length) ? r.ridotte : null,
        fallimentiConsecutivi: (_ripristino.get(id) || {}).fallimenti || 0 });
      annuncia('log', `ripristino ${id.slice(0, 12)}…: ${r.motivo}`);
    }
    const memoria = RIP.memoriaDopo({ stato: v.stato, memoria: _ripristino.get(id) || null,
      tentato: r.tentato, riuscito: r.riuscito, ora });
    if (memoria == null) _ripristino.delete(id); else _ripristino.set(id, memoria);
  }
  // ⚠ LA MEMORIA DEI MERCATI CHE NON SONO PIU' ATTIVI SI BUTTA, o un mercato che rientra fra sei ore
  // si troverebbe addosso il raffreddamento di stamattina — cioe' aspetterebbe mezz'ora prima di
  // ricevere la sua prima gamba. Lo stesso ragionamento di `_nonQuotabileDal`, sullo stesso insieme.
  {
    const attivi = new Set(sel.idsAttivi || []);
    for (const k of [..._ripristino.keys()]) if (!attivi.has(k)) _ripristino.delete(k);
  }
  // ⚠ QUI C'ERA UNA CHIAMATA A `controlloCapitaleFermo`, ED E' STATA TOLTA IL 16 AGOSTO 2026 DOPO
  // AVERLA VISTA FARE DANNO. L'idea era «uno slot scoperto e' capitale che non lavora: si chiede il
  // ripiazzamento a chi piazza». Misurato in due ore di produzione: **799 record `da-coprire`
  // consecutivi**, cioe' una ricostruzione del piano forzata a OGNI ciclo — ognuna con un processo
  // figlio e un buffer da 48 MB — e agent41 passato da 9 a **14 riavvii**.
  //
  // E il danno peggiore non era il thrash: `controlloCapitaleFermo` abilita i mercati che il PIANO
  // sceglie, e il piano non conosce i tre slot della selezione. Forzandolo a ogni giro ha aggiunto un
  // QUARTO mercato (`0xf2b0c93903a1…`) alla allowlist, scavalcando in silenzio il tetto che la
  // selezione esiste per tenere.
  //
  // LA LEZIONE, che vale oltre questa riga: un riconciliatore OSSERVA. Nel momento in cui agisce
  // sull'anello che sta osservando, e l'azione non risolve la condizione osservata, l'anello non si
  // chiude piu' — e la frequenza del ciclo diventa la frequenza dell'azione. La condizione
  // «scoperto» qui non poteva essere risolta dalla chiamata, perche' i mercati non erano quotabili:
  // ogni giro ritrovava lo stesso stato e riprovava.
  //
  // Adesso si DICHIARA e basta. Il ripiazzamento resta al trigger a capitale fermo, che gira gia' ogni
  // 120 s con il suo cooldown e la sua soglia — cioe' esattamente il lavoro che stavo duplicando.
  if (scoperti > 0) {
    esito.motivo = `${scoperti} mercato/i scoperto/i: dichiarati, il ripiazzamento resta al trigger a capitale fermo`;
  }
  return esito;
}

// ══ LA ALLOWLIST DERIVA DALLA SELEZIONE — 16 agosto 2026 ═══════════════════════════════════════════
//
// ⚠ IL DIFETTO, OSSERVATO: `data/maker-auto-reprice.json` aveva **4 mercati abilitati** contro i **3**
// della selezione. `0x776841ce…` era stato sostituito alle 12:34 e non era mai stato disabilitato.
//
// LA CAUSA E' STRUTTURALE, NON UN CASO. Le uscite dalla selezione finiscono in TRE liste — `uscenti`
// (vincolo violato), `spodestati` (riclassificazione) e `liberati` (coppia chiusa, riga sparita dal
// board, gia' dichiarato uscente) — e il cablaggio chiamava `rilasciaDallaSelezione` solo sulle prime
// due. Ogni percorso nuovo che libera uno slot doveva ricordarsi di spegnere anche la allowlist, e
// prima o poi uno non se ne ricorda. E' successo.
//
// ⚠ LA CURA NON E' AGGIUNGERE LA TERZA CHIAMATA: e' smettere di sincronizzare due elenchi a mano. La
// allowlist si DERIVA dalla selezione — chi non e' nella selezione non e' abilitato — cosi' un
// percorso di uscita nuovo non ha niente da ricordare. E' la stessa regola di `occupati` derivato
// dallo stato invece che sommato dai delta, e di §4.5 (`alLavoro` per differenza, mai risommato).
//
// ⚠ SI SPEGNE E BASTA, NON SI ACCENDE. Abilitare un mercato richiede QUATTRO scritture coordinate
// (`preparaMercatoNuovo`: allowlist, gestione manuale, uscita automatica, catalogo di ripiego) e una
// sola di quelle mancante produce un mercato con ordini e senza via d'uscita. Una derivazione che
// accendesse ricreerebbe quel rischio da una porta laterale.
//
// ⚠ I MERCATI IN GESTIONE RESTANO ABILITATI (§4.13): si confronta con `sel.ids`, che li comprende, e
// non con `idsAttivi`. Toglierli farebbe morire la gamba sorella per GTD in ≤ 23 minuti, cioe' prima
// dei 30 che la scala d'uscita le concede.
//
// ⚠ FAIL-CLOSED: selezione spenta o illeggibile ⇒ NON si tocca niente. Una selezione che non si legge
// farebbe sembrare estranei tutti i mercati, e la derivazione li spegnerebbe tutti in un colpo.
async function riconciliaAllowlist(deps = {}) {
  // ⚠ `!== undefined` E NON `||`: una selezione iniettata a `null` — che significa «non leggibile» —
  // con l'`||` ricadeva sulla funzione VERA, cioe' su una selezione attiva, e la derivazione spegneva
  // i mercati veri credendo di lavorare su una finta. E' la classe `deps.stato` di §5.3, e l'ha presa
  // il test invece del ragionamento.
  const sel = deps.selezione !== undefined ? deps.selezione : selezioneAttiva();
  if (!sel || sel.attiva !== true || !Array.isArray(sel.ids)) {
    return { ok: false, motivo: 'selezione non attiva o illeggibile: la allowlist non si tocca', spenti: [] };
  }
  const dentro = new Set(sel.ids.map((x) => String(x).trim().toLowerCase()));
  let cfg;
  try { cfg = (deps.leggiConfig || readAutoRepriceConfig)(); }
  catch (e) { return { ok: false, motivo: `allowlist non leggibile: ${e.message}`, spenti: [] }; }
  if (!cfg || cfg.readable === false) return { ok: false, motivo: 'allowlist non leggibile', spenti: [] };

  const spenti = [];
  for (const [id, m] of Object.entries(cfg.markets || {})) {
    const k = String(id).trim().toLowerCase();
    if (!m || m.enabled !== true || dentro.has(k)) continue;
    const r = await (deps.rilascia || rilasciaDallaSelezione)({ marketId: k, motivo: 'fuori-selezione' });
    spenti.push({ id: k, spento: !!(r && r.ok), error: (r && r.error) || null });
    scrivi({ tipo: 'allowlist-derivata', esito: (r && r.ok) ? 'spento' : 'spegnimento-fallito', marketId: k,
      motivo: 'abilitato al riprezzo ma fuori dalla selezione: la allowlist deriva dalla selezione,'
        + ' non da chi ha abilitato per ultimo' });
    annuncia('log', `allowlist: ${k.slice(0, 12)}… era abilitato fuori dalla selezione ⇒ spento`);
  }
  return { ok: true, motivo: null, spenti, dentro: dentro.size };
}

// ══ LA SCADENZA TOGLIE IL MERCATO DAL PERIMETRO DA SOLA — 17 agosto 2026 ═══════════════════════════
// Decisione dell'operatore: «la scadenza del mercato deve togliere il mercato dal perimetro da sola,
// senza aspettare il ciclo da 6 h». Prima lo facevano due percorsi e nessuno bastava: la SELEZIONE, che
// esclude sotto le 24 h ma solo quando e' accesa (oggi e' spenta), e il ciclo da 6 ORE, che al piu' lo
// toglie dal PIANO — e sei ore sono la cadenza sbagliata per una scadenza.
// La decisione e' PURA (`lib/maker/scadenza-fuori-perimetro`): qui c'e' solo il cablaggio, e le tre
// letture arrivano dalle stesse funzioni che gia' esistono — nessuna terza fonte di verita'.
// ⚠ GIRA ANCHE A SELEZIONE SPENTA, ed e' il punto: `riconciliaAllowlist` si astiene quando la selezione
// non e' attiva (giustamente: deriva DA lei), quindi senza questa funzione il caso di oggi non era
// coperto da nessuno.
async function scadenzeFuoriPerimetro(deps = {}) {
  const cfg = (() => { try { return (deps.leggiConfig || readAutoRepriceConfig)(); } catch { return null; } })();
  if (!cfg || cfg.readable === false) return { ok: false, motivo: 'allowlist non leggibile: nessun rilascio', rilasciati: [] };
  const abilitati = Object.entries(cfg.markets || {}).filter(([, m]) => m && m.enabled === true).map(([k]) => k);
  if (!abilitati.length) return { ok: true, motivo: 'nessun mercato abilitato', rilasciati: [] };

  // Le posizioni e gli ordini: `null` quando NON si leggono, mai una lista vuota (il modulo puro si
  // astiene, e la differenza fra le due cose e' tutta la sicurezza di questa funzione).
  // ⚠ IL CAMPO E' `conditionIds`, NON `ids` — e la prima stesura scriveva `p.ids`, cioe' `undefined`,
  // cioe' «posizioni non leggibili», cioe' NESSUN RILASCIO MAI. La funzione si asteneva sempre e lo
  // dichiarava con un motivo credibile («una lettura mancante non e' un mercato vuoto»), quindi sembrava
  // prudenza e invece era il presidio spento. SESTA occorrenza della classe «nome sbagliato ⇒ valore di
  // difetto che nessuno ha chiesto» (§5.3), e l'ha presa il banco al passo 16 — non il test, che iniettava
  // `conPosizione` e quindi non passava da questa riga.
  const pos = deps.conPosizione !== undefined ? deps.conPosizione : (() => {
    const p = posizioniPerSelezione(deps.leggiPosizioni || undefined);
    return p && p.leggibile ? p.conditionIds : null;
  })();
  const ord = deps.conOrdiniVivi !== undefined ? deps.conOrdiniVivi : await (async () => {
    const o = await mercatiConOrdiniVivi(deps); return o && o.leggibile ? o.ids : null;
  })();

  const v = SCAD.valutaScadenze({
    abilitati, ora: deps.ora || Date.now(),
    conPosizione: pos, conOrdiniVivi: ord,
    // La scadenza dal BOARD riconciliato: la stessa funzione che usa la verifica dei mercati, quindi
    // pianificatore, verifica e questo rilascio parlano dello stesso istante per costruzione.
    scadenzaMs: deps.scadenzaMs || ((id) => { const iso = scadenzaDalBoard(id, null); const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; }),
    chiuso: deps.chiuso || null,
  });

  const rilasciati = [];
  for (const c of v.daRilasciare) {
    const r = await (deps.rilascia || rilasciaDallaSelezione)({ marketId: c.id, motivo: 'scaduto' });
    rilasciati.push({ id: c.id, oreResidue: c.oreResidue, spento: !!(r && r.ok), error: (r && r.error) || null });
    scrivi({ tipo: 'scadenza-fuori-perimetro', esito: (r && r.ok) ? 'rilasciato' : 'rilascio-fallito',
      marketId: c.id, oreResidue: c.oreResidue, chiusoAlVenue: c.chiusoAlVenue, motivo: c.motivo });
    annuncia('log', `perimetro: ${c.id.slice(0, 12)}… ${c.motivo}`);
  }
  // ⚠ SI SCRIVE A VERBALE ANCHE QUANDO NON SI RILASCIA NIENTE, e non e' rumore: senza questa riga
  // «nessun mercato scaduto» e «non ho potuto guardare» sarebbero lo stesso silenzio. E' la lezione di
  // §5-bis p.171 (un presidio che non lascia traccia non e' verificabile).
  if (!v.daRilasciare.length) {
    scrivi({ tipo: 'scadenza-fuori-perimetro', esito: v.motivo ? 'astenuta' : 'niente-da-rilasciare',
      motivo: v.motivo || `${v.tenuti.length} mercato/i abilitati, tutti sopra il pavimento di ${v.oreMinime} h o con qualcosa da gestire`,
      tenuti: v.tenuti.slice(0, 8) });
  }
  return { ok: true, motivo: v.motivo, rilasciati, tenuti: v.tenuti.length, oreMinime: v.oreMinime };
}

// ══ IL PRESIDIO: NESSUNA POSIZIONE DIREZIONALE OLTRE UN'ORA — 16 agosto 2026 ═══════════════════════
// Decisione dell'operatore dopo che un fill delle 15:19 e' rimasto aperto CINQUE ORE: le regole per
// chiuderlo c'erano tutte e nessuna e' scattata, perche' l'orologio della scala si azzera a ogni
// ripiazzamento del completamento (§5-bis p.138). La correzione della scala e' rimandata; questo e' il
// limite superiore al danno nel frattempo.
// ⚠ SOLO CHIUDE. Non apre, non riprezza, non tocca la scala. E attraversa lo spread dichiarandolo
// (`attraversaApposta`), perche' un'uscita che resta appesa sopra il book non e' un'uscita — e' il
// modo in cui oggi la posizione e' sopravvissuta al proprio gradino.
// ══ IL PREZZO DI UN'USCITA ATTRAVERSATA, E IL LIMITE R6 — UNA VOLTA SOLA ═════════════════════════
// Estratta il 18 agosto 2026 quando il kill a −$100 ha avuto bisogno della stessa vendita del presidio
// dei 60 minuti (R10). Ricopiarla avrebbe prodotto due idee di «quanto sotto il bid si vende» che un
// giorno divergono — il reperto D1 su un'azione che tocca capitale reale.
//
// Si vende ATTRAVERSANDO: un tick SOTTO il miglior bid, cosi' l'ordine si esegue davvero. In uscita il
// prezzo bello non serve a niente: un ordine che resta a libro non e' un'uscita.
function prezzoUscitaAttraversata(c, riga) {
  const bid = riga ? Number(riga.bestBid) : null;
  const tick = riga ? Number(riga.tickSize) : 0.01;
  const prezzo = Number.isFinite(bid) && bid > tick ? +(bid - tick).toFixed(6) : null;
  if (prezzo === null) {
    return { prezzo: null, valoreUsd: null, ricavoUsd: null,
      motivo: 'miglior bid non leggibile: non si vende al buio' };
  }
  // ══ R6 · IL LIMITE DELL'OPERATORE, MISURATO E NON PROMESSO ═════════════════════════════════════
  // REGOLA: «si chiude sempre, anche da taker. Limite: non spendere per uscire piu' di quanto la
  // posizione valga.»
  // ⚠ SU UNA VENDITA IL LIMITE HA UNA SOLA FORMA NON VUOTA, e va detta: chi vende non spende, INCASSA.
  // Il costo dell'uscita e' la rinuncia `(valore - ricavo)`, e `rinuncia <= valore` equivale a
  // `ricavo >= 0`, cioe' e' vero per costruzione a qualunque prezzo positivo. Quindi morde in un caso
  // solo — ricavo NULLO — e quel caso si rifiuta invece di passare come «chiusura riuscita a zero».
  // I tre numeri viaggiano comunque, o «si e' chiuso» non direbbe a che prezzo si e' rinunciato.
  // ⚠ LA META' DEL LIMITE CHE MORDEREBBE DAVVERO — comprare l'altro lato oltre 101c per sbloccare un
  // residuo col merge — NON e' implementata: non esiste un percorso che compri sopra il tetto della
  // coppia, e inventarlo sarebbe un meccanismo nuovo su capitale reale. Aperta in APERTI.md.
  const valoreUsd = Number.isFinite(c.curPrice) && c.curPrice > 0 ? +(c.curPrice * c.size).toFixed(4) : null;
  const ricavoUsd = +(prezzo * c.size).toFixed(4);
  if (!(ricavoUsd > 0)) {
    return { prezzo, valoreUsd, ricavoUsd,
      motivo: `ricavo nullo (${c.size} share a ${prezzo}): uscire non renderebbe niente, e il limite dell'operatore`
        + ' e\' di non spendere per uscire piu\' di quanto la posizione valga' };
  }
  return { prezzo, valoreUsd, ricavoUsd, motivo: null };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// R10 · IL KILL A −$100 CHIUDE ANCHE LE POSIZIONI — 18 agosto 2026, decisione dell'operatore
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// «a −$100 nella giornata cancella tutti gli ordini E chiude le posizioni. Coppie a merge, gambe
//  scoperte vendute a mercato, gambe sotto il minimo restano e vengono dichiarate.»
//
// A DECIDERE e' agent43, che deposita `data/chiusura-emergenza-richiesta.json` e NON puo' eseguire:
// la sua unica superficie al venue e' la spazzata, ed e' una proprieta' strutturale provata da un test
// che cammina il suo albero dei `require`. A ESEGUIRE e' questa funzione, che non puo' decidere. La
// separazione E' il presidio, non un ripiego architetturale.
//
// ⚠⚠ GIRA PRIMA DEI CANCELLI DI `controlloCapitaleFermo`, ED E' IL PUNTO DELLA CORREZIONE.
// Il presidio dei 60 minuti — «l'ultima rete» — sta DIETRO `if (!TRIGGER_ATTIVO || !botAttivo())`,
// cioe' non gira a bot FERMO. E FERMA e' esattamente lo stato che il kill produce: la rete non c'era
// proprio nel momento per cui esiste. Trovato collegando R10, non da un guasto.
//
// ⚠ IL KILL SWITCH RESTA DAVANTI, ed e' l'unico cancello che qui si rispetta. KILL attivo o non
// leggibile ⇒ non si vende: il KILL e' l'emergenza assoluta e §4 dice che lo leggono TUTTI i percorsi,
// auto-close compreso. Un'uscita che lo scavalca sarebbe una via nuova aperta nel momento peggiore.
//
// ⚠ COSA NON FA, e va detto per intero:
//   · NON fonde. Il merge ha un percorso solo (`auto-close.fondiCoppia`, agent40) e una seconda strada
//     verso il relayer sarebbe una seconda verita' su quale batch si firma. Le coppie si DICHIARANO
//     `da-fondere`; auto-close non e' gated da AVVIA e le fonde al suo giro.
//   · NON tocca le gambe sotto il minimo: restano, e la richiesta le elenca (R10).
//   · NON riapre niente e non tocca AVVIA/FERMA: chiude, e basta.
async function eseguiChiusuraDiEmergenza(deps = {}) {
  const file = deps.file || CHIUSURA_EMERGENZA_FILE;
  let ric = null;
  try { ric = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { return null; }
  // ⚠ Una richiesta gia' eseguita, o malformata, non e' un'emergenza: si esce in silenzio. Un file che
  // non si capisce NON diventa «chiudi tutto»: sarebbe la direzione di guasto peggiore.
  if (!ric || ric.eseguita !== false || !Array.isArray(ric.daVendere)) return null;

  const esito = { vendute: [], daFondere: (ric.daFondere || []).length,
    lasciate: (ric.lasciate || []).length, motivo: null };

  let kill = { effectivelyKilled: true, readable: false };
  try { kill = killSwitch.killStatus(); } catch { kill = { effectivelyKilled: true, readable: false }; }
  if (kill.effectivelyKilled === true || kill.readable === false) {
    esito.motivo = `kill-switch ${kill.readable === false ? 'NON LEGGIBILE' : 'ATTIVO'}: non si vende — il KILL sta davanti a tutto`;
    annuncia('error', `⚠ R10 · chiusura di emergenza SOSPESA: ${esito.motivo}`);
    scrivi({ tipo: 'chiusura-emergenza', esito: 'sospesa-per-kill', motivo: esito.motivo,
      daVendere: ric.daVendere.length, daFondere: esito.daFondere, lasciate: esito.lasciate });
    return esito;   // ⚠ la richiesta NON si marca eseguita: si riprova quando il KILL cade
  }

  annuncia('error', `🔴 R10 · CHIUSURA DI EMERGENZA (${ric.causa}): ${ric.daVendere.length} gambe scoperte da vendere`
    + ` · ${esito.daFondere} coppie da fondere (le fonde auto-close) · ${esito.lasciate} lasciate sotto il minimo`);

  for (const c of ric.daVendere) {
    const riga = (leggiBoardReward() || []).find((r) => String(r.conditionId || '').toLowerCase() === String(c.conditionId || '').toLowerCase());
    const book = riga && String(riga.tokenId) === c.asset ? 'yes' : 'no';
    // ⚠ LO STESSO prezzo del presidio, dalla STESSA funzione: due idee di «quanto sotto il bid si
    // vende» che divergono sarebbero il reperto D1 su un'azione che tocca capitale reale.
    const { prezzo, valoreUsd, ricavoUsd, motivo: motivoNo } = prezzoUscitaAttraversata(c, riga);
    if (motivoNo) {
      esito.vendute.push({ ...c, chiusa: false, prezzo, motivo: motivoNo });
      scrivi({ tipo: 'chiusura-emergenza', esito: 'non-venduta', marketId: c.conditionId, asset: c.asset,
        size: c.size, prezzo, valoreUsd, ricavoUsd, motivo: motivoNo });
      continue;
    }
    let r = null;
    try {
      r = await (deps.piazza || placeManualOrder)({
        marketId: c.conditionId, book, side: 'SELL', price: prezzo, size: c.size,
        chiudePosizione: true, attraversaApposta: true, allowOutOfBand: true,
      }, 'chiusura-emergenza');
    } catch (e) { r = { ok: false, reason: e && e.message ? e.message : String(e) }; }
    const ok = !!(r && r.ok);
    esito.vendute.push({ ...c, prezzo, chiusa: ok, error: ok ? null : String((r && r.reason) || 'ignoto').slice(0, 160) });
    annuncia(ok ? 'log' : 'error', `R10 · ${String(c.conditionId).slice(0, 12)}… ${c.size} share a ${(prezzo * 100).toFixed(1)}c`
      + (ok ? ' — venduta' : ` — ⚠ FALLITA: ${String((r && r.reason) || '').slice(0, 90)}`));
    scrivi({ tipo: 'chiusura-emergenza', esito: ok ? 'venduta' : 'vendita-fallita',
      marketId: c.conditionId, asset: c.asset, size: c.size, prezzo, valoreUsd, ricavoUsd,
      causa: ric.causa, error: ok ? null : String((r && r.reason) || '').slice(0, 200) });
  }

  // ⚠ SI MARCA ESEGUITA ANCHE SE QUALCHE VENDITA E' FALLITA, e va detto: il presidio dei 60 minuti e
  // la scala d'uscita restano dietro a raccogliere quello che non e' passato. Ritentare all'infinito
  // da qui sarebbe il difetto delle 799 ricostruzioni del giro di prova del 16 agosto: la frequenza
  // del ciclo diventerebbe la frequenza dell'azione.
  const falliteN = esito.vendute.filter((x) => x.chiusa !== true).length;
  try {
    atomicWriteJson(file, { ...ric, eseguita: true, eseguitaAt: Date.now(),
      eseguitaAtIso: new Date().toISOString(),
      venduteOk: esito.vendute.length - falliteN, venduteFallite: falliteN });
  } catch (e) { annuncia('log', `R10 · richiesta NON marcata eseguita: ${e.message}`); }

  scrivi({ tipo: 'chiusura-emergenza', esito: 'completata', causa: ric.causa,
    venduteOk: esito.vendute.length - falliteN, venduteFallite: falliteN,
    daFondere: esito.daFondere, lasciate: esito.lasciate,
    esposizioneDirezionaleUsd: ric.esposizioneDirezionaleUsd ?? null, bloccataUsd: ric.bloccataUsd ?? null,
    nota: 'le coppie complete le fonde auto-close (unico percorso verso il relayer); le gambe sotto il'
      + ' minimo restano fino alla risoluzione, per R10' });
  return esito;
}

async function presidioPosizioniVecchie(deps = {}) {
  const esito = { chiuse: [], tenute: 0, motivo: null };
  let ancore = {};
  try { ancore = JSON.parse(require('fs').readFileSync(PRESIDIO_FILE, 'utf8')).ancore || {}; } catch { ancore = {}; }
  let pos = null;
  try {
    const snap = (deps.leggiPosizioni || readVenuePositions)();
    if (snap && snap.readable === true) pos = (snap.positions || []).map((x) => ({
      asset: String(x.tokenId || x.asset || ''), conditionId: String(x.conditionId || ''),
      size: Number(x.size), avgPrice: Number(x.avgPrice), curPrice: Number(x.curPrice) }));
  } catch { pos = null; }

  const minPerMercato = (() => {
    try {
      const board = leggiBoardReward() || [];
      const m = {};
      for (const r of board) { const c = String(r.conditionId || '').toLowerCase(); if (c) m[c] = Number(r.rewardsMinSize); }
      return m;
    } catch { return {}; }
  })();

  const v = PRESIDIO.valuta({ posizioni: pos, ancore, ora: Date.now(), minSizePerMercato: minPerMercato });
  esito.tenute = v.tenute.length;
  esito.motivo = v.motivo;
  // Le ancore si salvano SEMPRE (tranne quando la lettura e' fallita: li' `valuta` le restituisce
  // invariate), o una posizione vecchia si ringiovanirebbe a ogni giro.
  try {
    const fs_ = require('fs'); const tmp = `${PRESIDIO_FILE}.tmp`;
    fs_.writeFileSync(tmp, JSON.stringify({ aggiornatoAl: new Date().toISOString(), ancore: v.ancore }, null, 1));
    fs_.renameSync(tmp, PRESIDIO_FILE);
  } catch { /* un'ancora non salvata concede un giro in piu', non ne toglie */ }

  for (const c of v.daChiudere) {
    const riga = (leggiBoardReward() || []).find((r) => String(r.conditionId || '').toLowerCase() === c.conditionId);
    const book = riga && String(riga.tokenId) === c.asset ? 'yes' : 'no';
    const { prezzo, valoreUsd, ricavoUsd, motivo: motivoNo } = prezzoUscitaAttraversata(c, riga);
    if (motivoNo) {
      esito.chiuse.push({ ...c, chiusa: false, prezzo, motivo: motivoNo });
      if (prezzo !== null) {
        scrivi({ tipo: 'presidio-posizioni-vecchie', esito: 'rinunciata-ricavo-nullo',
          marketId: c.conditionId, asset: c.asset, size: c.size, etaMin: c.etaMin, prezzo,
          sottoMinimo: c.sottoMinimo === true, valoreUsd, ricavoUsd });
      }
      continue;
    }
    let r = null;
    try {
      r = await (deps.piazza || placeManualOrder)({
        marketId: c.conditionId, book, side: 'SELL', price: prezzo, size: c.size,
        chiudePosizione: true, attraversaApposta: true, allowOutOfBand: true,
      }, 'presidio-posizioni-vecchie');
    } catch (e) { r = { ok: false, reason: e && e.message ? e.message : String(e) }; }
    esito.chiuse.push({ ...c, prezzo, chiusa: !!(r && r.ok), error: (r && r.ok) ? null : String((r && r.reason) || 'ignoto').slice(0, 160) });
    annuncia('log', `⚠ PRESIDIO (ULTIMA RETE — la scala d'uscita NON ha chiuso): ${c.conditionId.slice(0, 12)}…`
      + ` ${c.size} share a ${(prezzo * 100).toFixed(1)}c`
      + ` — ${c.motivo}${r && r.ok ? '' : ' ⚠ FALLITA: ' + String((r && r.reason) || '').slice(0, 90)}`);
    // ⚠ SE INTERVIENE QUESTO PRESIDIO, LA SCALA D'USCITA NON HA FUNZIONATO — e va detto qui, non
    // dedotto dopo. Requisito dell'operatore, 17 agosto 2026: «il presidio dei 60 minuti resta come
    // ultima rete, ma non deve essere quello che chiude: se e' lui a intervenire, vuol dire che la
    // scala non ha funzionato, e voglio saperlo».
    // La scala ha gradini a 30, 60 e 240 minuti e una posizione che arriva fin qui li ha attraversati
    // tutti senza chiudere: `scalaNonHaChiuso: true` rende il fatto CERCABILE nel giornale invece che
    // ricostruibile confrontando due registri.
    scrivi({ tipo: 'presidio-posizioni-vecchie', esito: (r && r.ok) ? 'chiusa' : 'chiusura-fallita',
      marketId: c.conditionId, asset: c.asset, size: c.size, etaMin: c.etaMin, prezzo,
      // R6: un'uscita sotto il minimo resta distinguibile da una normale, e la rinuncia si misura.
      sottoMinimo: c.sottoMinimo === true, minSizeMercato: c.minSizeMercato ?? null,
      valoreUsd, ricavoUsd, rinunciaUsd: valoreUsd !== null ? +(valoreUsd - ricavoUsd).toFixed(4) : null,
      motivo: c.motivo, scalaNonHaChiuso: true,
      nota: 'ULTIMA RETE: questa posizione ha attraversato tutti i gradini della scala d\'uscita senza'
        + ' chiudersi. L\'intervento del presidio e\' di per se\' un\'anomalia da guardare.',
      error: (r && r.ok) ? null : String((r && r.reason) || '').slice(0, 200) });
  }
  return esito;
}

async function selezionaMercati(deps = {}) {
  const stato = deps.leggiStatoSelezione ? deps.leggiStatoSelezione() : SELS.leggiStato();
  if (!stato.leggibile) {
    annuncia('log', `selezione automatica: stato illeggibile (${stato.error}) — nessuna decisione, e nessun mercato tolto`);
    return { attiva: false, applicata: false, motivo: 'stato illeggibile' };
  }
  if (stato.attiva !== true) return { attiva: false, applicata: false, motivo: 'selezione automatica spenta' };

  const board = deps.leggiBoard ? deps.leggiBoard() : leggiBoardReward();
  const posizioni = deps.leggiPosizioni ? deps.leggiPosizioni() : posizioniPerSelezione();
  const quarantena = (() => { try { return Object.keys(leggiQuarantena() || {}); } catch { return []; } })();

  // ⚠ IL TETTO D'ORIZZONTE ARRIVA DA `horizon.js`, NON DA UNA COSTANTE RICOPIATA (15 agosto 2026).
  // `selezione-mercati` e' puro per costruzione (zero `require`, e un test lo pretende), quindi il
  // valore glielo passa il cablaggio. Senza, la selezione potrebbe occupare uno slot con un mercato
  // che l'allocatore rifiuta per orizzonte: uno slot vivo che non ricevera' mai un ordine.
  const orizzonteMassimoOre = (() => {
    // ⚠ IL NOME ERA SBAGLIATO, E FALLIVA IN SILENZIO — corretto il 16 agosto 2026. Qui c'era
    // `H.MAX_HORIZON_DAYS`, che in `horizon.js` NON ESISTE: gli export sono `MAX_HORIZON_DAYS_DEFAULT`
    // e `maxHorizonDays()`. `Number(undefined) * 24` fa NaN, `NaN || null` fa `null`, e `null` qui
    // significa «nessun tetto d'orizzonte»: la selezione poteva occupare uno slot con un mercato che
    // l'allocatore non finanziera' mai. Quinta occorrenza della classe «dep non cablata ⇒ valore di
    // difetto che nessuno ha chiesto» (§5.3), e come le altre non si vedeva da fuori.
    try {
      const H = require('../lib/rewards/horizon');
      const g = typeof H.maxHorizonDays === 'function' ? Number(H.maxHorizonDays()) : Number(H.MAX_HORIZON_DAYS_DEFAULT);
      return Number.isFinite(g) && g > 0 ? g * 24 : null;
    } catch { return null; }   // non leggibile ⇒ nessun tetto, cioe' il comportamento di prima
  })();
  // I due ingressi della riclassificazione. Entrambi possono mancare, e mancando disattivano SOLO lo
  // spodestamento: la selezione continua a riempire gli slot liberi come ha sempre fatto.
  const nettoPerMercato = deps.nettoPerMercato !== undefined
    ? deps.nettoPerMercato
    : await nettiDeiCandidati(board, orizzonteMassimoOre);
  const conOrdiniVivi = deps.conOrdiniVivi !== undefined
    ? deps.conOrdiniVivi
    : await mercatiConOrdiniVivi(deps);

  // ⚠ R1 · QUANTI MERCATI LO DECIDE L'OPERATORE, E IL NUMERO VIVE NEL PROCESSO. Prima `max` non
  // veniva passato affatto, quindi valeva la costante di sorgente: non scrivibile senza toccare il
  // codice, e non leggibile da `/proc/<pid>/environ`. Adesso viene da `MAKER_MERCATI_CONTEMPORANEI`,
  // dichiarata in `agents/ecosystem.config.js` su QUESTO processo — l'unico che esegue la selezione.
  // La composizione per scaglione la deriva `quotaScaglioni(max)` dentro `decidiSelezione`: un numero
  // solo, non due.
  const quanti = (deps.quanti !== undefined ? deps.quanti : QUANTI.quantiMercati());
  const d = SELM.decidiSelezione({
    board, stato: stato.stato, posizioni, ora: Date.now(), escludi: quarantena, orizzonteMassimoOre,
    nettoPerMercato, conOrdiniVivi, max: quanti.quanti,
  });
  if (!d.ok) {
    annuncia('log', `selezione automatica: nessuna decisione — ${d.motivo}`);
    scrivi({ tipo: 'selezione-mercati', esito: 'astenuta', motivo: d.motivo, occupati: d.occupati });
    return { attiva: true, applicata: false, motivo: d.motivo };
  }

  // ── LE SCRITTURE. Prima chi esce, poi chi entra: se le due si invertissero, un giro in cui uno esce
  // e uno entra passerebbe per un istante da 3 mercati abilitati, e un piazzamento concorrente
  // potrebbe infilarsi proprio li'.
  const usciti = [];
  for (const u of d.uscenti) {
    const r = await rilasciaDallaSelezione({ marketId: u.id, motivo: u.motivo });
    usciti.push({ ...u, scritto: !!(r && r.ok), error: (r && r.error) || null });
  }

  // ── GLI SPODESTATI VANNO RILASCIATI ANCHE LORO, E NON PASSANO DA `uscenti` ─────────────────────
  // Uno spodestato non e' «uscito per un vincolo violato»: e' stato sostituito da un candidato
  // migliore, quindi vive in `d.spodestati` e in `d.liberati`, non in `d.uscenti`. Senza questo ciclo
  // sparirebbe dallo STATO della selezione restando ABILITATO al riprezzo — un mercato che nessuno
  // considera piu' suo e su cui il bot continua a lavorare. E' la stessa forma di §5-bis p.44.
  // ⚠ `rilasciaDallaSelezione` tocca solo `setAutoReprice`: spegne l'INGRESSO, non l'uscita. Un
  // mercato spodestato non ha ordini vivi (condizione ③) ne' gambe in attesa (condizione ④), ma se ne
  // acquisisse fra questo istante e il prossimo giro, la regola di copertura di §4.8 lo gestisce lo stesso.
  const spodestati = [];
  for (const s of (d.spodestati || [])) {
    const r = await rilasciaDallaSelezione({ marketId: s.id, motivo: 'spodestato' });
    spodestati.push({ ...s, scritto: !!(r && r.ok), error: (r && r.error) || null });
  }

  const entrati = [];
  for (const e of d.entranti) {
    const abilita = ({ marketId }) => setAutoReprice({ scope: 'market', marketId, enabled: true,
      by: 'riallocatore · selezione automatica',
      reason: `scelto dalla selezione automatica: minSize ${e.minSize} · ${e.oreAllaScadenza != null ? e.oreAllaScadenza.toFixed(1) + ' h alla risoluzione' : 'scadenza non dichiarata'} · stima ${e.punteggio.toFixed(3)} (${e.fontePunteggio})` });
    const prendiInGestione = ({ marketId, manual }) => setManualMode({ marketId, manual,
      by: 'riallocatore · selezione automatica', reason: 'mercato scelto dalla selezione automatica' });
    const accendiUscita = ({ marketId, enabled }) => setAutoClose({ scope: 'market', marketId, enabled,
      by: 'riallocatore · selezione automatica', reason: 'l uscita automatica e pronta PRIMA che il mercato abbia ordini' });
    const registraCatalogo = ({ marketId }) => copiaRegoleNelRipiego({ marketId }, 'riallocatore · selezione automatica');
    let p;
    try { p = await preparaMercatoNuovo(e.id, abilita, prendiInGestione, accendiUscita, registraCatalogo); }
    catch (err) { p = { ok: false, motivo: err && err.message ? err.message : String(err) }; }
    entrati.push({ ...e, riga: undefined, aperto: p.ok === true, motivo: p.ok === true ? null : p.motivo });
  }

  // ⚠ SI SALVA SOLO CIO' CHE E' STATO SCRITTO DAVVERO. Un mercato che `preparaMercatoNuovo` ha
  // rifiutato non e' un mercato che il bot ha preso: registrarlo nello stato gli farebbe occupare uno
  // slot per sempre senza mai ricevere un ordine — capitale fermo prodotto dalla contabilita'.
  const statoDaSalvare = { ...d.statoNuovo, selezionati: { ...d.statoNuovo.selezionati } };
  for (const e of entrati) if (!e.aperto) delete statoDaSalvare.selezionati[e.id];

  const salvato = SELS.scriviStato(statoDaSalvare, { by: 'agent41 · selezione automatica',
    reason: `${entrati.filter((x) => x.aperto).length} entrati, ${usciti.length} usciti, ${d.liberati.length} slot liberati` });

  // ⚠ Il denominatore e' il numero VERO di questo processo, non la costante: se il riassunto dicesse
  // 3 mentre l'operatore ha chiesto 1, sarebbe una riga che descrive un bot diverso da quello vivo.
  const riassunto = `selezione automatica: ${d.occupati}/${quanti.quanti} slot attivi`
    + (d.inGestione.length ? ` (+${d.inGestione.length} in gestione, fuori dal conteggio)` : '')
    + ` · ${d.ammissibili} mercati ammissibili su ${d.valutati} valutati`
    + (spodestati.length ? ` · SPODESTATI ${spodestati.map((x) => `${x.id.slice(0, 10)}… (netto ${x.netto.toFixed(3)}/g → ${x.nettoNuovo.toFixed(3)}/g)`).join(', ')}` : '')
    + (entrati.length ? ` · ENTRATI ${entrati.map((x) => `${x.id.slice(0, 10)}…${x.aperto ? '' : ' (RIFIUTATO: ' + x.motivo + ')'}`).join(', ')}` : '')
    // ROTAZIONE: il fill che libera lo slot va detto, o «3 slot e 5 mercati» sembra un errore.
    + (d.entratiInGestione.length ? ` · IN GESTIONE per un fill ${d.entratiInGestione.map((x) => x.id.slice(0, 10) + '…').join(', ')}` : '')
    + (usciti.length ? ` · USCITI ${usciti.map((x) => `${x.id.slice(0, 10)}… (${x.motivo})`).join(', ')}` : '')
    + (d.liberati.length ? ` · SLOT LIBERATI ${d.liberati.map((x) => `${x.id.slice(0, 10)}… (${x.motivo})`).join(', ')}` : '');
  if (entrati.length || usciti.length || d.liberati.length || d.entratiInGestione.length) annuncia('log', riassunto);

  const rec = {
    tipo: 'selezione-mercati', esito: 'applicata',
    occupati: d.occupati, ammissibili: d.ammissibili, valutati: d.valutati,
    tenuti: d.tenuti.map((x) => x.id), entrati, usciti, liberati: d.liberati,
    entratiInGestione: d.entratiInGestione, inGestione: d.inGestione,
    // Lo spodestamento e' l'azione nuova del 16 agosto 2026: va nel giornale con i due netti a
    // confronto, o fra un mese non si potra' dire se la riclassificazione ha migliorato o solo agitato.
    spodestati,
    nettiIniettati: nettoPerMercato ? Object.keys(nettoPerMercato).length : null,
    ordiniViviLeggibili: conOrdiniVivi ? conOrdiniVivi.leggibile === true : null,
    statoSalvato: salvato.ok, statoErrore: salvato.ok ? null : salvato.error,
  };
  scrivi(rec);
  try {
    SELS.giornale({ op: 'giro', ...rec });
    appendMakerAudit({ ts: Date.now(), venue: 'polymarket', source: 'selezione-automatica',
      op: 'selezione-mercati', outcome: 'applicata',
      response: { occupati: d.occupati, entrati: entrati.map((x) => x.id), usciti: usciti.map((x) => x.id) } });
  } catch { /* un giornale non scritto non annulla una decisione gia' presa */ }

  return { attiva: true, applicata: true, ...rec };
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

/**
 * IL NOZIONALE CHE IL VENUE HA DAVVERO ACCETTATO in un insieme di risultati di piazzamento.
 *
 * `refused` e `skipped` non hanno messo niente sul book e non contano. Una riga senza `notionalUsd`
 * leggibile vale ZERO e non si stima dal piano: sottostimare qui significa dichiarare meno capitale al
 * lavoro di quanto ce n'è, cioè far scattare una difesa in più — il verso sicuro. Sovrastimare
 * significa credersi a posto mentre il capitale è fermo, che è il difetto del 13 agosto.
 */
function nozionalePiazzato(risultati) {
  return (risultati || []).reduce((tot, x) => {
    if (!x || x.status === 'refused' || x.status === 'skipped') return tot;
    const n = Number(x.notionalUsd);
    return Number.isFinite(n) && n > 0 ? tot + n : tot;
  }, 0);
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

  // ── LE SOGLIE DI CHI RICEVE, PRIMA DI PROPORRE ────────────────────────────────────────────────
  // Il pianificatore non conosce il tetto per ORDINE: alloca fino al tetto per MERCATO, e a mid estremo
  // la gamba cara sfonda. Misurato sulle 24 ore: **84 gambe su 129 perse (65%) muoiono di
  // `coppia-non-atomica`**, cioe' coppie abbandonate intere perche' UNA gamba sfondava — $1.276 di
  // nozionale che non e' mai arrivato sul book. Qui le righe vengono ADATTATE: il capitale puo' solo
  // SCENDERE, quindi nessun tetto e' toccato — si rispetta quello che c'e' gia' invece di scoprirlo al
  // gate e buttare via anche la gamba che sarebbe passata.
  //
  // ⚠ VA APPLICATA A OGNI FONTE DI RIGHE, e la prima stesura non lo faceva: adattava il piano SALVATO e
  // poi la ricostruzione sovrascriveva `righeCandidate` con righe mai passate di qui. Misurato dopo il
  // riavvio delle 07:17: `coerenza: undefined` e sei `coppia-non-atomica` allo stesso giro, cioe' la
  // correzione era INERTE. Adesso e' una funzione, e la chiamano tutti e due i percorsi.
  const adattaAlleSoglie = (righe, dove) => {
    const a = COER.adattaRighe({
      righe: righe || [],
      soglieDi: (r) => ({
        capPerMercatoUsd: capMercato,
        tettoOrdineUsd: CO.liveMinOrderCapUsd(capitaleTotale),
        pavimentoRigaUsd: TRIG.pavimentoDiRiga(r).usd,
      }),
    });
    if (a.adattate || a.scartate.length) {
      referto.coerenza = { fonte: dove, adattate: a.adattate, scartate: a.scartate.length,
        divergenze: a.divergenze.slice(0, 6), scartateDettaglio: a.scartate.slice(0, 6) };
      annuncia('log', `mini-ciclo: coerenza soglie (${dove}) — ${a.adattate} riga/he con capitale RIDOTTO per rispettare il tetto per ordine`
        + `, ${a.scartate.length} scartata/e perche' nessun capitale soddisfa insieme tutte le soglie`);
    }
    return a.righe;
  };

  // ══ LE RIGHE AMMESSE: SELEZIONE **E POI** SOGLIE, IN UN PUNTO SOLO ═══════════════════════════════
  // ⚠ IL DIFETTO CHE QUESTA FUNZIONE CHIUDE (17 agosto 2026, deciso dall'operatore). La selezione
  // restringe il piano dentro `calcolaPianoFuoriProcesso` (:520), che e' l'unico punto da cui il piano
  // nasce — ma il mini-ciclo NON ricalcola il piano nel caso comune: prende le righe dal piano SALVATO
  // se e' fresco, e `PIANO_FRESCO_MAX_MS` vale SESSANTA MINUTI. Misurato sul sorgente: nel corpo di
  // `miniCiclo` (righe 1845-2450) le occorrenze di `selezion`/`idsAttivi` erano ZERO. Quindi un mercato
  // che uscisse dalla selezione — ruotato, scaduto, spodestato — restava piazzabile per un'ora dal piano
  // salvato. E' la forma esatta del quarto mercato comparso in allowlist il 16 agosto.
  //
  // Si e' scelto di RIFARE L'INTERSEZIONE a ogni giro invece di invalidare il piano: invalidarlo
  // costringerebbe a un ricalcolo da 13 secondi a ogni cambio di selezione, e un piano ancora buono per
  // i mercati che restano verrebbe buttato per un mercato che e' uscito.
  //
  // ⚠ E STA INSIEME ALL'ADATTAMENTO ALLE SOGLIE PER UNA RAGIONE PRECISA: `adattaAlleSoglie` esiste
  // perche' la prima stesura lo applicava al piano salvato e NON alla ricostruzione, che poi
  // sovrascriveva le righe (§5 p.130 — la correzione era INERTE). Due filtri che devono valere su
  // entrambe le fonti, tenuti in due funzioni, sono due occasioni di dimenticarne una: qui la fonte
  // chiama UNA funzione e le prende entrambe.
  const righeAmmesse = (righe, dove) => {
    const sel = selezioneAttiva();
    let dopoSelezione = righe || [];
    if (sel.attiva) {
      // `idsAttivi`, NON `ids`: un mercato in gestione sta chiudendo la sua posizione, e aprirci sopra
      // rifarebbe l'esposizione che la scala d'uscita sta smontando. E' la stessa scelta di :520.
      const scelti = new Set(sel.idsAttivi.map((x) => String(x).trim().toLowerCase()));
      const prima = dopoSelezione.length;
      dopoSelezione = dopoSelezione.filter((r) => scelti.has(String(r.marketId || '').trim().toLowerCase()));
      if (prima !== dopoSelezione.length) {
        referto.fuoriSelezione = { fonte: dove, prima, dopo: dopoSelezione.length,
          tolti: prima - dopoSelezione.length, sceltiOra: [...scelti].length };
        annuncia('log', `mini-ciclo: ${prima - dopoSelezione.length} riga/he del ${dove} TOLTE perche' fuori dalla selezione`
          + ` (${[...scelti].length} mercati attivi adesso) — il piano salvato puo' avere fino a ${PIANO_FRESCO_MAX_MS / 60000} minuti`);
      }
    }
    return adattaAlleSoglie(dopoSelezione, dove);
  };

  let righeCandidate = [];
  let motivoPassate = null;
  const piano = leggiPiano();
  const etaPianoMs = piano.ok && piano.at ? Date.now() - Date.parse(piano.at) : null;
  const pianoFresco = piano.ok && Number.isFinite(etaPianoMs) && etaPianoMs <= PIANO_FRESCO_MAX_MS;
  let giro = { scelte: [], motivoStop: piano.ok ? null : (piano.motivo || 'nessun piano salvato') };
  let fonte = null;
  if (pianoFresco) {
    righeCandidate = righeAmmesse(piano.righe, 'piano salvato');
    giro = TRIG.pianificaGiro({ ...comuni, righe: righeCandidate, disponibileUsd: spendibileUsd });
    fonte = `piano salvato (${Math.round(etaPianoMs / 60000)} min)`;
  }

  // ── QUANTE RIGHE DEL PIANO SONO ANCORA SPENDIBILI ─────────────────────────────────────────────
  // Il numero che il 13 agosto 2026 non esisteva: il piano ne DICHIARAVA 17 e le spendibili erano ZERO.

  const utiliOra = TRIG.contaRigheUtili({
    righe: righeCandidate, notionalePerMercato: perMercato,
    capPerMercatoUsd: capMercato, disponibileUsd: spendibileUsd,
  });
  referto.righeUtili = utiliOra;
  referto.sogliaRigheUtili = TRIG.SOGLIA_RIGHE_UTILI;

  let pianoRicalcolato = null;
  // ── IL PIANO NON PUÒ SVUOTARSI, E NON SI ASPETTA IL CICLO DA SEI ORE ──────────────────────────
  // Fino al 13 agosto si ricalcolava SOLO a zero scelte, cioè quando il danno era già completo. Ora
  // si ricalcola anche quando le righe ancora spendibili scendono sotto i posti che un giro ha
  // (`SOGLIA_RIGHE_UTILI`): sotto quella soglia il giro finisce il piano prima di finire i propri
  // posti, e da lì ogni giro successivo ne trova meno. Si anticipa il consumo invece di subirlo.
  //
  // ⚠ LA RICOSTRUZIONE PASSA DALLA STESSA PORTA DEL CICLO PESANTE: `pianoLeggero` chiama
  // `calcolaPianoFuoriProcesso`, cioè lo STESSO `planFromCollection` con `horizonFilter`, il filtro di
  // profondità, quello di quotabilità, il pavimento premiante e il tetto per mercato. Cambia solo la
  // finestra di storico (6 h invece di 48). Nessun mercato salta un controllo: se saltasse, questa
  // riga sarebbe un modo di piazzare su ciò che il ciclo pesante rifiuterebbe.
  const sottoSoglia = giro.scelte.length > 0 && utiliOra < TRIG.SOGLIA_RIGHE_UTILI;
  if (!giro.scelte.length || sottoSoglia) {
    const perche = !piano.ok ? (piano.motivo || 'nessun piano salvato')
      : !pianoFresco ? `il piano salvato ha ${etaPianoMs == null ? 'eta ignota' : Math.round(etaPianoMs / 60000) + ' minuti'} (limite ${PIANO_FRESCO_MAX_MS / 60000})`
        : sottoSoglia ? `il piano si sta consumando: ${utiliOra} righe ancora spendibili sotto la soglia di ${TRIG.SOGLIA_RIGHE_UTILI} (i posti di un giro)`
          : `il piano salvato non ha righe utilizzabili adesso (${giro.motivoStop})`;
    annuncia('log', `mini-ciclo: ricalcolo leggero — ${perche}`);
    // ⚠ UN RICALCOLO PREVENTIVO NON DEVE POTER PEGGIORARE IL GIRO. Quando si entra qui con delle
    // scelte già in mano (il caso `sottoSoglia`), un ricalcolo fallito o più povero deve lasciare le
    // scelte di prima: altrimenti la correzione che esiste per non lasciare fermo il capitale
    // diventerebbe il modo di lasciarlo fermo. Si tiene il migliore dei due, e si dichiara quale.
    const giroPrima = giro;
    const fontePrima = fonte;
    const righePrima = righeCandidate;
    const tieniIlPrecedente = (motivo) => {
      if (!giroPrima.scelte.length) return false;
      giro = giroPrima; fonte = fontePrima; righeCandidate = righePrima;
      referto.ricostruzione = { tentata: true, adottata: false, motivo };
      annuncia('log', `mini-ciclo: ricostruzione NON adottata — ${motivo}; si prosegue col piano di prima (${giroPrima.scelte.length} scelte)`);
      return true;
    };
    const tRic = Date.now();
    try {
      pianoRicalcolato = await ricalcola({ capital: decisione.saldoUsd, maxPerMarketUsd: capMercato });
    } catch (e) {
      if (!tieniIlPrecedente(`il ricalcolo leggero e' fallito: ${e.message}`)) {
        return { ...referto, esito: 'nessuna-azione', utilizzo: utilPrima,
          motivo: `${perche}, e il ricalcolo leggero e' fallito: ${e.message}` };
      }
      pianoRicalcolato = null;
    }
    if (pianoRicalcolato !== null) {
      const righeFresche = (pianoRicalcolato && pianoRicalcolato.rows) || [];
      referto.ricalcolo = { motivo: perche, durataMs: Date.now() - tRic, righe: righeFresche.length,
        finestraOre: FINESTRA_LEGGERA_ORE };
      if (!righeFresche.length) {
        if (!tieniIlPrecedente('il ricalcolo leggero non ha trovato nessun mercato ammissibile adesso')) {
          return { ...referto, esito: 'nessuna-azione', utilizzo: utilPrima,
            motivo: `${perche} — e il ricalcolo leggero non ha trovato nessun mercato ammissibile adesso:`
              + ' il capitale resta liquido perche' + ' non c\'e\' dove metterlo, non perche\' non si e\' guardato' };
        }
      } else {
        const fresche = righeAmmesse(righeFresche, 'ricostruzione');
        const giroFresco = TRIG.pianificaGiro({ ...comuni, righe: fresche, disponibileUsd: spendibileUsd });
        if (giroFresco.scelte.length >= giroPrima.scelte.length) {
          righeCandidate = fresche;
          giro = giroFresco;
          fonte = `ricostruzione del piano (${FINESTRA_LEGGERA_ORE}h, ${Date.now() - tRic}ms)`;
          referto.ricostruzione = { tentata: true, adottata: true, righe: righeFresche.length,
            righeUtiliPrima: utiliOra, scelteePrima: giroPrima.scelte.length, scelte: giroFresco.scelte.length };
        } else {
          tieniIlPrecedente(`la ricostruzione produce ${giroFresco.scelte.length} scelte contro ${giroPrima.scelte.length}`);
        }
      }
    }
  }

  // Anche un giro che non trova niente da fare HA girato: non timbrarlo farebbe salire la scala di
  // sblocco su un bot sano che ha semplicemente il piano gia' pieno.
  ultimoCicloOk = Date.now();
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
  passate.push({ n: 1, mercati: mercati.map((m) => m.marketId), piazzati: esito && esito.placed, rifiutati: esito && esito.refused, saltati: esito && esito.skipped, nozionaleUsd: +nozionalePiazzato(esito && esito.results).toFixed(2) });

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
    passate.push({ n: passate.length + 1, mercati: m2.map((m) => m.marketId), piazzati: esito && esito.placed, rifiutati: esito && esito.refused, saltati: esito && esito.skipped, esclusi: bloccati, nozionaleUsd: +nozionalePiazzato(esito && esito.results).toFixed(2) });
    righeOrdine = r2; mercati = m2;
  }
  if (esito && esito.placed === 0 && passate.length >= TRIG.MAX_MERCATI_PER_GIRO) {
    motivoPassate = `tetto di ${TRIG.MAX_MERCATI_PER_GIRO} passate raggiunto: gli altri mercati si provano al giro dopo`;
  }

  // 6-ter · I RIFIUTI RIPETUTI. La stessa richiesta rifiutata per la stessa ragione N volte di fila
  //         non è sfortuna: è un blocco strutturale. Il 13 agosto sono state 114. Qui si contano, si
  //         classificano e si trasforma la classe in una REAZIONE — che per le famiglie di rischio è
  //         «cambia mercato e dichiara», mai «aggira».
  try {
    const reg = SBLOCCO.registraEsiti({ stato: statoRifiuti, esiti: (esito && esito.results) || [] });
    statoRifiuti = reg.stato;
    if (reg.blocchi.length) {
      const rz = SBLOCCO.reazione(reg.blocchi);
      azioniSuggerite = rz.azioni;
      referto.rifiutiRipetuti = { blocchi: reg.blocchi.length, azioni: rz.azioni,
        nonAgibili: rz.nonAgibili.slice(0, 6), soloRischio: rz.soloRischio };
      const capofila = reg.blocchi[0];
      annuncia('error', `🔁 RIFIUTO RIPETUTO — ${capofila.gate} × ${capofila.n} su ${String(capofila.marketId).slice(0, 12)}`
        + ` (classe ${capofila.classe}) ⇒ ${rz.azioni.length ? 'via alternativa: ' + rz.azioni.join(', ') : 'NESSUNA azione: ' + capofila.perche}`);
      if (rz.soloRischio) {
        annuncia('log', 'i rifiuti ripetuti vengono TUTTI da regole di rischio: il bot non agisce e lo dichiara — '
          + rz.nonAgibili.map((x) => `${String(x.marketId).slice(0, 10)} ${x.gate}`).join(' · '));
      }
      appendMakerAudit({ ts: Date.now(), venue: 'polymarket', source: 'realloc-scheduler', op: 'rifiuto-ripetuto',
        reason: 'rifiuti-identici-consecutivi', decision: `${capofila.gate} ripetuto ${capofila.n} volte`,
        outcome: rz.soloRischio ? 'nessuna-azione-regola-di-rischio' : 'via-alternativa',
        requested: { soglia: SBLOCCO.N_RIPETIZIONI }, observed: { blocchi: reg.blocchi.slice(0, 6), azioni: rz.azioni } });
    }
  } catch (e) { annuncia('log', `registro dei rifiuti ripetuti non aggiornato: ${e.message}`); }

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

  // 8 · L'UTILIZZO DOPO, con il capitale che questo giro ha DAVVERO impegnato.
  //
  // ⚠ QUI C'ERA `giro.allocatoUsd`, cioè il PIANO del giro, e non quello che il venue ha accettato.
  // Misurato il 13 agosto 2026 alle 06:47:52: il giro aveva allocato **$284**, ma delle 17 gambe ne
  // sono passate **8** — nozionale realmente piazzato **$127,79**. La riga «CAPITALE AL LAVORO»
  // dichiarava di conseguenza **$578,40 = 87%** contro un valore onesto di ~$422 = ~63%, e la misura
  // vera del giro dopo diceva 44,3%. Cioè il numero con cui si giudica se il bot sta lavorando era
  // **l'intenzione, non il fatto**, e sbagliava sempre nella direzione che rassicura.
  //
  // Adesso si sommano i nozionali delle sole gambe che il venue non ha rifiutato né saltato. Il campo
  // `notionalUsd` è quello che la corsia di piazzamento mette su ogni riga di risultato, quindi è la
  // stessa grandezza di `aRiposo` — non una seconda stima. Una riga senza `notionalUsd` leggibile NON
  // si indovina dal piano: vale zero, cioè si sottostima, che è il verso sicuro per un numero che
  // decide se il capitale è al lavoro.
  //
  // Resta una STIMA e continua a dichiararsi tale (`utilizzoStimatoDopo`): il venue conferma in modo
  // asincrono e la misura vera torna al giro successivo rileggendo saldo e ordini. Ma è la stima di
  // ciò che è successo, non di ciò che si voleva far succedere.
  // Le passate precedenti hanno piazzato anche loro: `esito` è solo l'ULTIMA. Senza sommarle, un giro
  // che piazza in due passate dichiarerebbe meno di quanto ha fatto — l'errore opposto, ma pur sempre
  // un numero che non descrive la realtà.
  // ── IL BATTITO DEL CICLO ────────────────────────────────────────────────────────────────────────
  // ⚠ `ultimoCicloOk` era inizializzato al riavvio e MAI aggiornato: il contatore cresceva all'infinito
  // e l'autodiagnosi dichiarava «nessun ciclo da N minuti» **mentre il bot piazzava 12 gambe su 14**,
  // salendo la scala di sblocco fino al gradino 5 ogni mezz'ora. Un difetto introdotto stamattina
  // insieme alla difesa che doveva proteggere: la misura c'era e non veniva alimentata.
  // Si timbra QUI, cioe' quando il giro e' arrivato in fondo con delle scelte — non all'inizio, o si
  // timbrerebbe anche un giro che poi esplode.
  ultimoCicloOk = Date.now();
  const impegnatoOra = +(nozionalePiazzato(esito && esito.results)
    + passate.slice(0, -1).reduce((t, p) => t + (Number(p.nozionaleUsd) || 0), 0)).toFixed(2);
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

// ═══ LA SENTINELLA SUL VUOTO ═══════════════════════════════════════════════════════════════════════
// Il presidio che il 13 agosto 2026 non esisteva: zero ordini a riposo per 180 minuti con KILL spento,
// AVVIA acceso e $609,10 liquidi, senza che nessun componente avesse per mestiere accorgersene.
//
// ⚠ NON CONSUMA LA QUOTA DEI RINNOVI. L'unica chiamata che fa è una LETTURA degli ordini aperti, e la
// quota 60/40 conta gli `intent`, cioè gli invii (`lib/safety/usage.js`): una GET non entra nella
// finestra e non toglie un solo posto al 40% riservato ai rinnovi. La ricostruzione che la sentinella
// chiede passa dal mini-ciclo, quindi resta dentro il 60% delle aperture come qualunque altro giro.
//
// ⚠ E NON ALLENTA NIENTE: la sua unica azione è chiedere a `controlloCapitaleFermo` di girare ADESSO
// invece che al prossimo cooldown. Kill, AVVIA/FERMA, freno di prova e tutti i cancelli per ordine
// restano davanti e decidono come sempre.
// ═══ LA SCALA DI SBLOCCO — OGNI DIFESA AGISCE, NESSUNA ALLENTA ═════════════════════════════════════
// Lo stato della scala e delle serie di rifiuto vive nel processo: un riavvio lo azzera, ed è giusto —
// un processo appena partito non ha ancora osservato niente, e ripartire dal gradino 1 dopo un riavvio
// è più prudente che ereditare un gradino alto da una diagnosi che non è più la sua.
let statoScala = null;
let statoRifiuti = {};
let azioniSuggerite = [];
let sottoSogliaDa = null;
let ultimoCicloOk = Date.now();

/**
 * IL MESSAGGIO DEL GRADINO 5, e perché è una funzione invece di un'interpolazione.
 *
 * `writeCollectorPriority` restituisce DUE campi che sembrano intercambiabili e non lo sono:
 * `marketIds` è l'elenco degli id, `mercati` è l'elenco delle VOCI (oggetti con id, motivo, rank…).
 * Il gradino 5 interpolava `mercati` dentro un template, cioè chiedeva a un array di oggetti di
 * descriversi da solo: `[object Object],[object Object],…` per sessanta volte, e il numero che
 * interessava — quanti mercati — non compariva da nessuna parte. Il ciclo normale (riga ~571) usava
 * già `marketIds.length`: era una divergenza fra due letture dello stesso valore di ritorno.
 *
 * Qui si conta, e si conta da `marketIds` come fa l'altro chiamante. Una lettura mancante vale 0 e lo
 * dice: `Number(null) === 0` è il difetto più ricorrente di questo repo (§5.3), quindi lo zero
 * dell'assenza e lo zero misurato NON si scrivono uguali.
 */
function messaggioFeedRiseminato(pr) {
  const ids = pr && Array.isArray(pr.marketIds) ? pr.marketIds : null;
  if (ids === null) return 'corsia calda riseminata: conteggio dei mercati non leggibile';
  return `corsia calda riseminata: ${ids.length} mercati`;
}

/**
 * L'ESECUTORE DEI GRADINI. Ogni voce è un'azione che rimette in sincronia lo STATO del bot con la
 * realtà; **nessuna tocca una regola di rischio** — non alza tetti, non allarga bande, non consente di
 * stare primi sul libro, non salta la chiusura forzata. Il gradino finale non è un'azione: è fermarsi.
 */
async function eseguiGradino(azione) {
  const t0 = Date.now();
  const fatto = (ok, dettaglio) => ({ azione, ok, dettaglio, durataMs: Date.now() - t0 });
  try {
    if (azione === 'ricostruisci-piano') {
      await controlloCapitaleFermo({ forzatoDa: 'sblocco-progressivo' });
      return fatto(true, 'mini-ciclo forzato: il piano viene ricostruito con gli stessi filtri del ciclo pesante');
    }
    if (azione === 'ricarica-configurazione') {
      // I lettori di questo repo leggono già da disco a ogni chiamata («un controllo che ha bisogno di
      // un riavvio non è un controllo»): la cosa utile qui è VERIFICARE che siano leggibili e dirlo,
      // perché una configurazione illeggibile è essa stessa una causa di blocco.
      const rp = readAutoRepriceConfig();
      const tetti = readAllocatedCapitalAll();
      const bot = statoBot();
      return fatto(true, `riprezzo ${rp && rp.readable === true ? 'leggibile' : 'ILLEGGIBILE'}`
        + ` · tetti ${tetti && tetti.readable !== false ? 'leggibili' : 'ILLEGGIBILI'}`
        + ` · interruttore ${bot.enabled ? 'AVVIA' : 'FERMA'}`);
    }
    if (azione === 'riconcilia-esposizione') {
      const { diagnoseExposure } = require('../lib/maker/manual-reset');
      const d = diagnoseExposure({});
      return fatto(true, `esposizione aperta $${Number(d && d.openNotionalUsd || 0).toFixed(2)}`
        + ` · posizioni nel ledger ${(d && d.positions && d.positions.length) || 0}`
        + ' — il ledger si netta contro lo snapshot del venue nella stessa lettura');
    }
    if (azione === 'ripara-precondizioni') {
      const piano = leggiUltimoPiano();
      const ids = piano && piano.ok ? (piano.righe || []).map((r) => r.marketId).filter(Boolean).slice(0, TRIG.MAX_MERCATI_PER_GIRO) : [];
      let n = 0;
      for (const id of ids) {
        try { const r = await preparaMercatoNuovo({ marketId: id }); if (r && r.ok !== false) n += 1; } catch { /* una fallita non ferma le altre */ }
      }
      return fatto(n > 0, `precondizioni riscritte su ${n}/${ids.length} mercati del piano`);
    }
    if (azione === 'risveglia-feed') {
      // Non si riavvia nessun processo: si RISEMINA la corsia calda, che agent34 rilegge da sé. È la
      // stessa scrittura del ciclo normale, quindi non introduce nessun percorso nuovo.
      const piano = leggiUltimoPiano();
      const pr = writeCollectorPriority(piano && piano.ok ? { rows: piano.righe || [] } : { rows: [] }, {
        candidati: candidatiPerIlFeed(), posizioni: mercatiConPosizione(),
      });
      return fatto(!!(pr && pr.ok !== false), messaggioFeedRiseminato(pr));
    }
    if (azione === 'fermati-in-sicurezza') {
      // ⚠ L'ULTIMO GRADINO. Cinque tentativi diversi non hanno sciolto il blocco: il bot non sa cosa
      // sta succedendo, e un bot che non sa cosa sta succedendo non deve piazzare. Non tocca le
      // posizioni aperte e non ferma l'uscita automatica — è FERMA, non KILL.
      //
      // ── IL DISARMO, E PERCHÉ IL RAMO RESTA QUI PER INTERO (13 agosto 2026) ──────────────────────
      // L'armamento è una CONFIGURAZIONE (`SBLOCCO_GRADINO6_ARMATO`, il verso e la semantica stanno in
      // `lib/maker/sblocco-progressivo`), non una riga di codice commentata: riarmarlo domani è
      // togliere una riga dall'ecosystem, e il codice che ferma il bot non è mai stato rimosso.
      //
      // Disarmato, il gradino fa l'UNICA cosa che serve per decidere se armarlo: dice che **sarebbe**
      // scattato e perché. Il conteggio si fa sul registro (`tipo: 'sblocco-progressivo'`,
      // `disarmato: true`) e sull'audit (`outcome: 'gradino-6-disarmato'`), e conta EPISODI non tick —
      // `prossimoGradino` non riesegue l'ultimo gradino finché la scala non si azzera per ritorno alla
      // salute, quindi una riga = un blocco che sarebbe finito su FERMA.
      const arm = SBLOCCO.gradinoSeiArmato();
      if (!arm.armato) {
        return { azione, ok: true, disarmato: true, durataMs: Date.now() - t0,
          dettaglio: `⚠ SAREBBE SCATTATO — il bot NON è stato fermato perché il gradino 6 è ${arm.motivo}.`
            + ' Il bot resta su AVVIA e continua a piazzare; guardiano delle perdite, sentinella del collasso e KILL restano attivi.' };
      }
      const r = impostaBot({ enabled: false, by: 'agent41 · sblocco progressivo',
        reason: 'la scala di sblocco ha esaurito i gradini senza sciogliere il blocco: meglio fermo che pericoloso' });
      return fatto(!!(r && r.ok !== false), 'bot messo su FERMA: le posizioni aperte restano gestite, i piazzamenti nuovi si fermano');
    }
  } catch (e) {
    return fatto(false, `azione fallita: ${e && e.message}`);
  }
  return fatto(false, 'azione sconosciuta: non si inventa niente');
}

let statoVuoto = null;
// Lo storico dei campioni per il massimo mobile. In memoria: un riavvio lo svuota e la sentinella
// riparte senza massimo, cioe' muta finche' non ha di nuovo dieci minuti di storia. E' la direzione
// giusta — un massimo ereditato da prima del riavvio descriverebbe un altro processo.
let storicoCollasso = [];
async function sorvegliaVuoto(deps = {}) {
  const leggiOrdini = deps.listOrders || (() => listManualOrders({}));
  const forza = deps.forza || ((m) => controlloCapitaleFermo({ forzatoDa: m }));
  const ora = deps.now || Date.now();
  if (!TRIGGER_ATTIVO) return null;

  // I due cancelli gratuiti prima della lettura, per la stessa ragione del trigger: a bot fermo o con
  // il kill attivo il vuoto è lo stato CORRETTO e non c'è niente da leggere.
  const avviato = botAttivo();
  let kill = { effectivelyKilled: false, readable: true };
  try { kill = killSwitch.killStatus(); } catch { kill = { effectivelyKilled: true, readable: false }; }
  const killAttivo = kill.effectivelyKilled === true || kill.readable === false;

  let quanti = null;
  if (avviato && !killAttivo) {
    try {
      const o = await leggiOrdini();
      quanti = (o && o.ok !== false && Array.isArray(o.orders)) ? o.orders.length : null;
    } catch { quanti = null; }   // illeggibile ⇒ la sentinella si congela, non grida
  }

  // ══ IL COLLASSO DELLA COPERTURA — IN QUESTA FASE SOLO OSSERVA ═══════════════════════════════════
  // NON ferma il bot, NON cancella ordini, NON tocca AVVIA/FERMA: scrive nel log e nel giornale, e
  // basta. La promozione ad azione e' una decisione dell'operatore, dopo qualche giorno di righe.
  //
  // ⚠ LO SCATTO DEL GUARDIANO SPIEGA IL CALO, e la prova e' il file che il guardiano stesso scrive.
  // Il collasso piu' grande nei dati (23 -> 2 il 13 agosto) l'ha prodotto il guardiano cancellando 23
  // ordini: gridare su quello vorrebbe dire segnalare come anomalia un'altra difesa che ha funzionato.
  // Latch illeggibile ⇒ NON si arma: un calo che non si sa spiegare non diventa un'anomalia solo
  // perche' manca il dato che lo spiegherebbe. Meglio muto che bugiardo.
  let guardianScattatoAt = null;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'guardian-state.json'), 'utf8'));
    if (g && g.scattato === true && Number.isFinite(Number(g.at))) guardianScattatoAt = Number(g.at);
  } catch { guardianScattatoAt = null; }   // assente = non e' scattato; illeggibile = non si arma
  const c = COLL.valutaCollasso({
    storico: storicoCollasso, ordiniARiposo: quanti, now: ora,
    guardianScattatoAt, botAvviato: avviato, killAttivo,
  });
  storicoCollasso = c.storico;
  if (c.sospeso === true) {
    annuncia('log', `collasso della copertura SOSPESO — ${c.motivo}`);
  } else if (c.anomalia === true) {
    annuncia('warn', `⚠ ${c.motivo}`);
    try {
      appendMakerAudit({ ts: Date.now(), venue: 'polymarket', source: 'realloc-scheduler',
        op: 'sentinella-collasso', reason: 'collasso-copertura', decision: c.motivo,
        outcome: 'collasso-oltre-soglia',
        observed: { ordiniARiposo: quanti, massimoRecenteOrdini: c.massimo, caloPct: c.caloPct,
          sogliaCaloPct: COLL.SOGLIA_CALO_PCT, finestraMin: COLL.FINESTRA_MASSIMO_MS / 60000,
          guardianScattatoAt, soloOsservazione: true } });
    } catch { /* il giornale non deve poter fermare il giro */ }
  }
  const v = SENT.valutaVuoto({ stato: statoVuoto, ordiniARiposo: quanti, killAttivo, botAvviato: avviato, now: ora });
  statoVuoto = v.stato;
  if (v.rientrato === true) annuncia('log', `vuoto RIENTRATO — ${v.motivo}`);
  if (!v.anomalia) return v;

  // L'allarme si scrive UNA VOLTA per episodio: tre ore di vuoto non devono diventare novanta righe
  // identiche, che è il modo in cui un allarme smette di essere letto. La RICOSTRUZIONE invece si
  // richiede a ogni giro finché il vuoto dura, perché è l'azione che lo risolve.
  if (v.nuova) {
    let cal = null;
    let rip = null;
    try {
      const s = await leggiSaldo();
      const pos = readVenuePositions();
      const u = UTIL.misuraUtilizzo({
        saldoUsd: s && s.readable !== false ? s.usd : null,
        // ZERO ordini a riposo non è un'ipotesi: è il fatto che ha appena fatto scattare la sentinella.
        ordiniARiposoUsd: 0,
        posizioniUsd: pos && pos.readable === true ? UTIL.valorePosizioni(pos.positions || []) : null,
      });
      cal = CAPLAV.capitaleAlLavoro({ utilizzo: u });
      // Con il libro VUOTO la causa non è un'ipotesi da indovinare: tutto il capitale libero è fermo
      // perché nessuna riga è diventata un ordine. La si attribuisce per intero e la somma chiude.
      if (cal.leggibile) rip = CAPLAV.ripartizioneFermo({ fermoUsd: cal.fermoUsd, pianoSenzaRigheUsd: cal.fermoUsd });
    } catch { cal = null; rip = null; }
    const riga = SENT.rigaAllarme({ vuotoMs: v.vuotoMs, capitale: cal, ripartizione: rip });
    annuncia('error', riga);
    try {
      appendMakerAudit({ ts: Date.now(), venue: 'polymarket', source: 'realloc-scheduler', op: 'sentinella-vuoto',
        reason: 'sentinella-vuoto', decision: v.motivo, outcome: 'vuoto-oltre-soglia',
        requested: { vuotoMs: v.vuotoMs, sogliaMs: SENT.SOGLIA_MS },
        observed: { riga, alLavoroUsd: cal && cal.alLavoroUsd, fermoUsd: cal && cal.fermoUsd,
          ripartizione: rip ? rip.voci : null, killAttivo, botAvviato: avviato } });
    } catch { /* l'audit non blocca il tentativo di rimedio */ }
    scrivi({ at: new Date(ora).toISOString(), tipo: 'sentinella-vuoto', esito: 'anomalia',
      vuotoMs: v.vuotoMs, sogliaMs: SENT.SOGLIA_MS, motivo: v.motivo,
      capitaleAlLavoro: cal, ripartizione: rip ? rip.voci : null, pid: process.pid });
  }
  if (v.deveRicostruire) {
    try { await forza('sentinella-vuoto'); }
    catch (e) { annuncia('error', `la ricostruzione chiesta dalla sentinella è fallita: ${e.message}`); }
  }
  return v;
}

/**
 * L'AUTODIAGNOSI PERIODICA, e la scala che ne discende.
 *
 * Gira sulla stessa cadenza di rilevazione del trigger (**120 s**) e risponde a una domanda sola: *il
 * bot sta facendo il suo mestiere?* Quattro ingredienti — ordini vivi, capitale al lavoro, cicli che
 * girano, rinnovi che passano — e le soglie stanno in `sblocco-progressivo`, dichiarate lì con la
 * misura che le motiva. Se la risposta è no, **si sale la scala invece di aspettare che qualcuno legga
 * i log**: qui non c'è nessuno a leggerli.
 */
async function autodiagnosiPeriodica(deps = {}) {
  const leggiOrdini = deps.listOrders || (() => listManualOrders({}));
  const ora = deps.now || Date.now();
  if (!TRIGGER_ATTIVO) return null;
  if (!botAttivo()) { statoScala = null; sottoSogliaDa = null; return null; }
  let kill = { effectivelyKilled: false, readable: true };
  try { kill = killSwitch.killStatus(); } catch { kill = { effectivelyKilled: true, readable: false }; }
  if (kill.effectivelyKilled === true || kill.readable === false) { statoScala = null; sottoSogliaDa = null; return null; }

  let ordini = null; let aRiposo = 0;
  try { const o = await leggiOrdini(); if (o && o.ok !== false && Array.isArray(o.orders)) { ordini = o.orders.length; aRiposo = Object.values(TRIG.notionalePerMercato(o.orders)).reduce((a, b) => a + b, 0); } } catch { ordini = null; }

  let frazione = null;
  try {
    const s = await leggiSaldo();
    const pos = readVenuePositions();
    const u = UTIL.misuraUtilizzo({
      saldoUsd: s && s.readable !== false ? s.usd : null, ordiniARiposoUsd: +aRiposo.toFixed(4),
      posizioniUsd: pos && pos.readable === true ? UTIL.valorePosizioni(pos.positions || []) : null,
    });
    if (u.leggibile) frazione = u.frazione;
  } catch { frazione = null; }

  if (frazione != null && frazione < SBLOCCO.SOGLIA_AL_LAVORO) { if (sottoSogliaDa == null) sottoSogliaDa = ora; } else sottoSogliaDa = null;

  const d = SBLOCCO.autodiagnosi({
    ordiniVivi: ordini, frazioneAlLavoro: frazione, ultimoCicloMs: ora - ultimoCicloOk,
    sottoSogliaDa, now: ora,
  });

  const g = SBLOCCO.prossimoGradino({ stato: statoScala, sano: d.sano, now: ora, azioniSuggerite });
  const eraAlGradino = statoScala && statoScala.livello;
  statoScala = g.stato;
  if (d.sano === true && eraAlGradino) {
    annuncia('log', `✅ SBLOCCO RIUSCITO — il bot è tornato sano dopo il gradino ${eraAlGradino}`);
    azioniSuggerite = [];
  }
  if (!g.sali) return { diagnosi: d, gradino: null, motivo: g.motivo };

  annuncia('error', `🔴 AUTODIAGNOSI: il bot NON sta lavorando — ${d.motivi.join(' · ')}`
    + ` ⇒ gradino ${g.gradino.livello}/${SBLOCCO.SCALA.length}: ${g.gradino.cosa}`);
  const esito = await eseguiGradino(g.gradino.azione);
  // ── UN GRADINO DISARMATO NON È «ESEGUITO» E NON È «FALLITO» ────────────────────────────────────
  // Sono tre esiti, non due, e schiacciarli in due renderebbe impossibile la domanda a cui questo
  // registro esiste per rispondere: «quante volte il gradino 6 sarebbe intervenuto?». `eseguito:true`
  // lo confonderebbe con uno scatto vero, `false` con un guasto.
  const stato = esito.disarmato ? 'DISARMATO (sarebbe scattato)' : (esito.ok ? 'eseguito' : 'FALLITO');
  annuncia(esito.disarmato ? 'error' : 'log',
    `sblocco · gradino ${g.gradino.livello} «${g.gradino.azione}»: ${stato} — ${esito.dettaglio}`
    + (esito.disarmato ? ` · motivi della diagnosi: ${d.motivi.join(' · ')}` : ''));
  try {
    appendMakerAudit({ ts: ora, venue: 'polymarket', source: 'realloc-scheduler', op: 'sblocco-progressivo',
      reason: 'autodiagnosi', decision: g.motivo,
      outcome: `gradino-${g.gradino.livello}-${esito.disarmato ? 'disarmato' : (esito.ok ? 'eseguito' : 'fallito')}`,
      requested: { azione: g.gradino.azione, livello: g.gradino.livello },
      observed: { motivi: d.motivi, misure: d.misure, dettaglio: esito.dettaglio, azioniSuggerite,
        disarmato: esito.disarmato === true } });
  } catch { /* l'audit non blocca il rimedio */ }
  scrivi({ at: new Date(ora).toISOString(), tipo: 'sblocco-progressivo', livello: g.gradino.livello,
    azione: g.gradino.azione, eseguito: esito.ok, disarmato: esito.disarmato === true,
    dettaglio: esito.dettaglio, motivi: d.motivi, misure: d.misure, pid: process.pid });
  return { diagnosi: d, gradino: g.gradino, esito };
}

/** Il controllo periodico. Costa una lettura di saldo (in cache) e niente altro finche' non scatta. */
async function controlloCapitaleFermo({ forzatoDa = null } = {}) {
  if (inCorso) return;                    // il lucchetto, prima di qualunque I/O
  // ⚠⚠ R10 · PRIMA DEI CANCELLI, E APPOSTA. Il kill a −$100 mette il bot su FERMA: se la chiusura
  // delle posizioni stesse dietro `botAttivo()` non girerebbe mai, perche' lo stato che la richiede e'
  // esattamente quello che la spegnerebbe. Costa una lettura di file locale quando il file non c'e'.
  // Il KILL switch resta davanti, ma DENTRO la funzione: e' l'unico cancello che qui si rispetta.
  try { await eseguiChiusuraDiEmergenza(); }
  catch (e) { annuncia('error', `⚠ R10 · chiusura di emergenza NON eseguita: ${e.message}`); }
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
  // ── LA SELEZIONE GIRA ANCHE QUANDO IL TRIGGER NON SCATTA ──────────────────────────────────────
  // Sta PRIMA di `decidiTrigger` di proposito: un mercato che scade deve uscire dalla lista in minuti
  // anche in una giornata in cui il capitale e' tutto al lavoro e nessun trigger scatta mai. Costa due
  // letture di file locali, non una chiamata di rete, e i due cancelli gratuiti (bot avviato, kill
  // spento) sono gia' stati passati qui sopra.
  // ⚠ PRIMA della selezione: un doppione tolto e uno slot dichiarato vuoto cambiano cio' che la
  // selezione vede. Farlo dopo significherebbe decidere sulla fotografia sbagliata.
  // ⚠ PRIMA di tutto: una posizione oltre l'ora si chiude, e non dipende da niente altro.
  try { await presidioPosizioniVecchie(); }
  catch (e) { annuncia('log', `presidio posizioni vecchie non eseguito: ${e.message}`); }
  try { await riconciliaCopertura(); }
  catch (e) { annuncia('log', `riconciliazione della copertura non eseguita: ${e.message}`); }
  try { await selezionaMercati(); }
  catch (e) { annuncia('log', `selezione automatica non eseguita: ${e.message} — si prosegue con la lista di prima`); }
  // ⚠ DOPO la selezione, sempre: e' la derivazione che tiene allineati allowlist e selezione senza
  // che ogni percorso di uscita debba ricordarsene. Vedi `riconciliaAllowlist`.
  try { await riconciliaAllowlist(); }
  catch (e) { annuncia('log', `allowlist non riconciliata: ${e.message}`); }
  // ⚠ DOPO `riconciliaAllowlist` E INDIPENDENTE DA LEI: quella deriva dalla selezione e si astiene
  // quando la selezione e' spenta; questa guarda solo la SCADENZA, quindi copre proprio il caso che
  // l'altra non copre. Non solleva mai: un guasto qui lascia il perimetro com'era.
  try { await scadenzeFuoriPerimetro(); }
  catch (e) { annuncia('log', `scadenze non riconciliate nel perimetro: ${e.message}`); }
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
  raccontaCapitaleAlLavoro(r.utilizzoStimatoDopo || r.utilizzo, r, 'mini-ciclo');
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

// Le tre dipendenze sono iniettabili per poter provare la transizione senza rete e senza toccare
// capitale: chi non le passa ha esattamente il comportamento del processo vivo.
async function sorvegliaAvvio(deps = {}) {
  const leggiInterruttore = deps.statoBot || statoBot;
  const eseguiGiro = deps.giro || giro;
  const ripianifica = deps.pianificaProssimo || pianificaProssimo;
  let s;
  try { s = leggiInterruttore(); } catch { return; }
  if (!s || s.leggibile !== true || !Number.isFinite(s.at)) return;
  if (ultimoAvvioVisto == null) { ultimoAvvioVisto = s.at; return; }
  if (s.at <= ultimoAvvioVisto) return;
  ultimoAvvioVisto = s.at;
  if (s.enabled !== true) { annuncia('log', 'interruttore commutato su FERMA: nessun ciclo, i piazzamenti nuovi si fermano dal prossimo giro'); return; }

  // ── AVVIA FA PARTIRE UN CICLO COMPLETO, SUBITO (12 agosto 2026) ────────────────────────────────────
  // Prima qui partiva il MINI-ciclo. La rilevazione era gia' rapida — 15 secondi — ma il mini-ciclo
  // sceglie dal piano salvato e ha le sue attese: il piano vero ripartiva alla cadenza successiva,
  // quindi fino a dieci minuti di capitale fermo dopo che una persona ha premuto il bottone.
  //
  // SI RIUSA `giro`, IL CICLO NORMALE, e non se ne scrive uno parallelo. Non e' pigrizia: e' l'unico
  // modo di garantire «stesse regole, stesso fail-closed, stesso freno» senza doverlo promettere in un
  // commento. `giro` rilegge l'interruttore, consulta il freno di prova (due punti: il referto e
  // `dryRunOnly` del reset), passa dal motore e dai suoi cancelli. L'unica cosa che cambia e' il
  // MOTIVO, che viaggia in `ciclo-avvio` e `ciclo-referto` e rende questo ciclo distinguibile da quelli
  // a cadenza senza guardare l'orologio.
  //
  // I TRE VINCOLI, e nessuno dei tre e' nuovo codice:
  //   · SOLO SULLA TRANSIZIONE — `s.at <= ultimoAvvioVisto` sopra: si guarda l'ISTANTE in cui
  //     l'interruttore e' stato scritto, non il fatto che sia acceso. Una lettura ripetuta dello stesso
  //     AVVIA non passa di qui.
  //   · MAI DUE VOLTE PER LO STESSO AVVIA — `ultimoAvvioVisto` e' aggiornato PRIMA di questo await:
  //     una seconda passata del poller durante il ciclo trova lo stesso istante e torna indietro.
  //   · MAI DUE CICLI INSIEME — `giro` esce con `null` se `inCorso`, che e' lo stesso lucchetto del
  //     ciclo a cadenza e del mini-ciclo.
  annuncia('log', `AVVIA rilevato (${s.by || 'ignoto'}) — ciclo di allocazione COMPLETO subito:`
    + ' non si aspetta ne\' la finestra del mini-ciclo ne\' il ciclo delle sei ore');
  const r = await eseguiGiro('avvia-operatore');
  if (r == null) {
    annuncia('log', 'AVVIA: un ciclo era gia\' in corso — non se ne apre un secondo, quello in corso vale');
    return;
  }
  // LA CADENZA RIPARTE DA ADESSO, non da prima. `giro` ha appena scritto `lastRunAt`, quindi
  // `prossimoRitardo()` conta dall'avvio di questo ciclo: senza il riallineamento il timeout gia'
  // armato sarebbe scattato all'ora vecchia, cioe' un secondo ciclo prima del dovuto.
  ripianifica('dopo il ciclo innescato dall\'AVVIA');
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

// IL TIMER E' UNO SOLO, E LO SI TIENE IN MANO. Prima era un `setTimeout` anonimo: un ciclo eseguito
// fuori cadenza (l'AVVIA, sotto) spostava `lastRunAt` ma NON il timeout gia' armato, che sarebbe
// scattato all'ora vecchia — cioe' un secondo ciclo troppo presto. Tenendo il riferimento, chi esegue
// un ciclo fuori cadenza puo' riallineare la cadenza al momento dell'avvio invece che a quello di prima.
let timerProssimo = null;

function pianificaProssimo(motivo) {
  if (timerProssimo) { clearTimeout(timerProssimo); timerProssimo = null; }
  const ms = prossimoRitardo();
  annuncia('log', `prossimo ciclo fra ${(ms / 60_000).toFixed(1)} minuti (${motivo})`);
  timerProssimo = setTimeout(async () => { await giro('timer'); pianificaProssimo('dopo un ciclo'); }, ms);
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
      //
      // ⚠ ZERO E «NON LO SO» NON SONO LA STESSA COSA (16 agosto 2026).
      // Qui c'era `Number(a && a.capital)`, e `readAllocatedCapitalAll()` restituisce `capital: null`
      // finche' nessun ciclo ha scritto `data/maker-allocated-capital.json` — cioe' a ogni primo avvio.
      // **`Number(null) === 0`**, quindi `Number.isFinite(0)` era vero e il ramo «non letto», che
      // esisteva gia' due righe piu' sotto, non veniva MAI raggiunto: il banner dichiarava
      // «tetto per mercato $24.50 DERIVATO da capitale $0.00 · 0 mercati sostenibili», tre numeri
      // presentati come misure e ottenuti interrogando le funzioni su un'incognita.
      // E' l'ennesima occorrenza della classe elencata in §5.3, di nuovo trovata da una prova.
      //
      // ⚠ LA CURA STA QUI, NON IN `capPerMarketUsd`. Quella funzione NON deve tornare `null` (§4.2):
      // a valle un tetto assente varrebbe «nessun tetto», cioe' il fail-OPEN della vecchia versione a
      // percentuale. Il difetto non e' che deriva un tetto da zero, e' che il CHIAMANTE le passa
      // un'incognita e ne stampa il risultato come un fatto. Quando il capitale non si legge non si
      // deriva niente: si dichiara di non saperlo, e il piano — che gia' rifiuta per conto suo
      // (`decidiTrigger` con `saldo.readable === false`) — resta fermo.
      try {
        const CO = require('../lib/rewards/concentration');
        const cap = (() => {
          try { const a = readAllocatedCapitalAll(); return (a && Number.isFinite(a.capital)) ? a.capital : null; }
          catch { return null; }
        })();
        if (cap == null) {
          return ', capitale NON LETTO (data/maker-allocated-capital.json senza `capital`)'
            + ' ⇒ NESSUN tetto derivato, NESSUN piano — zero e «non lo so» non sono la stessa cosa';
        }
        const t = CO.capPerMarketUsd(cap);
        const f = CO.finestraMid(cap);
        return `, tetto per mercato $${t} DERIVATO da capitale $${cap.toFixed(2)}`
          + ` (f_min obiettivo ${(CO.F_MIN_OBIETTIVO * 100).toFixed(0)}%) · $${(t / 2).toFixed(2)} per lato`
          + ` · ${CO.mercatiSostenibili(cap)} mercati sostenibili (tetto di carico ${CO.MAX_MERCATI})`
          + ` · tetto per ordine $${CO.liveMinOrderCapUsd(cap)} · finestra mid [${f.lo} · ${f.hi}]`;
      } catch { return ', tetto per mercato non calcolabile'; }
    })()
    + ` · il bot e' ${bot0.enabled ? 'AVVIATO (ordini veri quando le regole lo consentono)' : 'FERMO (solo piano, nessun ordine)'}`
    + ` · l'interruttore e' ${FILE_INTERRUTTORE}, si commuta dalla tab «Mercati ottimizzati»`);
  scrivi({ at: new Date().toISOString(), tipo: 'avvio', stato: 'acceso', botEnabled: bot0.enabled,
    botMotivo: bot0.motivo, intervalloOre: INTERVAL_MS / 3_600_000 });
  // ── L'ALLARME SUL CAPITALE NON LETTO ──────────────────────────────────────────────────────────────
  // Una riga di log si perde fra le venti dell'avvio; una riga di giornale si CONTA. Senza questa,
  // «il capitale non si legge» resterebbe un'assenza, e un'assenza non fa scattare niente e non si
  // ritrova fra un mese. Si scrive solo quando manca davvero: un allarme che compare a ogni avvio
  // smetterebbe di essere letto.
  {
    const a0 = (() => { try { return readAllocatedCapitalAll(); } catch (e) { return { readable: false, error: e && e.message, capital: null }; } })();
    if (!a0 || a0.readable !== true || !fin(a0.capital)) {
      annuncia('log', "⚠ CAPITALE NON LETTO all'avvio: nessun tetto e' derivabile e nessun piano puo'"
        + " partire finche' un ciclo non scrive `capital`."
        + ' Non e\' un capitale ZERO: e\' un capitale IGNOTO, e le due cose portano a decisioni opposte.');
      scrivi({ at: new Date().toISOString(), tipo: 'capitale-non-letto', stato: 'avvio',
        leggibile: a0 ? a0.readable === true : false,
        motivo: (a0 && a0.error) || 'il file non porta il campo `capital`',
        file: require('../lib/maker/allocated-capital').STORE_FILE,
        conseguenza: 'nessun tetto derivato, nessun piano: zero e non-letto non sono la stessa cosa' });
    }
  }
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
      + ` · se il piano salvato manca, e' vecchio (> ${PIANO_FRESCO_MAX_MS / 60000} min), non ha spazio`
      + ` o ha meno di ${TRIG.SOGLIA_RIGHE_UTILI} righe ancora spendibili, RICOSTRUISCE il piano (leggero a ${FINESTRA_LEGGERA_ORE}h, stessi filtri del ciclo pesante)`);
    annuncia('log', `autodiagnosi periodica ACCESA — ogni ${TRIG.CADENZA_MS / 1000}s verifica ordini vivi, capitale al lavoro (soglia ${Math.round(SBLOCCO.SOGLIA_AL_LAVORO * 100)}% per ${SBLOCCO.DURATA_SOTTO_SOGLIA_MS / 60000} min), cicli che girano e rinnovi che passano`
      + ` · se il bot non lavora sale la SCALA DI SBLOCCO: ${SBLOCCO.SCALA.map((g) => g.livello + '·' + g.azione).join(' → ')}`
      + ` · un gradino ogni ${SBLOCCO.ATTESA_GRADINO_MS / 60000} min, nessuno tocca una regola di rischio, l'ultimo e' FERMA`);
    annuncia('log', `rifiuti ripetuti ACCESO — ${SBLOCCO.N_RIPETIZIONI} rifiuti identici di fila sulla stessa coppia (mercato, gate) sono un blocco strutturale:`
      + ' via alternativa se la causa e\' uno stato del bot, esclusione e dichiarazione se e\' una regola di rischio');
    annuncia('log', `sentinella sul vuoto ACCESA — zero ordini a riposo per piu' di ${SENT.SOGLIA_MS / 60000} min`
      + ' con KILL spento e bot AVVIATO e\' un\'ANOMALIA: allarme nel log e nel giornale con la ripartizione del fermo in dollari,'
      + ` e ricostruzione del piano chiesta subito · controllo ogni ${TRIG.CADENZA_MS / 1000}s`
      + ' · e\' una sola LETTURA degli ordini: non consuma nessun posto della quota riservata ai rinnovi');
    setTimeout(() => {
      setInterval(() => { controlloCapitaleFermo().catch((e) => annuncia('error', 'controllo capitale fermo fallito', { error: e.message })); }, TRIG.CADENZA_MS);
      // La sentinella gira sulla STESSA cadenza di rilevazione del trigger (120 s), sfalsata di mezzo
      // periodo: le due leggono cose diverse (il saldo l'una, il libro l'altra) e sovrapporle
      // significherebbe due letture nello stesso istante senza nessun vantaggio.
      setTimeout(() => {
        setInterval(() => { sorvegliaVuoto().catch((e) => annuncia('error', 'sentinella sul vuoto fallita', { error: e.message })); }, TRIG.CADENZA_MS);
      }, Math.floor(TRIG.CADENZA_MS / 2));
      // L'autodiagnosi gira sulla stessa cadenza, sfalsata di un quarto di periodo dalle altre due: le
      // tre leggono cose diverse e non c'è nessun vantaggio a farle partire nello stesso istante.
      setTimeout(() => {
        setInterval(() => { autodiagnosiPeriodica().catch((e) => annuncia('error', 'autodiagnosi fallita', { error: e.message })); }, TRIG.CADENZA_MS);
      }, Math.floor(TRIG.CADENZA_MS / 4));
    }, STARTUP_DELAY_MS);
    // Il sorvegliante dell'interruttore parte SUBITO e non dopo il minuto di grazia: la sua prima
    // esecuzione non piazza niente per costruzione (inizializza l'istante), e serve proprio a essere
    // gia' in ascolto se qualcuno preme AVVIA nel primo minuto di vita del processo.
    annuncia('log', `sorveglianza dell'interruttore ACCESA — controllo ogni ${AVVIO_CADENZA_MS / 1000}s: un AVVIA fa partire SUBITO un ciclo di allocazione COMPLETO (motivo \`avvia-operatore\`), e la cadenza riparte da li'`);
    sorvegliaAvvio().catch(() => {});
    setInterval(() => { sorvegliaAvvio().catch((e) => annuncia('error', 'sorveglianza avvio fallita', { error: e.message })); }, AVVIO_CADENZA_MS);
  } else {
    annuncia('log', 'trigger capitale fermo SPENTO (TRIGGER_CAPITALE_FERMO=0) — resta solo il ciclo fisso');
  }
}

if (require.main === module) main();

// ⚠ `giro` E' ESPORTATO DAL 17 AGOSTO 2026, e la ragione e' una richiesta dell'operatore con un numero
// dietro: finche' il ciclo da 6 ore era raggiungibile solo da `main()` (che accende i timer) o da
// `--once` (che e' un processo separato, quindi con il venue VERO), un banco non poteva provarlo — e
// l'unica alternativa era riscriverne il cablaggio, cioe' provare una COPIA. La copia dell'auto-close
// era piu' piccola dell'originale (17 dep contro 20) e ha prodotto un conteggio di regole che
// descriveva un bot che non esiste.
// LA FIRMA NON CAMBIA: `giro(motivoAvvio)`, le stesse 21 dep cablate dentro. Chi lo prova sostituisce
// lo STATO che il bot legge (`require.cache`), non il cablaggio — cosi' il percorso provato e' quello
// di produzione, riga per riga. Esportare non arma niente: dentro `giro` restano `statoBot()` e il
// freno, riletti a ogni chiamata, e a bot FERMO il giro calcola e non tocca il venue.
// ⚠ `controlloCapitaleFermo` E' ESPORTATO PER LA STESSA RAGIONE DI `giro`, e la misura l'ha resa
// necessaria: il banco ha provato ad aprire da zero con `giro()` e il ciclo ha risposto «tutti i
// mercati in gestione sono ancora validi: NESSUNA AZIONE». Il ciclo da 6 ore MANTIENE
// un'allocazione, non ne apre una (§5-bis 19, «il primo avvio non ha un innesco»): chi apre da zero
// e' il trigger a capitale fermo, e la sua meta' che DECIDE — saldo sopra soglia, board fresco,
// AVVIA, kill — vive qui e non in `miniCiclo`. Provare `miniCiclo` da solo vorrebbe dire
// riscrivere quella decisione, cioe' provare una copia.
module.exports = { giro, controlloCapitaleFermo, leggiVenue, leggiSaldo, prossimoRitardo, scriviUltimoPiano, leggiUltimoPiano,
  miniCiclo, preparaMercatoNuovo, pianoLeggero, sorvegliaAvvio, sorvegliaVuoto,
  selezionaMercati, rilasciaDallaSelezione, selezioneAttiva, restringiAllaSelezione, leggiBoardReward, posizioniPerSelezione,
  riconciliaAllowlist, scadenzeFuoriPerimetro, riconciliaCopertura, presidioPosizioniVecchie,
  eseguiChiusuraDiEmergenza, prezzoUscitaAttraversata,
  // ⚠ `ripristinaGamba` e' esportata per essere PROVATA SUL CABLAGGIO e non solo sulla decisione:
  // `riconciliaCopertura` scrive nel giornale vero (`scrivi` non e' iniettabile), mentre questa funzione
  // non scrive niente e accetta tutte le dep. E' la lezione di §5-bis p.181: le tre difese inerti del
  // 17 agosto avevano test verdi perche' provavano la decisione e non chi la collega.
  ripristinaGamba,
  autodiagnosiPeriodica, eseguiGradino, messaggioFeedRiseminato, nozionalePiazzato,
  LOG_FILE, STATE_FILE, POOLS_FILE, ULTIMO_PIANO_FILE,
  FINESTRA_LEGGERA_ORE, PIANO_FRESCO_MAX_MS, AVVIO_CADENZA_MS,
  rigaBoardNormalizzata, copiaRegoleNelRipiego, BOARD_NORMALIZZATO, sorvegliaAvvio, scadenzaDalBoard };
