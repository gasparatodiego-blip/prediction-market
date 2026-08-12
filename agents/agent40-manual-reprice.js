#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent40-manual-reprice — the BAND-EXIT WATCHER for hand-placed orders.
//
// WHY IT EXISTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it on a clock,
// whatever the price was doing. That is the wrong axis for a reward maker — what matters is whether the
// order is still inside the band that pays, not how long it has been sitting there. So on an auto-reprice
// market a hand order carries a RESTING_GTD_SECONDS window (23 min) and this process does three things:
//   • RE-PRICES it when the mid has travelled far enough to push it out of the band that pays. If the mid
//     does not move that far, the order is not touched at all;
//   • RENEWS the window proactively before it can lapse, so time never kills a healthy order — while the
//     window itself stays real, as the DEAD-MAN'S SWITCH the exchange enforces if this host stops;
//   • RECONCILES the manual lane's sent orders against venue truth, so an order the venue retired stops
//     counting as open exposure in the risk ledger. Nothing else does this for the manual lane.
//
// NAMED agent40: slots 36-39 are taken (book-velocity, maker-watchdog, tape-watchdog, net-rerun). This
// process CAN cause a placement,
// so it is deliberately the narrowest thing that can: it owns no adapter and NO SIGNING KEY of its own.
// Its only reachable venue surface for WRITES is lib/maker/manual-order.replaceManualOrder — the SAME
// function the panel's "Riprezza" button calls — so every gate that governs a hand order governs every
// automatic re-price, with no second code path that could drift from the first.
//
// It does hold ONE credential, and only since the daily reward comparison landed: the L2 (HMAC) creds,
// used by lib/maker/reward-reale.js to GET the venue's confirmed payout. That is not a hole in the
// sentence above — L2 creds cannot sign an order. A Polymarket order needs an EIP-712 struct signed by
// the L1 key, which this process does not have and cannot reach. Saying "no credentials" was simpler
// and is now false, and a startup line that is 90% true is the kind of thing that misleads whoever
// reads it during an incident.
//
// WHAT IT WILL NOT DO, and these are structural, not stylistic:
//   • It does nothing at all unless BOTH the global master switch and the per-market opt-in are on
//     (data/maker-auto-reprice.json). Both default OFF and both fail closed to OFF.
//   • It touches ONLY orders it can PROVE the manual panel placed (attributed from the append-only audit
//     trail). agent35's orders and unattributable orders are never candidates.
//   • It refuses to act on a mid that is not from agent34's live book, or that is stale.
//   • It reads the GLOBAL KILL SWITCH before it cancels anything — a re-price is cancel-then-place, and
//     cancelling under a kill would strip a resting order the replacement could not restore.
//   • It has a per-order rate limit and a per-market hourly ceiling. An automatism without a runaway
//     guard is an incident waiting.
//   • It never sends anything MANUAL_ORDER_PLACEMENT would not send: with the panel's switch on dry-run
//     (the default), an automatic re-price builds, signs and validates the replacement — and drops it.
//
// EVERYTHING it does is stamped source:'auto-reprice-band-exit' in data/polymarket-maker-audit.jsonl —
// distinct from 'manual-ui' and from 'agent35', so the trail always says what moved what.
//
// IF THIS PROCESS DIES, THE ORDERS ARE STILL SAFE — that is the whole point of keeping a real GTD window
// rather than resting GTC: nothing renews, and the exchange retires them within it. What is lost is the
// re-pricing and the reconciliation, so it writes a heartbeat every cycle which the manual panel displays;
// a stale heartbeat next to an ON switch is the operator's signal to look.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// ── Load .env (pm2 does not auto-load project env files) — read-only, never printed, never committed ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file absent → fine */ }
}

const { runAutoRepriceCycle } = require('../lib/maker/auto-reprice');
// ── IL MOTORE DI MARKET MAKING A DUE LATI ──────────────────────────────────────────────────────────
// Ospitato QUI, non in un processo suo. La ragione non e' la comodita': i due motori devono essere
// d'accordo su chi possiede quale mercato, e in un processo solo quell'accordo e' una lettura di lista
// in memoria invece di due processi che leggono lo stesso file e possono agire nella stessa finestra.
// In piu' questo processo e' gia' «la cosa piu' stretta che possa piazzare» — nessun adapter, nessuna
// credenziale, nessuna chiave, solo le funzioni del pannello manuale — quindi aggiungere qui non allarga
// la superficie: la riusa.
const { runTrackingCycle, TRACKING_POLL_MS, MID_STALE_PAUSE_SEC } = require('../lib/maker/mm-tracking');
const { readTrackingConfig, setTracking } = require('../lib/maker/mm-tracking-config');
const { marketWindowFor } = require('../lib/maker/market-clock');
const { loadAutoRepriceTuning, EXPECTED_RENEWALS_PER_HOUR, setAutoReprice, readAutoRepriceConfig } = require('../lib/maker/auto-reprice-config');
const { listManualOrders, replaceManualOrder, resolveMarketRules, resolveMarketDepth, cancelManualOrder } = require('../lib/maker/manual-order');
// THE STANDING RECONCILIATION FOR THE MANUAL LANE. Without it, every hand order that reaches its
// venue-side expiry leaves a permanent phantom at full notional in the risk ledger, and the cap gate
// slowly starts refusing orders that nothing real is backing (that is exactly how "open exposure $67.04"
// appeared next to an empty orders table). agent35 was never going to do this for us: its reconciliation
// is "dormant until arming" and it stands off manual markets by design.
const { reconcileManualLane, fetchVenuePositions } = require('../lib/maker/manual-reset');
const { decideRimpiazzo } = require('../lib/maker/rimpiazzo-gamba');
const { resolveOffsetFor } = require('../lib/maker/offset-config');
const { readAllocatedCapital, readAllocatedCapitalAll, writeAllocatedCapital } = require('../lib/maker/allocated-capital');
const { setManualMode } = require('../lib/maker/manual-mode');
const { isAutoCloseEnabled, setAutoClose } = require('../lib/maker/auto-close-config');
const PULIZIA = require('../lib/maker/pulizia-mercato-chiuso');
// Il catalogo di ripiego: porta `endDate` dei mercati usciti dal board ma su cui abbiamo capitale.
const { readMarketCatalog } = require('../lib/maker/market-catalog');
// Lo stato REALE del mercato al venue (`closed`/`acceptingOrders`), per la scansione dei registri:
// e' la domanda giusta perche' copre risoluzione e annullamento, mentre l'orologio vede solo la
// scadenza nominale.
const { leggiVenueClob } = require('../lib/maker/verifica-mercati-venue');
const { registraResiduoScoperto, potaScadute, leggiRegistroResidui, scriviRegistroResidui } = require('../lib/maker/accumulo-residui');
const MC = require('../lib/maker/modalita-chiusura');
// ── IL PERCORSO DI PROFILO, CABLATO AL CICLO ────────────────────────────────────────────────────────
// `valutaPiazzamento` instrada un mercato verso i controlli Safe (mai-primo, depth $15 cumulata,
// volatilita' 8h, spread anomalo, quota 65%, esposizione 30%) o Risk (mai-primo, depth $20 sul
// gradino, nervosismo 5 min). Il motore non contiene nessun `if (profilo)`: legge il profilo dallo
// store e passa la decisione a quella funzione, che e' pura e testata a parte.
const { valutaMercato } = require('../lib/maker/motore-unico');
// GLI INGRESSI DEL MOTORE. Il saldo del funder in cache (Regola 5) e il denominatore pulito del
// pavimento (Regola 2): due moduli puri, due dipendenze iniettate, nessuna logica nuova qui dentro.
const { leggiSaldoUsd } = require('../lib/maker/saldo-cache');
const { campionaProfonditaAltrui, mediaProfonditaAltrui } = require('../lib/maker/profondita-altrui');
// GLI ORDINI CHE C'ERANO GIA'. Fotografati all'avvio e a ogni riarmo, poi invisibili al ciclo: non si
// riprezzano, non si rinnovano, non si cancellano e non contano nel capitale impegnato. Il KILL li
// prende comunque (passa da cancel-all, non da qui) e una loro esecuzione diventa una posizione, che
// si gestisce normalmente. Vedi lib/maker/ordini-preesistenti.js.
const {
  fotografaPreesistenti, potaPreesistenti, separaPreesistenti, idsPreesistenti,
} = require('../lib/maker/ordini-preesistenti');
// LE CANCELLAZIONI CHE SI DEVONO VEDERE. Il 6 agosto 2026 una gamba e' stata cancellata correttamente
// e nessun evento e' arrivato a una superficie: l'operatore se n'e' accorto guardando l'app del venue.
const { registraCancellazioni } = require('../lib/maker/cancellazioni-visibili');
// ── IL CONFRONTO STIMA / CONSUNTIVO ─────────────────────────────────────────────────────────────────
// Due controlli orari dentro QUESTO processo: nessun pm2 nuovo. agent40 e' gia' sempre acceso e gira
// ogni 5 secondi, quindi ha gia' l'orologio che serve — aggiungere un processo per due letture al
// giorno sarebbe stato un demone in piu' da sorvegliare per niente.
const { compitiDovuti, registraStima, registraReale, leggiConfronto } = require('../lib/maker/confronto-reward');
// La lettura del consuntivo. SOLA LETTURA per costruzione: usa solo le credenziali L2, parla solo in
// GET, e non importa l'adapter — l'unico oggetto del progetto che sappia mandare un ordine.
const { leggiRewardReale } = require('../lib/maker/reward-reale');
// La STESSA funzione che alimenta il pannello: la stima fotografata e' quella che l'operatore vede,
// non un secondo calcolo che potrebbe divergerne. `buildMarketBoard` legge dai file degli agent, non
// dal database — nessuna connessione Prisma entra in questo processo.
const { buildMarketBoard, buildOrderBoard, buildSummary } = require('../lib/maker/operator-board');
const { AUTO_CLOSE_SOURCE } = require('../lib/maker/auto-close-config');
const { writeVenuePositions, readVenuePositions, readVenuePositionsConRefresh } = require('../lib/safety/venue-positions-snapshot');
// L'AVVISO SUI RESIDUI CHE MUOIONO SOTTO LA SOGLIA MINIMA. Deposita in data/ quello che il ciclo scopre,
// perché lo legga la dashboard: la riga di log da sola non ha mai avvisato nessuno (0x4c19a7, 5 agosto).
const { registraResiduiSottoSoglia } = require('../lib/maker/residui-sotto-soglia');
const { registraScadenzeSenzaRinnovo } = require('../lib/maker/scadenze-senza-rinnovo');
// AUTOMATIC POSITION CLOSING. Runs on the same throttle as the reconciliation and for the same reason:
// a fill is only observable after the venue is asked. Default OFF everywhere; see lib/maker/auto-close.js.
const { runAutoCloseCycle } = require('../lib/maker/auto-close');
const { readAutoCloseConfig } = require('../lib/maker/auto-close-config');
const { placeManualOrder } = require('../lib/maker/manual-order');
const { resolveFunder, venueAccountAddress } = require('../lib/venues/polymarket-clob-maker/funder');
const { isManualMarket } = require('../lib/maker/manual-mode');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const killSwitch = require('../lib/safety/kill-switch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

const HEARTBEATS = '/tmp/agent-heartbeats.json';
// ── IL BATTITO CHE IL GUARDIANO DEVE SORVEGLIARE ────────────────────────────────────────────────────
// Questo processo possiede gli ordini della corsia manuale: li piazza, li riprezza, li rinnova, li
// cancella. Fino al 6 agosto 2026 non aveva un battito che qualcuno guardasse — scriveva solo quello di
// flotta in /tmp/agent-heartbeats.json, che nessun watchdog legge — mentre agent37 sorvegliava agent35,
// che su questi mercati sta deliberatamente alla larga («manual mode active, skip»).
//
// Quella notte agent35 si è fermato 129s e agent37 ha cancellato NOVE ordini di QUESTO processo, che
// nello stesso intervallo stava facendo undici chiamate al venue ogni cinque secondi. Il guardiano
// stava sorvegliando la cosa sbagliata; adesso questo file è la cosa giusta.
//
// SIGNIFICA UNA COSA SOLA: «un ciclo è arrivato in fondo». Non «ho piazzato», non «ho deciso di sì» —
// uno skip deliberato batte esattamente come un riprezzo, perché è un giro completato. Il ciclo che si
// rifiuta di agire su un mid vecchio sta lavorando, non morendo.
const MANUAL_HB_FILE = path.join(__dirname, '..', 'data', 'manual-reprice-heartbeat.json');
// Lo stato vivo del tracking, per la dashboard. Un motore che piazza da solo deve poter rispondere
// «cosa stai facendo adesso» senza che si debbano leggere i log di un processo.
const TRACKING_STATE_FILE = '/tmp/maker-mm-tracking-state.json';
const log = (...a) => console.log(new Date().toISOString(), '[agent40-manual-reprice]', ...a);

// The breach counter lives HERE, in process memory, deliberately. "N consecutive observations" is a
// statement about an unbroken run of cycles, and a restart genuinely breaks that run — so a fresh process
// must start counting again rather than inheriting a claim it did not witness. The DURABLE state (last
// re-price, hourly counts) is what must survive a restart, and that lives in data/ instead.
const breaches = new Map();

// GLI ORDINI PER CUI L'AVVISO «RESIDUO SOTTO SOGLIA» È GIÀ USCITO. Accanto a `breaches` e per la stessa
// ragione: la condizione si ripresenta identica a ogni ciclo finché l'ordine non scade, e senza questo
// Set l'avviso uscirebbe dodici volte al minuto — cioè si leggerebbe come il rumore che sostituisce.
// In memoria come gli altri, e va bene: un riavvio lo azzera, ma la deduplica DURA vive nel file di
// data/, che fonde per orderId — quindi un riavvio non fa riapparire un avviso già dato.
const residuiSegnalati = new Set();

// GLI ORDINI PER CUI IL CONFLITTO INSEGUIMENTO/MAI-PRIMO È GIÀ STATO DICHIARATO. Stesso posto e stessa
// ragione: la soppressione è uno stato che dura finché il book non cambia, e nel registro durevole ci
// vanno le transizioni. Un riavvio lo azzera e va bene — la riga uscirà una volta in più, non una in
// meno, che è il verso giusto per un meccanismo che si sta imparando a verificare.
const conflittiSoppressi = new Set();

// CIO' CHE SAPPIAMO DI OGNI ORDINE VISTO A RIPOSO, per poter rispondere «e' morto per scadenza, e perche'
// nessuno l'ha rinnovato?» su un ordine che non c'e' piu'. Un riavvio la azzera, e la conseguenza e'
// accettabile nel verso giusto: un ordine morto durante il riavvio non viene annunciato, invece di essere
// annunciato per sbaglio. La deduplica DURA vive nel file di data/, che fonde per orderId.
const ordiniVisti = new Map();

// Lo stato per mercato del motore di tracking, portato fra un ciclo e l'altro. In memoria di proposito,
// come `breaches`: un riavvio lo azzera, ed e' corretto — gli ordini a riposo portano una scadenza GTD
// venue-enforced, quindi un processo che riparte senza memoria non lascia nulla di eterno dietro di se.
const trackingState = new Map();
// Le ultime azioni del motore, per la tabella in dashboard. Limitato: e' una finestra, non un archivio
// (l'archivio e' l'audit append-only).
const trackingLog = [];
const TRACKING_LOG_MAX = 200;

// The CONNECTION BLACKOUT clock, also in process memory and also on purpose. "We have been unable to
// reach the venue since T" is a claim about a continuous observation this process made; a restarted
// process has not made it, and must not inherit it. Note that a restart is itself the safe direction
// here — the orders it lost track of are carrying a venue-side expiry that retires them regardless.
const link = { downSince: null, consecutiveFailures: 0 };

// Reconciliation cadence. NOT every 5s cycle: it is not urgent (a phantom costs nothing until the next
// order is sized) and each run that finds work makes venue calls. 60s matches agent35's own
// RECONCILE_INTERVAL_MS. In the steady state it costs nothing at all — the function's first act is a
// two-file local check, and it returns without touching the network when there is nothing unresolved.
const RECONCILE_EVERY_MS = Number(process.env.MAKER_MANUAL_RECONCILE_MS || 60_000);
let lastReconcileAt = 0;

function heartbeat() {
  try {
    const hb = (() => { try { return JSON.parse(fs.readFileSync(HEARTBEATS, 'utf8')); } catch { return {}; } })();
    hb['agent40-manual-reprice'] = Date.now();
    atomicWriteJson(HEARTBEATS, hb);
  } catch { /* best-effort; the durable heartbeat in data/ is the one the panel reads */ }
}

// ── IL BATTITO DUREVOLE DELLA CORSIA MANUALE ────────────────────────────────────────────────────────
// Scritto in fondo a OGNI giro — riuscito O fallito — con la stessa disciplina del battito di agent35:
// un ciclo andato in errore batte comunque, portando `lastError`, mentre un battito che SI FERMA è il
// vero segnale di morte. Se il battito si fermasse su un errore, ogni eccezione transitoria diventerebbe
// una cancellazione del libro.
//
// Porta anche cosa il ciclo ha VISTO, perché il guardiano e il pannello devono poter distinguere «vivo e
// fermo per prudenza» da «vivo e senza niente da fare»: gate e motivo dell'ultimo giro, quanti ordini
// c'erano a riposo, su quali mercati. Il 6 agosto quei campi avrebbero detto, a chiare lettere,
// `gate:null` con nove ordini sorvegliati e 216 skip consecutivi su TX-15.
let cicloManuale = 0;
function scriviBattitoManuale(res, errore) {
  const mercati = (res && Array.isArray(res.markets)) ? res.markets : [];
  const ordiniARiposo = mercati.reduce((a, m) => a + (Number.isFinite(m.considered) ? m.considered : 0), 0);
  try {
    atomicWriteJson(MANUAL_HB_FILE, {
      ts: Date.now(),
      cycle: cicloManuale,
      // Il ciclo ha girato davvero, oppure è uscito su un interruttore spento: due stati diversi, ed
      // entrambi sono vita. Il guardiano non legge questo campo — legge `ts` — ma chi guarda il pannello sì.
      ran: res ? res.ran === true : false,
      gate: res ? (res.gate || null) : null,
      reason: res ? (res.reason || null) : null,
      ordiniARiposo,
      marketIds: mercati.map((m) => m.marketId).filter(Boolean),
      // Il gate per mercato dell'ultimo giro: è qui che «skip-mid-stale su TX-15» diventa un fatto
      // leggibile da fuori invece di una riga di log fra centomila.
      gatePerMercato: mercati.filter((m) => m.gate).map((m) => ({ marketId: m.marketId, gate: m.gate })),
      lastError: errore ? (errore.message || String(errore)) : null,
      processo: 'agent40-manual-reprice',
    });
  } catch (e) { log('battito manuale NON scritto:', e && e.message ? e.message : String(e)); }
}

// Summarise a cycle in one line, and ONLY when something is worth saying. A watcher that logs "nothing
// happened" every 5 seconds buries the one line that matters.
let lastQuietGate = null;
function logCycle(res) {
  if (!res.ran) {
    // A steady-state "off" is normal; say it once per change of reason, not 12 times a minute.
    if (res.gate !== lastQuietGate) { log(`idle: ${res.gate} — ${res.reason}`); lastQuietGate = res.gate; }
    return;
  }
  lastQuietGate = null;
  const acted = res.actions.filter((a) => a.action === 'reprice');
  const skips = res.actions.filter((a) => a.action === 'skip');
  const totals = res.markets.reduce((t, m) => ({ considered: t.considered + m.considered, held: t.held + m.held }), { considered: 0, held: 0 });
  for (const m of res.markets) {
    if (m.gate) log(`market cid_${String(m.marketId).replace(/^0x/, '')}: ${m.gate} — ${m.reason}`);
  }
  for (const a of acted) {
    log(`${a.trigger === 'expiry-refresh' ? 'REFRESH' : 'REPRICE'} ${a.ok ? 'ok' : 'FAILED'} · ${a.trigger} · order ${a.orderId}`
      + ` · ${a.book.toUpperCase()} ${a.fromPrice} → ${a.toPrice} (size ${a.size})`
      + `${a.secondsToExpiry != null ? ` · ${a.secondsToExpiry}s to expiry` : ''}`
      // L'ESENZIONE DAL TETTO, DETTA DOVE SI GUARDA. Il tetto orario ferma i riprezzi discrezionali; un
      // rinnovo di scadenza passa comunque, altrimenti il tetto garantirebbe la morte dell'ordine invece
      // di proteggerlo. Se passa in esenzione, la riga lo dice — con i numeri su cui e' stato deciso.
      + `${a.capExemptRenewal ? ` · ESENTE DAL TETTO ORARIO (${a.repricesThisHour}/${a.maxPerHour} nell'ultima ora): un rinnovo bloccato e' una scadenza garantita` : ''}`
      + `${a.sent ? ' · SENT to venue' : ' · not sent (dry-run)'}`
      + `${a.ok ? '' : ` · gate=${a.gate} ${a.reason || ''}`}`);
  }
  for (const a of res.actions.filter((x) => x.action === 'reconnect-cancel')) {
    log(`RECONNECT-CANCEL ${a.ok ? 'ok' : 'FAILED'} · order ${a.orderId}${a.reason ? ` · ${a.reason}` : ''}`);
  }
  // Skips that are not the routine "waiting for confirmation" deserve a line — they are the automatism
  // declining to act on something it saw.
  for (const s of skips) if (s.gate !== 'awaiting-confirmation') log(`skip · order ${s.orderId} · ${s.gate}: ${s.reason}`);
  if (acted.length === 0 && skips.length === 0 && totals.considered > 0) {
    // The steady state the whole feature exists to produce: orders resting, untouched, in band.
    //
    // CON I NUMERI. Fino al 5 agosto 2026 questa riga era «holding 2/2 in band» e basta: a posteriori
    // non si poteva dire quale fosse il mid, quanta distanza avesse l'ordine, ne' quanto margine
    // restasse prima del bordo premiante — ed e' precisamente il buco che ha reso impossibile
    // verificare da soli se gli ordini su TX-15 stessero maturando premi. I valori arrivano da
    // `m.holds`, la fotografia che la decisione stessa ha lasciato: non sono ricalcolati qui.
    //
    // Resta UNA riga per ciclo (~5s). Le gambe oltre la quarta diventano un contatore, perche' con
    // molti mercati aperti la riga diventerebbe illeggibile invece che informativa.
    const holds = res.markets.flatMap((m) => m.holds || []);
    const c2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '?');
    const dettaglio = holds.slice(0, 4).map((h) => `${h.book.toUpperCase()} ${h.price}`
      + ` mid ${Number.isFinite(h.scoringMid) ? h.scoringMid.toFixed(4) : '?'}`
      + ` d ${c2(h.distanceC)}¢/±${c2(h.bandRadiusC)}¢ margine ${c2(h.marginC)}¢`
      // PERCHE' QUESTA GAMBA NON SI MUOVE, quando la ragione e' il conflitto fra inseguimento e «mai
      // primi». Nel registro durevole la transizione ha una riga sua; qui il numero c'e' a ogni ciclo,
      // perche' chi guarda il processo girare non deve dover cercare altrove.
      + (h.inseguimentoSoppresso
        ? ` · INSEGUIMENTO SOPPRESSO: chiedeva ${h.inseguimentoPrezzo} (${c2(h.inseguimentoDistanzaC)}¢), «mai primi» impone ${h.maiPrimoPrezzo} (${c2(h.maiPrimoDistanzaC)}¢, dietro ${h.bestOther}) — piu' vicino al mid, quindi meglio`
        : '')).join(' · ');
    const eta = holds.map((h) => h.midAgeSec).filter(Number.isFinite);
    log(`holding ${totals.held}/${totals.considered} order(s) in band — nothing touched`
      + (dettaglio ? ` · ${dettaglio}` : '')
      + (holds.length > 4 ? ` · +${holds.length - 4} altre` : '')
      + (eta.length ? ` · mid ${Math.max(...eta)}s` : ''));
  }
}

// Deliberately NOT inside cycle(): the reprice cycle returns early on a kill, on a disabled switch and on
// a market handed back to the engine, and none of those should stop the ledger from being told the truth.
// This places nothing and cancels nothing — it reads the venue and writes resolutions to our own ledger —
// so a killed system is exactly when it is most worth running.
// ── RESTITUISCE SE HA GIRATO IN QUESTO GIRO ───────────────────────────────────────────────────────
// Serve a chi deve girare SUBITO DOPO. Prima quel «subito dopo» si deduceva da
// `Date.now() - lastReconcileAt < 1000`, cioè si INDOVINAVA guardando l'orologio: un proxy che regge
// solo finché la riconciliazione dura meno di un secondo. Misurato il 5 agosto 2026: quando ha
// davvero lavoro la sola prima chiamata al venue impiega 3948 ms. Restituire il fatto invece di
// dedurlo dal tempo toglie la dipendenza dalla latenza.
async function reconcileTask() {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_EVERY_MS) return false;
  lastReconcileAt = now;
  try {
    const r = await reconcileManualLane({ now });
    // Silent in the steady state. A watcher that logs "nothing to do" every minute buries the one line
    // that matters — and here that line is "we just retired a phantom from the risk ledger".
    if (r.ran && (r.nofills > 0 || r.fills > 0)) {
      log(`reconcile: ${r.fills} risolti come eseguiti, ${r.nofills} come NON eseguiti`
        + `${r.resolvedUsd ? ` (${r.resolvedUsd} $ di esposizione fantasma ritirata dal gate cap)` : ''}`
        + `${r.stillUnknown ? `, ${r.stillUnknown} ancora sconosciuti` : ''} — ${r.reason}`);
    } else if (r.ran && r.stillUnknown > 0) {
      log(`reconcile: ${r.stillUnknown} ordini inviati restano irrisolti — ${r.reason}`);
    } else if (!r.ran && r.checked > 0) {
      log(`reconcile: ${r.checked} ordini da risolvere ma non è stato possibile — ${r.reason}`);
    }
  } catch (e) {
    log('reconcile failed:', e && e.message ? e.message : String(e));
  }

  // ── I PRE-ESISTENTI SI SVUOTANO DA SOLI ──────────────────────────────────────────────────────
  // Uno che il venue non elenca piu' e' scaduto, eseguito o tolto a mano: esce dal deposito. Se non
  // uscisse, il suo id resterebbe li' per sempre. Try/catch suo: una potatura mancata non deve poter
  // fermare la riconciliazione, e al giro dopo si ritenta.
  try {
    const listed = await listManualOrders({ marketId: null });
    const p = potaPreesistenti({ listed, now: Date.now() });
    if (p.potata && p.rimossi.length) {
      log(`PRE-ESISTENTI · ${p.rimossi.length} non sono piu' sul venue (scaduti, eseguiti o tolti a mano):`
        + ` escono dal deposito, ne restano ${p.restano}.`
        + ' Se erano ESEGUITI la posizione che ne nasce e\' gestita normalmente: l\'invisibilita\' vale per gli ordini, non per il capitale in posizione.');
    }
  } catch (e) { log('potatura dei pre-esistenti fallita:', e && e.message ? e.message : String(e)); }

  return true;
}

// The closer shares the reconciliation's throttle: both only learn anything by asking the venue, and a
// position cannot be covered before the fill that created it has been observed. Its own try/catch, so a
// failure here cannot stop the reconciliation or the reprice cycle.
// ── LO SNAPSHOT DELLE POSIZIONI NON DIPENDE PIÙ DALL'USCITA AUTOMATICA ─────────────────────────────
// Era scritto DENTRO `readPositions` della chiusura automatica, cioè dopo il `return` che salta tutto
// quando nessun mercato ha l'uscita accesa. Il guaio è che quello snapshot non serve solo alla
// chiusura: `lib/safety/risk-limits.js` lo legge per calcolare l'esposizione, e se ha più di 180
// secondi RIFIUTA OGNI PIAZZAMENTO con `venue-positions-unreadable`.
//
// Cioè: «nessun mercato ha l'uscita automatica» diventava silenziosamente «il sistema non piazza più
// niente», per una catena che non è ovvia in nessuno dei due file. Il 4 agosto 2026 reggeva solo
// perché tre mercati morti tenevano acceso l'auto-close: ripulendoli senza accorgersene, il conteggio
// sarebbe andato a zero e ogni ordine sarebbe stato rifiutato per un motivo che non c'entra niente.
//
// Adesso la lettura del venue è un compito suo, sullo stesso ritmo della riconciliazione (60s, ben
// sotto i 180 di scadenza) e SENZA condizioni. La chiusura automatica la riusa invece di rifarla: la
// cache brevissima qui sotto evita di chiedere due volte al venue nello stesso giro.
// ── L'ALLARME DELL'ORDINE ORFANO, E LA CODA CHE NE ESCE ────────────────────────────────────────────
// `registroOrfani` tiene, per mercato, l'istante della PRIMA osservazione «una gamba sola e zero
// posizioni». Sta in memoria e non su disco DI PROPOSITO: e' un allarme che deve poter ripartire da zero
// a ogni riavvio, esattamente come l'orologio del mid stantio. Un armamento sopravvissuto a un riavvio
// varrebbe «confermato» su un'osservazione che questo processo non ha mai fatto, e la conferma esiste
// proprio per non cancellare su informazione che non abbiamo.
const registroOrfani = (() => {
  const m = new Map();
  return {
    leggi: (k) => (m.has(k) ? m.get(k) : null),
    scrivi: (k, v) => m.set(k, v),
    pulisci: (k) => m.delete(k),
  };
})();

// I mercati la cui gamba orfana e' stata cancellata dal ciclo di riprezzo e che vanno rimessi in
// pianificazione. Il riposizionamento NON si fa nel ciclo di riprezzo — non ha mai aperto esposizione e
// non deve cominciare adesso: la coda viene consegnata al ciclo di chiusura, che il riposizionamento lo
// sa gia' fare (Lavoro B, `capitalePerRiposizionamento` + tetto in vigore).
const daRipianificareCoda = new Map();

const POSIZIONI_FRESCHE_MS = 5_000;
let ultimePosizioni = { at: 0, res: null };

async function leggiPosizioniVenue() {
  const now = Date.now();
  if (ultimePosizioni.res && now - ultimePosizioni.at < POSIZIONI_FRESCHE_MS) return ultimePosizioni.res;
  const address = venueAccountAddress(resolveFunder(process.env), null);
  const p = await fetchVenuePositions({ address });
  // ── LE POSIZIONI VERE VANNO A CHI CALCOLA I TETTI ──────────────────────────────────────────────
  // Questa è la STESSA lettura che alimenta l'uscita automatica: una sola fonte di verità. Chiude il
  // buco del 4 agosto, quando il ledger locale diceva $0 mentre al venue c'erano 199,99 share e il
  // tetto di esposizione non le vedeva.
  try {
    const w = writeVenuePositions(p);
    if (!w.written) {
      // ── IL 429 SI RICONOSCE, E SI DICE ────────────────────────────────────────────────────────
      // «Il venue ci sta limitando» e «il venue e' caduto» portano entrambi a uno snapshot vecchio, ma
      // sono due diagnosi diverse: il primo si risolve aspettando, il secondo no. `fetchVenuePositions`
      // ora classifica, e qui il tipo finisce nel log invece di essere schiacciato in «non aggiornato».
      log(`snapshot posizioni NON aggiornato: ${w.reason}`
        + (p && p.tipo ? ` · causa: ${p.tipo}${p.tentativi ? ` dopo ${p.tentativi} tentativi con backoff` : ''}` : ''));
    }
  } catch (e) { log('snapshot posizioni fallito:', e && e.message ? e.message : String(e)); }
  ultimePosizioni = { at: now, res: p };
  return p;
}

// ── L'ULTIMO TENTATIVO PRIMA CHE UN PIAZZAMENTO VENGA RIFIUTATO PER SNAPSHOT VECCHIO ──────────────
// Sopra i 180 s ogni piazzamento viene rifiutato. La soglia NON si allarga — e' la protezione che
// impedisce di piazzare su una fotografia vecchia delle posizioni — ma prima di arrendersi si prova a
// RIFARE la fotografia, saltando la cache dei 5 secondi (che qui sarebbe proprio il dato stantio).
// Se non riesce, il rifiuto arriva identico a prima.
async function posizioniFrescheOFallisci() {
  return readVenuePositionsConRefresh({
    refresh: async () => { ultimePosizioni = { at: 0, res: null }; await leggiPosizioniVenue(); },
  });
}

// ── LO SNAPSHOT HA IL SUO OROLOGIO, E NON LO PRENDE IN PRESTITO DA NESSUNO ────────────────────────
// Il compito era già «autonomo» nel nome e nel commento, ma nel ciclo veniva chiamato dietro
// `if (Date.now() - lastReconcileAt < 1000)` — la condizione della riga sotto, copiata insieme alla
// riga. Il commento diceva «senza condizioni» e il codice ne aveva una.
//
// La condizione regge solo finché la riconciliazione dura meno di un secondo, e lei dura poco SOLO nel
// caso in cui non ha niente da fare: `reconcileManualLane` esce prima di toccare la rete quando non ci
// sono ordini irrisolti. Appena ce n'è uno — cioè appena si comincia a piazzare davvero — fa tre
// chiamate al venue in fila. Misurata il 5 agosto 2026: la prima da sola, 3948 ms.
//
// Quindi l'effetto non era «ogni tanto salta»: era che lo snapshot smetteva di essere scritto ESATTAMENTE
// quando si inizia a operare, e dopo 180 secondi il gate di esposizione rifiutava ogni piazzamento. Un
// guasto che non si può incontrare provando, solo usando.
//
// Ora la cadenza è sua: 60 secondi, un terzo della scadenza. E se una lettura fallisce si riprova dopo
// 15 invece di aspettarne altri 60 — dentro i 180 secondi di budget ci stanno una decina di tentativi
// invece di due. Fallire non è la stessa cosa che rinunciare.
const SNAPSHOT_EVERY_MS = 60_000;
const SNAPSHOT_RETRY_MS = 15_000;
let lastSnapshotAt = 0;
let ultimoSnapshotOk = false;

/** Il compito autonomo: aggiorna lo snapshot comunque, anche senza un solo mercato con uscita accesa. */
async function snapshotPosizioniTask() {
  const now = Date.now();
  if (now - lastSnapshotAt < (ultimoSnapshotOk ? SNAPSHOT_EVERY_MS : SNAPSHOT_RETRY_MS)) {
    return { girato: false };
  }
  lastSnapshotAt = now;
  const p = await leggiPosizioniVenue();
  const ok = !!(p && p.ok);
  // Un fallimento si dice UNA volta, non a ogni giro: un log che si ripete ogni minuto seppellisce la
  // riga che conta. Ma il passaggio da «va» a «non va» e viceversa si dice sempre.
  if (ok !== ultimoSnapshotOk) {
    log(ok ? 'snapshot posizioni: lettura del venue tornata a funzionare'
      : `snapshot posizioni: lettura del venue NON riuscita (${(p && p.reason) || 'motivo ignoto'}) — lo snapshot invecchia, e oltre 180s ogni piazzamento verrà rifiutato`);
  }
  ultimoSnapshotOk = ok;
  return { girato: true, ok };
}

// ── IL REGISTRO DELLE ATTESE DEL LIVELLO 2 (merge) ────────────────────────────────────────────────
// Quando il Livello 2 mette l'ordine di completamento sul secondo lato, parte un orologio di 60 minuti;
// scaduto quello si ripiega sul Livello 3. L'orologio deve stare su DISCO: in memoria si azzererebbe a
// ogni riavvio di questo processo, e un timeout che riparte da zero a ogni riavvio non scade mai.
//
// File minuscolo, una chiave per posizione (`${marketId}:${tokenId}`). Ogni lettura fallita vale
// «nessuna attesa in corso», che e' la direzione sicura: auto-close, senza attesa registrata e con un
// ordine di completamento gia' a riposo, non ne piazza un secondo — perche' senza registro il ramo del
// merge non parte affatto (fail-closed esplicito in auto-close.js).
const MERGE_WAIT_FILE = path.join(__dirname, '..', 'data', 'merge-attese.json');

function registroAttesaMerge() {
  const leggiTutto = () => {
    try {
      const raw = fs.readFileSync(MERGE_WAIT_FILE, 'utf8');
      const j = JSON.parse(raw);
      return j && typeof j === 'object' && j.attese && typeof j.attese === 'object' ? j.attese : {};
    } catch { return {}; }
  };
  const scriviTutto = (attese) => {
    // Scrittura atomica: un file mezzo scritto e' un registro illeggibile, e un registro illeggibile
    // spegne il merge (fail-closed) invece di lasciarlo in uno stato ambiguo.
    const tmp = `${MERGE_WAIT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ atIso: new Date().toISOString(), attese }, null, 1));
    fs.renameSync(tmp, MERGE_WAIT_FILE);
  };
  return {
    // Esposte per la pulizia di un mercato morto: `pulisci` lavora su UNA chiave, e un mercato ne ha
    // una per lato. Vedi `maniPulizia`.
    leggiTutto, scriviTutto,
    leggi: (chiave) => {
      const a = leggiTutto()[String(chiave)];
      return a && Number.isFinite(Number(a.at)) ? a : null;
    },
    segna: (chiave, rec) => {
      const attese = leggiTutto();
      attese[String(chiave)] = { at: Number(rec && rec.at) || Date.now(), orderId: (rec && rec.orderId) || null,
        size: (rec && rec.size) || null, prezzo: (rec && rec.prezzo) || null, atIso: new Date(Number(rec && rec.at) || Date.now()).toISOString() };
      scriviTutto(attese);
    },
    pulisci: (chiave) => {
      const attese = leggiTutto();
      if (Object.prototype.hasOwnProperty.call(attese, String(chiave))) { delete attese[String(chiave)]; scriviTutto(attese); }
    },
  };
}

// ── IL REGISTRO DELLA MODALITA' CHIUSURA, SU DISCO ───────────────────────────────────────────────
// Stessa forma e stesse ragioni del registro delle attese qui sopra: `lib/maker/modalita-chiusura.js`
// e' PURO — prende un registro e ne restituisce uno nuovo — e la persistenza vive qui, dove gia' vivono
// le altre due (attese di merge, residui scoperti).
//
// PERCHE' SU DISCO E NON IN MEMORIA: il timestamp deve rispondere a «da quando questa coppia sta
// chiudendo», e il requisito dice esplicitamente «nessun limite di tempo». Un registro in memoria si
// azzererebbe a ogni `pm2 restart`, e dopo un riavvio una coppia in chiusura da sei ore risulterebbe
// entrata adesso — con la conseguenza pratica che il passo 2 ricancellerebbe (`nuova` tornerebbe true)
// e le regole di chiusura si spegnerebbero proprio mentre servono.
const CHIUSURA_FILE = path.join(__dirname, '..', 'data', 'modalita-chiusura.json');

function registroModalitaChiusura() {
  const leggiTutto = () => {
    try {
      const j = JSON.parse(fs.readFileSync(CHIUSURA_FILE, 'utf8'));
      return j && typeof j === 'object' && j.coppie && typeof j.coppie === 'object' ? j.coppie : {};
    } catch { return {}; }
  };
  const scriviTutto = (coppie) => {
    const tmp = `${CHIUSURA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ atIso: new Date().toISOString(), coppie }, null, 1));
    fs.renameSync(tmp, CHIUSURA_FILE);
  };
  return {
    // Le due primitive sono esposte perche' la pulizia di un mercato morto deve poter togliere OGNI
    // voce di quel mercato in un colpo solo: `esci` lavora per (mercato, lato) e non basterebbe.
    leggiTutto, scriviTutto,
    leggi: (marketId, book) => MC.leggiChiusura(leggiTutto(), marketId, book),
    entra: (a) => {
      const r = MC.entraInChiusura({ ...a, registro: leggiTutto() });
      if (r.voce) scriviTutto(r.registro);
      return r;
    },
    attiva: (a) => {
      const r = MC.attivaRegole({ ...a, registro: leggiTutto() });
      if (r.attivate) scriviTutto(r.registro);
      return r;
    },
    esci: (a) => {
      const r = MC.esciDaChiusura({ ...a, registro: leggiTutto() });
      if (r.uscita) scriviTutto(r.registro);
      return r;
    },
    fase: (a) => {
      const r = MC.segnaFase({ ...a, registro: leggiTutto() });
      if (r.cambiata) scriviTutto(r.registro);
      return r;
    },
    // ── LA MEMORIA DELLA SORELLA (12 agosto 2026) ────────────────────────────────────────────────
    // «Avevo chiesto 100 share, ne ho piazzate 40»: senza questo, il ciclo che trova un completamento
    // gia' a riposo non ha modo di sapere che copre meno del bersaglio, e la posizione resta scoperta
    // per la differenza senza che nessun numero lo dica. Sta su DISCO come il resto del registro,
    // perche' il bersaglio deve sopravvivere a un `pm2 restart`: in memoria, dopo un riavvio, una
    // sorella da 40 su 100 sembrerebbe completa.
    registraSorella: (a) => {
      const r = MC.registraSorella({ ...a, registro: leggiTutto() });
      if (r.aggiornata) scriviTutto(r.registro);
      return r;
    },
  };
}

// ── LA PULIZIA DEI REGISTRI DI UN MERCATO MORTO (12 agosto 2026) ─────────────────────────────────
// `lib/maker/pulizia-mercato-chiuso.js` decide; qui vivono le sei MANI, perche' qui vive il disco.
// Ognuna e' chiusa sul suo registro e risponde `{ok, rimosso}`: `rimosso:false` vuol dire «non c'era
// niente di questo mercato», che e' un esito legittimo e non un fallimento.
//
// ⚠ NESSUNA DI QUESTE MANI CANCELLA UN AUDIT. Spariscono i registri di STATO CORRENTE; i giornali
// (`*-audit.jsonl`) restano intatti — «cancellare un audit non e' pulizia» e' gia' la regola di questo
// repo (§5 punto 63). E nessuna riscatta o vende: il redeem e' fuori perimetro per decisione
// dell'operatore, e una posizione su un mercato risolto continua a valere il suo esito.
function maniPulizia(regMerge, regChiusura) {
  const perMercato = (leggi, scrivi, appartiene) => (marketId) => {
    try {
      const reg = leggi() || {};
      const chiavi = Object.keys(reg).filter((k) => appartiene(k, reg[k], marketId));
      if (!chiavi.length) return { ok: true, rimosso: false };
      for (const k of chiavi) delete reg[k];
      scrivi(reg);
      return { ok: true, rimosso: true };
    } catch (e) { return { ok: false, motivo: e && e.message ? e.message : String(e) }; }
  };
  const id = (m) => String(m || '').toLowerCase();
  // Le chiavi dei due registri per coppia sono `<marketId>:<book>` (chiusura) e `<marketId>:<book>`
  // (attese di merge): si confronta il prefisso, non la chiave intera.
  const prefisso = (k, _v, m) => id(k).startsWith(`${id(m)}:`) || id(k) === id(m);
  return {
    attesaMerge: perMercato(regMerge.leggiTutto, regMerge.scriviTutto, prefisso),
    chiusura: perMercato(regChiusura.leggiTutto, regChiusura.scriviTutto, prefisso),
    residui: perMercato(
      () => { const r = leggiRegistroResidui(); return (r && r.residui) ? r.residui : {}; },
      (residui) => { scriviRegistroResidui({ residui }); },
      prefisso),
    // Il tetto e' l'unico che si riscrive PER INTERO, perche' `writeAllocatedCapital` sostituisce la
    // mappa: si rilegge, si toglie il mercato morto, si riscrive il resto. Una lettura non riuscita
    // NON produce una scrittura — riscrivere una mappa vuota toglierebbe il tetto a ogni mercato, e a
    // valle un tetto assente vale «nessuna esposizione nuova» ovunque (§5 punto 53).
    tetto: (marketId) => {
      try {
        const tutti = readAllocatedCapitalAll();
        if (!tutti || tutti.readable !== true) return { ok: false, motivo: `mappa dei tetti non leggibile: ${(tutti && tutti.error) || 'motivo ignoto'}` };
        const mappa = tutti.markets || {};
        if (!Object.keys(mappa).some((k) => id(k) === id(marketId))) return { ok: true, rimosso: false };
        const rows = Object.entries(mappa)
          .filter(([k]) => id(k) !== id(marketId))
          .map(([k, v]) => ({ marketId: k, capital: v && v.capitalUsd }));
        writeAllocatedCapital({ rows, capital: tutti.capital, by: 'agent40 · mercato chiuso' });
        return { ok: true, rimosso: true };
      } catch (e) { return { ok: false, motivo: e && e.message ? e.message : String(e) }; }
    },
    // Gestione manuale e uscita automatica NON si cancellano: si SPENGONO, con le stesse funzioni del
    // pannello e del reset. Sono registri con un audit proprio e una semantica di opt-in — toglierne
    // una riga a mano vorrebbe dire inventare un secondo formato per lo stesso stato.
    manuale: (marketId) => {
      try {
        if (!isManualMarket(marketId).manual) return { ok: true, rimosso: false };
        setManualMode({ marketId, manual: false, by: 'agent40 · mercato chiuso', reason: 'mercato risolto o annullato sul venue, libro libero' });
        return { ok: true, rimosso: true };
      } catch (e) { return { ok: false, motivo: e && e.message ? e.message : String(e) }; }
    },
    autoClose: (marketId) => {
      try {
        if (!isAutoCloseEnabled(marketId)) return { ok: true, rimosso: false };
        setAutoClose({ marketId, enabled: false, by: 'agent40 · mercato chiuso', reason: 'mercato risolto o annullato sul venue, libro libero' });
        return { ok: true, rimosso: true };
      } catch (e) { return { ok: false, motivo: e && e.message ? e.message : String(e) }; }
    },
  };
}

// Il board normalizzato: la stessa fonte che `resolveMarketRules` legge come prima scelta.
const BOARD_FILE = path.join(__dirname, '..', 'data', 'liquidity-rewards.json');

// ══ LA SCANSIONE DEI REGISTRI, OGNI 30 MINUTI E UNA VOLTA ALL'AVVIO ═════════════════════════════════
// La pulizia dei registri partiva solo da `auto-close`, che itera le POSIZIONI: un mercato morto SENZA
// posizione ma con voci residue non veniva mai visitato, e quelle voci restavano li' per sempre.
// Misurato il 12 agosto: **86 mercati orfani** — presenti nei registri, fuori dal board, senza posizione.
//
// `lib/maker/scansione-registri.js` decide; qui vivono le fonti, perche' qui vive il disco e la rete.
// Ogni fonte e' iniettata e ogni fallimento vale «non lo so», mai «non c'e' niente»: l'unica direzione
// in cui questa scansione puo' sbagliare senza fare danno e' esaminare MENO mercati di quanti dovrebbe.
const REGISTRI_DA_SCANDIRE = [
  ['data/merge-attese.json', (j) => Object.keys(j.attese || {})],
  ['data/residui-scoperti.json', (j) => Object.keys(j.residui || {})],
  ['data/residui-sotto-soglia.json', (j) => Object.keys(j.voci || j.residui || {})],
  ['data/modalita-chiusura.json', (j) => Object.keys(j.coppie || {})],
  ['data/maker-allocated-capital.json', (j) => Object.keys(j.markets || {})],
  ['data/maker-manual-mode.json', (j) => Object.keys(j.markets || j.marketIds || {})],
  ['data/maker-auto-close.json', (j) => (j.enabledMarketIds || Object.keys(j.markets || {}))],
];

/** Tutti i mercati NOMINATI dai registri operativi. Le chiavi per coppia sono `<marketId>:<book>`. */
function mercatiNeiRegistri() {
  const out = new Set();
  for (const [rel, estrai] of REGISTRI_DA_SCANDIRE) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
      for (const k of estrai(j) || []) {
        const id = String(k || '').split(':')[0].toLowerCase();
        if (id) out.add(id);
      }
    } catch { /* un registro assente o rotto contribuisce zero: non si conclude niente su di lui */ }
  }
  return [...out];
}

/** I mercati che il board conosce adesso. Board illeggibile ⇒ `null`, e allora si interroga tutto. */
function mercatiSulBoard() {
  try {
    const j = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    const righe = Array.isArray(j) ? j : (Array.isArray(j.markets) ? j.markets : []);
    const s = new Set();
    for (const r of righe) { const id = String((r && (r.conditionId || r.marketId)) || '').toLowerCase(); if (id) s.add(id); }
    return s;
  } catch { return null; }
}

let ultimaScansione = 0;
async function scansioneRegistri({ forzata = false } = {}) {
  const SR = require('../lib/maker/scansione-registri');
  const now = Date.now();
  if (!forzata && now - ultimaScansione < SR.CADENZA_MS) return null;
  ultimaScansione = now;

  // ── GLI ORDINI SI LEGGONO UNA VOLTA SOLA, non uno per mercato ──────────────────────────────────
  // Una lettura per mercato su ~90 mercati sarebbe novanta richieste per una scansione di manutenzione.
  // Si legge tutto e si raggruppa; se la lettura fallisce, `perMercato` resta `null` e NESSUN mercato
  // risulta a libro libero — cioe' non si pulisce niente, che e' il verso giusto.
  let perMercato = null;
  try {
    const l = await listManualOrders({ marketId: null });
    const righe = (l && Array.isArray(l.orders)) ? l.orders : null;
    if (righe) {
      perMercato = new Map();
      for (const o of righe) {
        const id = String((o && (o.marketId || o.conditionId)) || '').toLowerCase();
        if (id) perMercato.set(id, (perMercato.get(id) || 0) + 1);
      }
    }
  } catch { perMercato = null; }

  const board = mercatiSulBoard();
  // Qui si USA l'ultimo tentativo: la scansione puo' permettersi di aspettare un refresh, e uno
  // snapshot illeggibile le farebbe saltare tutti i mercati con posizione — cioe' esaminare meno di
  // quanto dovrebbe. Se il refresh non riesce, si prosegue con `posizioni: null`, che e' dichiarato.
  const snap = await posizioniFrescheOFallisci();
  if (snap && snap.rinfrescato) log(`scansione registri · snapshot posizioni: ${snap.motivoRefresh}`);
  const posizioni = (snap && snap.readable === true)
    ? (snap.positions || []).map((p) => ({ marketId: String(p.conditionId || p.marketId || '').toLowerCase() })).filter((x) => x.marketId)
    : null;

  const regMerge = registroAttesaMerge();
  const regChi = registroModalitaChiusura();
  const esito = await SR.scansiona({
    posizioni,
    ordini: perMercato ? [...perMercato.keys()].map((m) => ({ marketId: m })) : null,
    registri: mercatiNeiRegistri(),
    suBoard: board ? (id) => board.has(id) : null,
    statoVenue: async (id) => { try { return leggiVenueClob({ marketId: id }); } catch { return null; } },
    // `null` (lettura fallita) NON diventa 0: un mercato senza voce nella mappa ha zero ordini SOLO se
    // la mappa esiste.
    ordiniDelMercato: async (id) => (perMercato ? (perMercato.get(id) || 0) : null),
    maniRegistri: maniPulizia(regMerge, regChi),
  });

  log(`scansione registri: ${esito.esaminati} mercati nell'unione`
    + ` (${esito.unione.daPosizioni} da posizioni, ${esito.unione.daOrdini} da ordini, ${esito.unione.daRegistri} dai registri`
    + `, di cui ${esito.unione.soloRegistri.length} SOLO nei registri)`
    + ` · ${esito.interrogati} interrogati al venue · ${esito.morti} morti · ${esito.puliti} ripuliti`
    + (esito.unione.fontiNonLette.length ? ` · ⚠ fonti non lette: ${esito.unione.fontiNonLette.join(', ')}` : ''));
  return esito;
}

// ── LA SCADENZA DI UN MERCATO, PER IL PASSO 5 ────────────────────────────────────────────────────
// `resolveMarketRules` non porta `endDate` (verificato leggendo il suo `return`: readable, tick, banda,
// minSize, i due token, i book — e nient'altro), quindi la scadenza si legge dal board, che e' la
// stessa fonte da cui il mercato e' stato scelto.
//
// FAIL-CLOSED, E LA DIFFERENZA FRA I DUE «NON SO» CONTA: se il board non e' leggibile o il mercato non
// c'e' piu', si restituisce `null` — e `validoPerRipianificare` lo tratta come «non si ripianifica».
// E' la direzione giusta: qui si aprono due ordini NUOVI, e §5 punto 44 e' la storia di cosa costa
// aprire liquidita' su un mercato di cui non si conoscono piu' le proprieta'.
function scadenzaMercato(marketId) {
  const id = String(marketId).toLowerCase();
  const daRiga = (r) => {
    if (!r) return null;
    const t = Date.parse(r.endDate || r.endDateIso || r.end_date_iso || r.endDateUtc || '');
    return Number.isFinite(t) ? t : null;
  };
  // ── PRIMA IL BOARD: e' la fonte piu' fresca ────────────────────────────────────────────────────
  try {
    const j = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    const righe = Array.isArray(j) ? j : (Array.isArray(j.markets) ? j.markets : []);
    const t = daRiga(righe.find((x) => String((x && (x.conditionId || x.marketId || x.id)) || '').toLowerCase() === id));
    if (t != null) return t;
  } catch { /* board illeggibile: si prova il ripiego */ }

  // ══ E POI IL CATALOGO DI RIPIEGO — LA META' CHE MANCAVA (12 agosto 2026) ═══════════════════════
  // ⚠ IL DIFETTO: questa funzione leggeva SOLO il board, e il board tiene i primi 150 mercati per
  // montepremi. Un mercato che ne esce — per rotazione o perche' si sta avvicinando alla risoluzione,
  // che e' proprio il caso di cui parliamo — restituiva `null`, e `chiusuraForzataPreScadenza` con una
  // scadenza `null` risponde `forza:false`. Cioe' la regola «entro 3 ore si chiude a qualunque prezzo»
  // si spegneva esattamente sui mercati che stanno per risolvere e non sono piu' sul tabellone.
  //
  // Vale la REGOLA DI COPERTURA di questo repo — «board ∪ mercati con posizione, mai solo board» —
  // gia' applicata al gate live-min (§5 punto 69), alla sottoscrizione del book (61), alla
  // composizione del board (52) e alla lista dell'uscita automatica (55). Qui la seconda meta' e' il
  // CATALOGO DI RIPIEGO (`maker-manual-markets.json`), che agent41 riempie con le regole del mercato
  // — scadenza compresa — MENTRE quel mercato era nel piano (§5 punti 44 e 47). E' esattamente la
  // fonte pensata per «il board non lo conosce piu', ma noi ci abbiamo dentro del capitale».
  //
  // ORDINE: board prima, ripiego dopo. Il board e' piu' fresco; il ripiego e' una copia del momento in
  // cui il mercato era ancora nel piano, e va usato solo quando la prima fonte tace.
  try {
    const cat = readMarketCatalog();
    const m = cat && cat.markets ? cat.markets[id] : null;
    const t = daRiga(m);
    if (t != null) return t;
  } catch { /* nemmeno il ripiego: si dichiara `null`, e la chiusura forzata non scatta */ }

  return null;
}

async function closeTask() {
  try {
    const cfg = readAutoCloseConfig();
    // ── DOVE ABBIAMO CAPITALE SI PASSA COMUNQUE, ANCHE SE L'USCITA È SPENTA ───────────────────────
    // `runAutoCloseCycle` itera SOLO i mercati che riceve, e fino all'11 agosto 2026 riceveva la sola
    // allowlist dell'uscita automatica. Il reset la spegne sui mercati fuori dal piano quando NON
    // hanno una posizione — corretto — ma un ordine risparmiato dalla cancellazione (manuale o di
    // origine ignota) può riempirsi DOPO: nasce una posizione su un mercato la cui uscita è già
    // spenta, e nessun ciclo la visita più. Niente uscita, niente merge, niente registro dei residui.
    //
    // La lista si unisce con `liveMinMarketIds` — la STESSA funzione già in servizio nel gate live-min
    // (§5 punto 69), nella sottoscrizione del book (punto 61) e nella composizione del board: quattro
    // punti, una definizione. Contiene «abilitati al riprezzo ∪ mercati con posizione aperta», quindi
    // include per costruzione ogni mercato dove il capitale è esposto.
    //
    // NON ALLARGA IL RISCHIO: un giro di auto-close su un mercato senza posizione non fa niente (esce
    // con `skip-no-position`), il gate della gestione manuale resta davanti, e ogni ordine che ne
    // nascesse passa dagli stessi cancelli di sempre. Fail-closed: configurazione del riprezzo
    // illeggibile ⇒ lista vuota ⇒ comportamento identico a prima.
    let daPosizione = [];
    try {
      const rp = readAutoRepriceConfig();
      if (rp && rp.readable === true) daPosizione = rp.liveMinMarketIds || [];
    } catch (_) { daPosizione = []; }
    const visitare = [...new Set([...(cfg.readable ? cfg.enabledMarketIds : []), ...daPosizione]
      .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
    if (!visitare.length) return;   // OFF: silent — lo snapshot lo tiene vivo snapshotPosizioniTask
    // Il saldo del giro: UNA lettura per ciclo, come gia' fa il ciclo di riprezzo. Serve al
    // riposizionamento post-fill, che deve dimensionarsi su quanto c'e' DAVVERO adesso e non sul
    // capitale appena fuso. Se la lettura non e' affidabile si passa `null` piu' sotto.
    const saldoGiro = await saldoDelGiro();
    // I DUE REGISTRI SI COSTRUISCONO UNA VOLTA PER CICLO, non due: `auto-close` li usa per il merge e
    // per la modalita' chiusura, e la pulizia di un mercato morto deve toccare gli STESSI oggetti —
    // due istanze scriverebbero lo stesso file da due letture diverse.
    const regMergeCiclo = registroAttesaMerge();
    const regChiusuraCiclo = registroModalitaChiusura();
    const res = await runAutoCloseCycle({
      marketIds: visitare,
      killStatus: () => killSwitch.killStatus(),
      isManual: (marketId) => isManualMarket(marketId),
      resolveRules: (marketId) => resolveMarketRules(marketId),
      // ── LA PROFONDITA' DELL'ALTRO LATO, per il Livello 1 del merge ──────────────────────────────
      // La STESSA funzione gia' iniettata nel ciclo mm-tracking (piu' sotto): una fonte sola, lo
      // snapshot di agent34. Senza questa riga `deps.readDepth` era undefined, `asksAltroLato` arrivava
      // sempre null e il Livello 1 non era nemmeno valutabile — si cadeva al Livello 2 a prescindere dal
      // prezzo vero del secondo lato. Vedi CLAUDE.md §5 punto 27.
      readDepth: (marketId) => resolveMarketDepth(marketId),
      // ── IL REGISTRO DELLE ATTESE DEL LIVELLO 2 ──────────────────────────────────────────────────
      // Su file e non in memoria: un'attesa di 60 minuti che si azzera a ogni riavvio del processo non
      // e' un timeout, e agent40 riavvia. auto-close resta puro — qui c'e' l'unica scrittura.
      attesaMerge: regMergeCiclo,
      // Il registro della MODALITA' CHIUSURA e la scadenza del mercato. Senza queste due dep
      // `auto-close` si comporta esattamente come prima: nessun timestamp, nessuna cancellazione del
      // residuo, nessuna esenzione da «mai primo» e nessun controllo di validita' al passo 5.
      chiusura: regChiusuraCiclo,
      scadenzaMercato,
      // ── LA PULIZIA DEI REGISTRI DI UN MERCATO MORTO (12 agosto 2026) ─────────────────────────────
      // `auto-close` la chiama sul ramo `market-closed`/`market-not-accepting`, cioe' quando il VENUE
      // dice che il mercato non c'e' piu' — che copre la risoluzione ordinaria e l'annullamento con la
      // stessa lettura, mentre l'orologio del mercato vede solo la scadenza nominale.
      //
      // NON CABLATA ⇒ COMPORTAMENTO DI PRIMA: quel ramo faceva `continue` e continua a farlo.
      pulisciMercatoChiuso: ({ marketId, causa, libroLibero }) => PULIZIA.pulisciRegistri({
        marketId, causa, libroLibero, registri: maniPulizia(regMergeCiclo, regChiusuraCiclo),
      }),
      // ── IL CANCELLATORE, CHE QUI NON C'ERA — E TRE PERCORSI LO ASPETTAVANO ───────────────────────
      // `auto-close` chiama `deps.cancelOrder` in tre punti, tutti e tre PRIMA di fare qualcosa di
      // irreversibile: la chiusura forzata a mercato (toglie l'uscita e la liquidita' prima di vendere
      // al bid), il timeout del Livello 2 (toglie il completamento prima di vendere) e — da oggi — il
      // completamento della coppia (toglie l'uscita prima di comprare l'altro lato). Senza questa
      // riga tutti e tre ricevevano `undefined`, che `typeof … === 'function'` traduce in `null`.
      //
      // Misurato l'8 agosto 2026: su Schwartzel FL-19 la chiusura forzata falliva con
      // `exit-cancel-failed` motivo «ignoto» ogni 60 secondi da oltre ventiquattro ore, e il Livello 1
      // — coppia a 98,8¢, cioe' conveniente — restava irraggiungibile perche' quel ramo non arrivava
      // mai in fondo. Le righe 797 e 919 lo iniettavano gia', ma sono il ciclo di riprezzo e quello di
      // mm-tracking: percorsi diversi, che non passano da `closeTask`.
      //
      // E' la STESSA funzione degli altri due cicli, con la sua etichetta di origine: una cancellazione
      // riduce esposizione e non e' mai vincolata alla allowlist, quindi non apre nessuna superficie
      // nuova — toglie soltanto il caso in cui «non ho potuto togliere l'ordine» era indistinguibile da
      // «non ho nemmeno provato».
      // ── IL REGISTRO DEI LATI SCOPERTI SOTTO IL MINIMO (regola generale del 9 agosto 2026, punto 3) ──
      // `auto-close` resta puro: chiama questa funzione e non sa che esiste un file. Qui c'e' l'unica
      // scrittura. Read-modify-write a ogni osservazione invece di un accumulo in memoria: le
      // osservazioni sono poche (solo i mercati che arrivano alla rinuncia, non tutti) e il file e'
      // minuscolo, mentre un accumulo in memoria andrebbe svuotato a fine ciclo — un secondo momento in
      // cui sbagliare, per risparmiare una scrittura che non pesa.
      registraResiduo: ({ marketId, book, sizeScoperta, minSize, causa, prezzoCarico, t0: quando }) => {
        const prima = leggiRegistroResidui();
        const { registro: potato } = potaScadute(prima, quando || Date.now());
        const r = registraResiduoScoperto({
          registro: potato, marketId, book, sizeScoperta, minSize, causa, prezzoCarico,
          now: quando || Date.now(),
        });
        if (!r.ok || r.azione === 'ignorato') return r;
        scriviRegistroResidui(r.registro);
        log(`residuo scoperto · cid_${String(marketId).replace(/^0x/, '').slice(0, 8)} ${String(book).toUpperCase()}: ${r.motivo}`);
        return r;
      },
      cancelOrder: (spec) => cancelManualOrder(spec, AUTO_CLOSE_SOURCE),
      listOrders: ({ marketId }) => listManualOrders({ marketId }),
      // La stessa lettura del compito dello snapshot, riusata: una fonte sola, e nessuna seconda
      // chiamata al venue nello stesso giro.
      readPositions: async () => {
        const p = await leggiPosizioniVenue();
        return { ok: p.ok, reason: p.reason, positions: (p.positions || []).map((x) => ({ tokenId: String(x.asset ?? x.tokenId ?? ''), size: Number(x.size), avgPrice: Number(x.avgPrice) })) };
      },
      placeOrder: (spec) => placeManualOrder(spec),
      // ── LA GAMBA ESEGUITA TORNA SUL LIBRO ────────────────────────────────────────────────────
      // Subito dopo che l'uscita e' stata piazzata. Senza questa iniezione la decisione esiste ma non
      // viene mai presa: `decideRimpiazzo` era scritto e testato e non lo chiamava nessuno, e la
      // guardia `typeof deps.rimpiazzaGamba === 'function'` in auto-close era sempre falsa.
      //
      // Tre cose che questa funzione risolve da se', perche' auto-close non le ha e non deve averle:
      //   · l'OFFSET, dal registro per mercato (lib/maker/offset-config) — lo stesso che usa il riprezzo;
      //   · il TETTO del mercato, dal piano di allocazione corrente (lib/maker/allocated-capital);
      //   · gli ORDINI GIA' A RIPOSO su quel mercato, che occupano spazio sotto il tetto insieme alla
      //     posizione e all'uscita appena messa.
      rimpiazzaGamba: async ({ marketId, book, posizioneUsd, uscitaUsd }) => {
        const rules = resolveMarketRules(marketId);
        const off = resolveOffsetFor({ marketId, book, tick: rules && rules.tick });
        const tetto = readAllocatedCapital(marketId);

        // Il nozionale gia' a riposo su questo mercato. L'uscita appena piazzata puo' non essere ancora
        // visibile al venue, quindi la si somma a parte: contarla due volte stringerebbe il tetto, non
        // contarla affatto lo allargherebbe — e fra i due errori si sceglie il primo.
        let ordiniUsd = Number(uscitaUsd) || 0;
        try {
          const listed = await listManualOrders({ marketId });
          if (listed && listed.ok !== false) {
            for (const o of listed.orders || []) {
              if (o && o.source === 'manual-ui' && Number.isFinite(o.notionalUsd)) ordiniUsd += o.notionalUsd;
            }
          }
        } catch { /* illeggibile: resta il solo nozionale dell'uscita, che e' il piu' prudente noto */ }

        const d = decideRimpiazzo({
          book, rules,
          offsetCents: off && off.targetOffsetCents,
          tettoMercatoUsd: tetto && tetto.readable ? tetto.capUsd : null,
          posizioneUsd: Number(posizioneUsd) || 0,
          ordiniApertiUsd: ordiniUsd,
          minSizeShares: rules && rules.minSize,
        });
        if (d.action !== 'rimpiazza') return d;

        // Si piazza dalla STESSA porta di tutto il resto, con la regola della coda accesa: e' una
        // quotazione maker come le altre, non un'uscita. La sorgente resta quella dell'uscita
        // automatica perche' MANUAL_SOURCES e' un'allowlist di sicurezza che non vale la pena
        // allargare per un'etichetta — la nota dice cosa e'.
        const res = await placeManualOrder({
          marketId, book, side: 'BUY', price: d.price, size: d.size,
          inCoda: true, source: AUTO_CLOSE_SOURCE,
          note: `rimpiazzo della gamba ${book.toUpperCase()} eseguita: torna a riposo a ${d.price} x ${d.size}`,
        });
        return { ...d, ok: res && res.ok === true, sent: res && res.sent === true, gate: (res && res.gate) || d.gate };
      },
      // ── LE DUE LETTURE DEL RIPOSIZIONAMENTO POST-FILL (9 agosto 2026) ───────────────────────────
      // Senza queste due righe `capitalePerRiposizionamento` risponde `azione: 'niente'` e il punto (d)
      // resta scritto ma inerte: e' esattamente lo stato in cui il modulo e' stato consegnato, di
      // proposito, perche' cablarle e' cio' che lo ATTIVA su capitale reale.
      //
      // Stesso pattern del resto del file: si iniettano i VALORI letti qui, non i moduli. `auto-close`
      // resta puro e non sa da dove vengano — e i test lo guidano senza rete.
      //
      //   · `tettoMercato`  il tetto in vigore per QUEL mercato, dalla stessa `readAllocatedCapital`
      //     gia' usata dal rimpiazzo di gamba qui sopra (riga ~557). Non e' il piano salvato: e' la
      //     regola che vale ADESSO, ed e' la decisione presa dall'operatore il 9 agosto.
      //   · `capitaleLibero`  il saldo del giro, gia' letto UNA volta prima del ciclo. Si passa il
      //     numero solo se la lettura e' AFFIDABILE: un saldo stantio o illeggibile deve valere
      //     «non lo so» e non «zero», e a valle `null` fa fallire chiuso il riposizionamento invece di
      //     dimensionarlo su un dato vecchio. E' la stessa disciplina della Regola 5.
      // I mercati la cui gamba orfana e' stata cancellata dal ciclo di riprezzo. Si DRENA la coda
      // leggendola: un mercato consegnato una volta non deve tornare al giro dopo, altrimenti il
      // riposizionamento si ripeterebbe a ogni ciclo finche' qualcosa non lo toglie.
      mercatiDaRipianificare: () => {
        const v = Array.from(daRipianificareCoda.values());
        daRipianificareCoda.clear();
        return v;
      },
      tettoMercato: (marketId) => { try { return readAllocatedCapital(marketId); } catch { return null; } },
      capitaleLibero: () => (saldoGiro && saldoGiro.affidabile === true && Number.isFinite(saldoGiro.usd)
        ? saldoGiro.usd : null),
      audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    });
    for (const m of res.markets) if (m.gate && m.gate !== 'disabled') log(`auto-close cid_${String(m.marketId).replace(/^0x/, '')}: ${m.gate} — ${m.reason}`);
    for (const a of res.actions) {
      if (a.action === 'close') log(`AUTO-CLOSE ${a.ok ? 'ok' : 'FALLITA'} · ${a.book.toUpperCase()} SELL ${a.size} @ ${a.price} su carico ${a.entryPrice} (+${a.profitCents}c/share)${a.sent ? ' · INVIATA' : ' · non inviata (dry-run)'}${a.ok ? '' : ` · gate=${a.gate} ${a.reason || ''}`}`);
      else if (a.action === 'rimpiazzo') log(`RIMPIAZZO ${a.ok ? 'ok' : 'FALLITO'} · ${a.book.toUpperCase()} BUY ${a.size} @ ${a.price} — ${a.reason}`);
      else if (a.action === 'rimpiazzo-saltato') log(`rimpiazzo saltato · ${a.gate}: ${a.reason}`);
      else if (a.action === 'skip') log(`auto-close skip · ${a.gate}: ${a.reason}`);
    }
  } catch (e) {
    log('close task failed:', e && e.message ? e.message : String(e));
  }
}

// ── IL SALDO, LETTO UNA VOLTA PER GIRO DALLA CACHE ─────────────────────────────────────────────────
// La lettura vera va sulla catena al massimo ogni 45s (lib/maker/saldo-cache.js); qui si prende il
// valore PRIMA di entrare nel ciclo, cosi' tutti i mercati di quel giro giudicano con lo stesso saldo.
// `await` dentro il loop dei mercati avrebbe dato numeri diversi allo stesso giro.
let saldoPrecedente = null;
async function saldoDelGiro() {
  const s = await leggiSaldoUsd();
  const stato = `${s.affidabile ? 'ok' : 'NON affidabile'}·${s.fonte}`;
  if (stato !== saldoPrecedente) {
    log(s.affidabile
      ? `saldo funder: $${Number(s.usd).toFixed(2)} (${s.fonte}${s.etaMs != null ? `, ${Math.round(s.etaMs / 1000)}s` : ''}) — la Regola 5 ha il suo tetto`
      : `saldo funder NON leggibile (${s.motivo}) — la Regola 5 resta fail-closed: nessuna nuova esposizione`);
    saldoPrecedente = stato;
  }
  return s;
}

/** Il nozionale delle posizioni gia' aperte su un mercato, dallo snapshot che questo stesso processo scrive. */
function posizioniUsdDi(marketId) {
  const want = String(marketId || '').trim().toLowerCase();
  const snap = readVenuePositions();
  if (!snap || snap.readable !== true) {
    return { leggibile: false, usd: null, motivo: (snap && snap.reason) || 'snapshot delle posizioni non leggibile' };
  }
  let usd = 0;
  for (const p of snap.positions || []) {
    if (String(p && p.conditionId || '').trim().toLowerCase() !== want) continue;
    const size = Math.abs(Number(p.size));
    // Il capitale IMPEGNATO e' quello che e' uscito davvero, quindi il prezzo di carico e non quello
    // corrente: il tetto governa quanto ne abbiamo messo su un mercato, non quanto vale adesso.
    const px = Number(p.avgPrice);
    if (!Number.isFinite(size) || !Number.isFinite(px)) {
      return { leggibile: false, usd: null, motivo: 'una posizione senza size o prezzo di carico: il capitale impegnato non si sa contare' };
    }
    usd += size * px;
  }
  return { leggibile: true, usd: +usd.toFixed(4), motivo: null };
}

// ── LA FOTOGRAFIA DEI PRE-ESISTENTI ────────────────────────────────────────────────────────────────
// Si scatta in due momenti soli: all'AVVIO del processo, e quando il kill si SPEGNE (il riarmo). Non a
// ogni giro: una fotografia continua marcherebbe pre-esistente anche cio' che il bot ha appena piazzato,
// e il motore smetterebbe di gestire i propri stessi ordini un secondo dopo averli messi.
async function scattaFotografia(motivo) {
  let listed = null;
  try { listed = await listManualOrders({ marketId: null }); }
  catch (e) { listed = { ok: false, error: e && e.message ? e.message : String(e) }; }
  const f = fotografaPreesistenti({ listed, now: Date.now(), motivo });
  if (!f.scattata) { log(`PRE-ESISTENTI · nessuna fotografia (${motivo}): ${f.motivo}`); return f; }
  if (f.marcati === 0) { log(`PRE-ESISTENTI · ${motivo}: nessun ordine a riposo, il libro era libero — il ciclo gestisce tutto cio' che verra' piazzato da adesso.`); return f; }
  log(`PRE-ESISTENTI · ${motivo}: ${f.marcati} ordine/i gia' a riposo, da ora INVISIBILI al motore`
    + ' — non riprezzati, non rinnovati, non cancellati, fuori dal capitale impegnato. Scadranno da soli.');
  for (const o of f.ordini) {
    log(`  · ${o.orderId.slice(0, 12)}… cid_${String(o.marketId || '').replace(/^0x/, '').slice(0, 10)}`
      + ` · ${o.side} ${o.size} @ ${o.price}${o.orderType ? ` (${o.orderType})` : ''} · attribuzione ${o.source || 'ignota'}`);
  }
  log('  NOTA: essendo invisibili non vengono nemmeno SOTTRATTI dal book, quindi la profondita\' «altrui»'
    + ' li conta come di terzi. E\' la conseguenza voluta dell\'invisibilita\', e rende il motore piu\' timido, mai piu\' aggressivo.');
  return f;
}

// Il kill spento e' il riarmo: si rifotografa perche' nel frattempo il libro puo' essere cambiato sotto
// di noi (il KILL cancella tutto, ma una mano puo' aver piazzato qualcosa prima di riaccendere).
let killPrecedente = null;
async function fotografiaSuRiarmo() {
  let attivo = null;
  try { const k = killSwitch.killStatus(); attivo = k && (k.effectivelyKilled === true || k.readable === false); }
  catch { return; }
  if (killPrecedente === true && attivo === false) await scattaFotografia('kill spento: riarmo');
  killPrecedente = attivo;
}

// ══ LA CADENZA PER MERCATO — UNA SOLA MANO, DUE MOTORI ═══════════════════════════════════════════
// I due cicli (watcher reattivo e market making) condividono lo stesso registro di «quando ho guardato
// questo mercato l'ultima volta» e la stessa misura di velocità. Condividerlo non è un'ottimizzazione:
// se ognuno tenesse il suo, un mercato lento verrebbe comunque interrogato da entrambi a orologi
// diversi, e il risparmio di chiamate al venue — che è il punto — sparirebbe per metà.
//
// In memoria di proposito: è una cadenza, non uno stato di sicurezza. Dopo un riavvio ogni mercato
// viene guardato al primo giro (nessuna `ultimaValutazione` ⇒ si valuta), che è il verso giusto.
const ultimaValutazione = new Map();

/**
 * ── LA MAPPA DELLE VELOCITÀ DEL GIRO, LETTA UNA VOLTA SOLA (8 agosto 2026) ─────────────────────────
 *
 * Il difetto che chiude, misurato: `cadenzaPer` chiamava `leggiFinestraMercato` UNA VOLTA PER MERCATO,
 * e ogni chiamata rileggeva l'intero giornale del giorno costruendo la mappa di TUTTI i mercati per poi
 * restituirne uno. Tredici mercati = tredici letture identiche da 524 ms l'una = 6,8 s di CPU dentro un
 * ciclo da 5 s, cioè il 136% di un core, in crescita con il file e con azzeramento a mezzanotte.
 *
 * Adesso la mappa si costruisce UNA volta per giro e si consulta tredici volte. Insieme al seek
 * dimensionato sulla finestra (lib/rewards/velocita-mercato), il costo passa da 6.812 ms a 36 ms per
 * ciclo — misurato, non stimato.
 *
 * SE LA LETTURA FALLISCE si restituisce `null`, e `cadenzaPer` lo tratta come «velocità non
 * misurabile»: `decidiCadenza` risponde con la cadenza di DIFETTO, cioè si guarda il mercato più
 * spesso, non meno. È lo stesso verso prudente che aveva il try/catch di prima.
 */
function velocitaDelGiro() {
  try {
    const { FINESTRA_MIN } = require('../lib/maker/cadenza-adattiva');
    const { leggiFinestraTutti } = require('../lib/rewards/velocita-mercato');
    return leggiFinestraTutti({ windowMinutes: FINESTRA_MIN, minCampioni: 4 });
  } catch (e) {
    log('velocità del giro non misurata:', e && e.message ? e.message : String(e));
    return null;
  }
}

/**
 * ── LA LIQUIDITÀ MEDIA DEL GIRO, LETTA AL MASSIMO UNA VOLTA E SOLO SE SERVE ────────────────────────
 *
 * Stesso difetto della cadenza, in un punto meno battuto: `liquiditaMedia` chiedeva una finestra da
 * 240 MINUTI, una volta per mercato, e la chiede solo il percorso di riprezzo — quindi non compariva
 * nella misura del ciclo a vuoto, ma quando il bot lavora davvero costa più della cadenza.
 *
 * PIGRA di proposito: se in questo giro nessuno la chiede — il caso normale — non si legge niente.
 * Al primo che la chiede si legge UNA volta per tutti, e il resto del giro consulta la mappa.
 */
function memoLiquidita() {
  let mappa = null;
  let tentato = false;
  return {
    per(marketId) {
      if (!tentato) {
        tentato = true;
        try { mappa = require('../lib/rewards/velocita-mercato').leggiFinestraTutti({ windowMinutes: 240 }); }
        catch { mappa = null; }
      }
      const w = mappa && mappa.per ? mappa.per.get(marketId) : null;
      return { media: w && w.depthMedia != null ? w.depthMedia : null, campioni: (w && w.depthCampioni) || 0 };
    },
  };
}

// ── QUANDO IL FEED HA PUBBLICATO L'ULTIMO BOOK DI QUESTO MERCATO ────────────────────────────────
// Serve alla decisione «valuta adesso» della cadenza: `ageMs` è l'età che agent34 stampa nel proprio
// snapshot, quindi l'istante è `adesso − ageMs`. Non è un secondo orologio: è LO STESSO dato che il
// motore già usa per giudicare se il mid è fresco, letto una volta e riusato.
// Illeggibile ⇒ `null`, che vale «nessun evento» e riporta la cadenza al comportamento di prima.
// L'istante dell'ultimo book su cui si e' DECISO, per mercato. Vedi il blocco dentro `cadenzaPer`.
const ultimoBookValutato = new Map();

function cadenzaPer(marketId, difettoMs, mappa = null) {
  try {
    const { decidiCadenza, cadenzaAttiva, FINESTRA_MIN } = require('../lib/maker/cadenza-adattiva');
    const { leggiFinestraMercato, finestraVuota } = require('../lib/rewards/velocita-mercato');
    // La mappa del giro quando c'è; la lettura singola solo per chi chiama senza mappa (nessuno oggi
    // nel ciclo, ma la funzione resta usabile da sola senza cambiare comportamento).
    const misura = mappa && mappa.per
      ? (mappa.per.get(marketId) || finestraVuota(marketId, 'nessun campione per questo mercato nella finestra'))
      : leggiFinestraMercato({ marketId, windowMinutes: FINESTRA_MIN, minCampioni: 4 });
    let tickCents = 1;
    let bookMs = null;
    try {
      const r = resolveMarketRules(marketId);
      // ── IL CAMPO SI CHIAMA `tick`, NON `tickSize` — CORRETTO L'8 AGOSTO 2026, SERA ─────────────
      // Qui c'era `r.tickSize`, che `resolveMarketRules` non restituisce: la lettura dava sempre
      // `undefined`, quindi `tickCents` restava 1 per OGNI mercato e la misura finiva in
      // centesimi/ora invece che in tick/ora — cioe' proprio la normalizzazione che l'intestazione di
      // cadenza-adattiva dichiara di fare («quattro tick l'ora vuol dire la stessa cosa su un mercato
      // da 1¢ e su uno da 0,1¢»). Su un mercato a tick 0,1¢ la misura risultava dieci volte piu'
      // piccola del vero, quindi «lento» quando era veloce. Nessun test funzionale poteva vederlo: il
      // risultato era plausibile, solo sbagliato di un fattore.
      if (r && r.readable && Number.isFinite(r.tick) && r.tick > 0) tickCents = r.tick * 100;
      // L'ETA' DEL BOOK, dalla STESSA lettura: `feedAgeSec` e' l'eta' dello snapshot di agent34 per
      // questo mercato — la domanda giusta per «il feed ha parlato?» — con `midAgeSec` come ripiego.
      // Nessuna seconda lettura e nessun secondo orologio: se divergessero, «il mid e' fresco» e «il
      // feed ha parlato» potrebbero dire il contrario l'uno dell'altro.
      const eta = Number.isFinite(r && r.feedAgeSec) ? r.feedAgeSec
        : (Number.isFinite(r && r.midAgeSec) ? r.midAgeSec : null);
      if (Number.isFinite(eta) && eta >= 0) bookMs = Date.now() - eta * 1000;
    } catch { /* tick ignoto ⇒ 1¢; eta' ignota ⇒ nessun evento, cioe' il comportamento di prima */ }
    // ── LA DECISIONE SEGUE IL FEED, NON SOLO L'OROLOGIO ─────────────────────────────────────────
    // Il DATO era già live su tutti i mercati (agent34, invariato); la DECISIONE no: un mercato
    // classificato «lento» aspettava dieci secondi anche con il book appena cambiato. Adesso un book
    // nuovo fa valutare subito, su qualunque classe. Il freno sui veloci resta: `MIN_MS` (1s) è il
    // pavimento fra due valutazioni anche per gli eventi, e le soglie che decidono se RIPREZZARE
    // (`hysteresisTicks`, `confirmSamples`, `minIntervalMs`) non sono toccate — vedi cadenza-adattiva.
    const d = decidiCadenza({
      now: Date.now(), ultimaValutazioneMs: ultimaValutazione.get(marketId) ?? null,
      misura, tickCents, difettoMs, attiva: cadenzaAttiva(),
      bookAggiornatoMs: bookMs, bookValutatoMs: ultimoBookValutato.get(marketId) ?? null,
    });
    // Si ricorda l'istante del book SOLO quando si valuta davvero: altrimenti un evento verrebbe
    // consumato da un giro che non ha deciso niente, e quel movimento resterebbe non guardato.
    if (d.valuta && Number.isFinite(bookMs)) ultimoBookValutato.set(marketId, bookMs);
    return d;
  } catch (e) {
    // Una misura che esplode NON deve poter fermare un motore che sorveglia capitale reale: si guarda,
    // come si guardava prima che questa funzione esistesse.
    return { valuta: true, cadenzaMs: difettoMs, classe: 'errore', attesaMs: 0, motivo: e && e.message ? e.message : String(e) };
  }
}

async function cycle() {
  const saldo = await saldoDelGiro();
  // La mappa delle velocita' del giro: UNA lettura del giornale per ciclo, non una per mercato.
  // Vedi la nota su `velocitaDelGiro`. Si legge PRIMA del ciclo perche' la cadenza e' il primo gate
  // che ogni mercato incontra, e perche' cosi' tutti i mercati del giro vengono giudicati sullo
  // STESSO istante — prima ognuno aveva la sua finestra, spostata di qualche centinaio di ms.
  const velocita = velocitaDelGiro();
  // Pigra: costa zero nei giri in cui nessuno riprezza, che sono la stragrande maggioranza.
  const liquiditaGiro = memoLiquidita();
  await fotografiaSuRiarmo();
  // Gli id si rileggono UNA volta per giro e si passano al filtro: dentro il ciclo il filtro viene
  // chiamato una volta per mercato, e rileggere il file ogni volta sarebbe I/O per lo stesso fatto.
  const preesistentiOra = idsPreesistenti();
  const res = await runAutoRepriceCycle({
    // La cadenza adattiva: il difetto è l'orologio di questo motore (5s), e da lì si scende a 1s sui
    // mercati veloci e si sale a 10s su quelli fermi.
    cadenza: (marketId) => cadenzaPer(marketId, loadAutoRepriceTuning().pollMs, velocita),
    segnaValutazione: (marketId, t) => ultimaValutazione.set(marketId, t),
    killStatus: () => killSwitch.killStatus(),
    isManual: (marketId) => isManualMarket(marketId),
    listOrders: ({ marketId }) => listManualOrders({ marketId }),
    resolveRules: (marketId) => resolveMarketRules(marketId),
    replaceOrder: (spec) => replaceManualOrder(spec),
    // ── LA PROFONDITÀ, PER SAPERE SE SIAMO DIVENTATI I PRIMI ────────────────────────────────────
    // Senza questa riga il trigger «top-of-book» non potrebbe mai scattare: `decideReprice` lo salta
    // in silenzio quando `resolveDepth` non è una funzione. È la classe di difetto che
    // scripts/dipendenze-scollegate.js esiste per impedire — una decisione scritta e mai raggiunta.
    resolveDepth: (marketId) => resolveMarketDepth(marketId),
    // ── IL VETO DI PROFILO ────────────────────────────────────────────────────────────────────────
    // Due mani, non una logica: il ciclo chiede «che profilo ha questo mercato?» e «questo
    // piazzamento passa i controlli di quel profilo?». Entrambe le risposte vengono da moduli puri.
    // Il profilo si rilegge dal file a ogni giro: un mercato che cambia profilo fra due cicli viene
    // valutato con quello nuovo al ciclo successivo.
    // IL MOTORE UNICO: una sola valutazione, nessuna biforcazione per profilo.
    valutaMercato: (arg) => valutaMercato(arg),
    // ── I DUE INGRESSI DELLA REGOLA 5 (il tetto del 20% per mercato) ─────────────────────────────
    // Erano scollegati fino al 6 agosto 2026: la regola c'era, i numeri no, e falliva chiusa a ogni
    // giro con «saldo non leggibile». Il saldo e' quello letto una volta sola per questo giro; le
    // posizioni vengono dallo snapshot che questo stesso processo aggiorna, con la sua eta'.
    saldo: () => saldo,
    posizioniMercatoUsd: (marketId) => posizioniUsdDi(marketId),
    // IL FILTRO UNICO DEI PRE-ESISTENTI. Sta all'imbocco del ciclo, e da li' in giu' quegli ordini non
    // esistono per nessuna regola. Senza questa riga il filtro sarebbe scritto e mai raggiunto.
    filtraPreesistenti: (orders) => separaPreesistenti(orders, { ids: preesistentiOra }),
    // ── IL DENOMINATORE PULITO DEL PAVIMENTO ─────────────────────────────────────────────────────
    // Un campione ogni 45s per mercato, misurato con la STESSA `othersLadder` che produce il
    // numeratore: la profondita' ALTRUI in banda, in dollari. Vedi lib/maker/profondita-altrui.js per
    // il motivo per cui la misura sta qui e non nel giornale di agent34.
    campionaProfondita: ({ marketId, rules, ownOrders, now }) => campionaProfonditaAltrui({
      marketId, rules, ownOrders, now, depth: resolveMarketDepth(marketId),
    }),
    liquiditaAltrui: (marketId) => {
      try {
        const m = mediaProfonditaAltrui({ marketId });
        return { mediaUsd: m.mediaUsd, campioni: m.campioni };
      } catch { return { mediaUsd: null, campioni: 0 }; }
    },
    // La vecchia media dal giornale di agent34, TENUTA SOLO COME PARAGONE nell'audit
    // (`pavimentoLordoUsd`): somma il book pubblico, i nostri ordini compresi, quindi non puo' fare da
    // denominatore a un numeratore che li toglie. Non decide piu' nessun pavimento.
    liquiditaMedia: (marketId) => {
      try { return liquiditaGiro.per(marketId); }
      catch { return { media: null, campioni: 0 }; }
    },
    // Used ONLY by the reconnect-after-blackout path AND by the top-of-book cancel. It goes through the
    // CANCEL-ONLY adapter (address-only signer, structurally cannot place), so both can stop orders and
    // neither can ever start one.
    cancelOrder: (spec) => cancelManualOrder(spec, 'auto-reprice-band-exit'),
    // ── IL CONTROLLO DELL'ORDINE ORFANO ──────────────────────────────────────────────────────────
    // La STESSA lettura che usa la chiusura automatica (`leggiPosizioniVenue`, cache 5s condivisa nel
    // processo), non un secondo percorso: due letture delle posizioni potrebbero divergere, e qui la
    // divergenza deciderebbe una cancellazione. Viene chiamata solo quando un rinnovo GTD sta per
    // partire — al piu' ~3 volte l'ora per mercato — non a ogni giro del ciclo.
    readPositions: async () => {
      try { return { ok: true, positions: (await leggiPosizioniVenue()).positions || [] }; }
      catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; }
    },
    registroOrfani,
    // TOGLIERE UN MERCATO CHIUSO DALLA ALLOWLIST. Gemella di `disableTracking` qui sotto, sulla stessa
    // condizione e per lo stesso motivo: il motore decide QUANDO (solo a mercato risolto e a libro gia'
    // libero), qui si passa la mano che scrive. Senza questa riga la decisione esisterebbe e non la
    // prenderebbe nessuno — la guardia `typeof deps.disableMarket === 'function'` sarebbe sempre falsa,
    // che e' il difetto trovato quattro volte in una settimana e che scripts/dipendenze-scollegate.js
    // ora impedisce di lasciar passare.
    disableMarket: ({ marketId, reason }) => setAutoReprice({
      scope: 'market', marketId, enabled: false, by: 'motore · mercato chiuso', reason,
    }),
    audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    config: loadAutoRepriceTuning(),
    breaches,
    residuiSegnalati,
    conflittiSoppressi,
    ordiniVisti,
    link,
  });
  logCycle(res);

  // ── L'AVVISO ESCE DAL PROCESSO ────────────────────────────────────────────────────────────────
  // Il ciclo emette l'evento una volta sola per ordine; qui lo si mette dove si vede. Try/catch suo:
  // un file che non si scrive non deve poter fermare il motore che sorveglia gli ordini veri.
  const residui = (res.events || []).filter((e) => e.type === 'residuo-sotto-soglia');
  if (residui.length) {
    for (const e of residui) {
      log(`RESIDUO SOTTO SOGLIA · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)} · lato ${String(e.book).toUpperCase()}`
        + ` · restano ${e.sizeRemaining} share contro il minimo ${e.minSize}`
        + `${Number.isFinite(e.notionalUsd) ? ` · $${e.notionalUsd.toFixed(2)} fermi` : ''}`
        + `${e.secondsToExpiry != null ? ` · scade fra ${e.secondsToExpiry}s` : ''}`
        + ' — NON rinnovabile: l ordine si spegne da solo e quel capitale torna da riallocare.'
        + ' La posizione gia eseguita non viene toccata: segue la sua uscita.');
    }
    try {
      const w = registraResiduiSottoSoglia(residui);
      if (!w.ok) log(`avviso residui NON depositato (${w.reason}) — resta solo in questo log`);
    } catch (e) { log('avviso residui NON depositato:', e.message); }
  }

  // ── LA MORTE PER SCADENZA ESCE DAL PROCESSO ────────────────────────────────────────────────────
  // Stessa strada dell'avviso sui residui, e per lo stesso motivo: il 5 agosto la morte delle due gambe
  // di Barlow non ha prodotto un solo evento, e cinquecentoquaranta righe di log identiche non avevano
  // avvisato nessuno. Try/catch suo: un file che non si scrive non deve poter fermare il motore.
  const scadenze = (res.events || []).filter((e) => e.type === 'scaduto-senza-rinnovo');
  if (scadenze.length) {
    for (const e of scadenze) {
      log(`SCADUTO SENZA RINNOVO · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)}`
        + ` · ${String(e.book).toUpperCase()} ${e.side} ${e.price} x ${e.size}`
        + `${Number.isFinite(e.notionalUsd) ? ` · $${e.notionalUsd.toFixed(2)} tornati liberi` : ''}`
        + ` · scadenza prevista ${e.expiresAt}`
        + (e.bloccoGate
          ? ` · il rinnovo era DOVUTO e l ha fermato «${e.bloccoGate}»: ${e.bloccoReason}`
          : ' · nessun rinnovo e stato valutato prima della scadenza')
        + ' — l ordine non e piu sul book: quel capitale va rimesso in gioco.');
    }
    try {
      const w = registraScadenzeSenzaRinnovo(scadenze);
      if (!w.ok) log(`avviso scadenze NON depositato (${w.reason}) — resta solo in questo log`);
    } catch (e) { log('avviso scadenze NON depositato:', e.message); }
  }

  // ── LE CANCELLAZIONI DEL MOTORE, DOVE SI VEDONO ──────────────────────────────────────────────────
  // Stessa strada delle due sopra, e per lo stesso motivo — con una differenza: qui il motivo NON si
  // riassume. «Ordine cancellato» non e' un avviso, e' una notifica; «mai primo sul libro» e «gamba
  // rimasta sola oltre la tolleranza» chiedono due reazioni diverse.
  for (const r of (res.daRipianificare || [])) {
    if (!r || !r.marketId) continue;
    daRipianificareCoda.set(String(r.marketId), r);
    log(`ORDINE ORFANO cancellato su ${String(r.marketId).slice(0, 10)}… — la posizione con cui doveva accoppiarsi non esiste piu'. Il mercato torna da ripianificare al prossimo giro di chiusura.`);
  }
  const cancellazioni = res.cancellazioni || [];
  if (cancellazioni.length) {
    for (const c of cancellazioni) {
      log(`CANCELLATO DAL MOTORE · ${c.motivo} · cid_${String(c.marketId).replace(/^0x/, '').slice(0, 10)}`
        + ` · ${String(c.book).toUpperCase()} ${c.price} x ${c.size}`
        + `${Number.isFinite(c.notionalUsd) ? ` · $${c.notionalUsd.toFixed(2)} tornati liberi` : ''}`
        + ` — ${c.dettaglio || ''}`);
    }
    try {
      const w = registraCancellazioni(cancellazioni);
      if (!w.ok) log(`referto cancellazioni NON depositato (${w.reason}) — resta solo in questo log`);
    } catch (e) { log('referto cancellazioni NON depositato:', e.message); }
  }

  // I lati singoli che maturano un terzo: non un allarme, uno stato che va detto.
  for (const o of (res.latiSingoli || [])) {
    log(`LATO SINGOLO · cid_${String(o.marketId).replace(/^0x/, '').slice(0, 10)}`
      + ` · resta la ${String(o.book).toUpperCase()} · mid ${o.mid} dentro [0.10, 0.90]`
      + ` ⇒ matura ${(o.frazione * 100).toFixed(0)}% — si tiene, e il ciclo ritenta l altro lato.`);
  }

  return res;
}

// ── IL CICLO DEL TRACKING ──────────────────────────────────────────────────────────────────────────
// Try/catch suo, come la riconciliazione e la chiusura automatica: un motore che fallisce non deve poter
// fermare gli altri due, e viceversa.
async function trackingTask() {
  const res = await runTrackingCycle({
    // Stessa mano, stesso registro: il difetto qui è l'orologio del tracking (3s), non quello del
    // watcher. Il registro `ultimaValutazione` è condiviso apposta — vedi il commento su cadenzaPer.
    cadenza: (marketId) => cadenzaPer(marketId, TRACKING_POLL_MS),
    segnaValutazione: (marketId, t) => ultimaValutazione.set(marketId, t),
    readConfig: () => readTrackingConfig(),
    // SPEGNERE IL TRACKING SU UN MERCATO CHIUSO. Il motore decide QUANDO (solo a mercato risolto e a
    // libro gia' libero); qui si passa la mano che scrive. Iniettarla invece di importarla dentro il
    // modulo tiene il ciclo puro e testabile senza toccare la configurazione vera.
    disableTracking: ({ marketId, reason }) => setTracking({ marketId, enabled: false, by: 'motore · mercato chiuso', reason }),
    killStatus: () => killSwitch.killStatus(),
    isManual: (marketId) => isManualMarket(marketId),
    marketWindow: (marketId) => {
      try {
        const t = loadAutoRepriceTuning();
        return marketWindowFor({ marketId, baseTtlSeconds: t.restingGtdSeconds, baseRefreshMarginSeconds: t.refreshMarginSeconds });
      } catch { return null; }
    },
    resolveRules: (marketId) => resolveMarketRules(marketId),
    // I LIVELLI DEL BOOK, per il secondo trigger di riposizionamento (erosione della coda davanti
    // all'ordine). Stessa fonte del mid — lo snapshot di agent34 — letta con la funzione che vive
    // accanto a resolveMarketRules, non con un secondo lettore che potrebbe non essere d'accordo.
    readDepth: (marketId) => resolveMarketDepth(marketId),
    listOrders: ({ marketId }) => listManualOrders({ marketId }),
    // LO STESSO percorso di piazzamento del pannello a mano. Non una copia: la stessa funzione, quindi
    // ogni gate che governa un ordine a mano governa ogni ordine di questo motore.
    placeOrder: (spec) => placeManualOrder(spec),
    // Cancella tramite l'adapter CANCEL-ONLY (signer di solo indirizzo, strutturalmente incapace di
    // piazzare): la mossa che toglie un ordine non puo' mai, per costruzione, crearne uno.
    cancelOrder: (spec) => cancelManualOrder(spec, 'mm-tracking'),
    audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    tuning: (() => { const t = loadAutoRepriceTuning(); return { minIntervalMs: t.minIntervalMs, midStalePauseSec: MID_STALE_PAUSE_SEC, requireLiveBook: t.requireLiveBook, refreshMarginSeconds: t.refreshMarginSeconds }; })(),
    state: trackingState,
  });

  // ── I LOG: solo cio' che vale una riga ────────────────────────────────────────────────────────────
  for (const e of res.events || []) {
    if (e.type === 'fill') {
      log(`FILL RILEVATO · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)} · lato ${e.side.toUpperCase()} · ${e.sizeMatched} share eseguite @ ${e.price}`
        + ' — quel lato NON viene piu ripiazzato finche non intervieni a mano; l altro continua.');
    } else if (e.type === 'erosion-armed' || e.type === 'erosion-recovered') {
      // Solo le TRANSIZIONI, non ogni lettura: il ciclo gira ogni 3s e una riga per lettura sarebbe
      // 1200 righe l'ora per lato senza dire mai niente di nuovo.
      log(`${e.type === 'erosion-armed' ? 'EROSIONE ARMATA' : 'erosione rientrata'} · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)}`
        + ` · lato ${e.side.toUpperCase()} · profondita ${e.depth} share contro baseline ${e.baseline} (${e.ratioPct}%)`);
    }
  }
  for (const a of res.actions || []) {
    if (a.action === 'place') {
      log(`TRACKING ${a.ok ? 'ok' : 'FALLITO'} · ${a.trigger}${a.triggerKind ? ` [${a.triggerKind}]` : ''} · ${a.book.toUpperCase()} @ ${a.priceCents}c`
        + `${a.erosion && a.erosion.armed ? ` · EROSIONE ${a.erosion.ratioPct}% della baseline ${a.erosion.baseline}` : ''}`
        + ` · mid ${a.fromMid != null ? a.fromMid + 'c → ' : ''}${a.toMid}c`
        + `${a.movedCents != null ? ` (mosso ${a.movedCents}c)` : ''}`
        + ` · offset ${a.offsetCents}c · size ${a.size}`
        + `${a.inBand === false ? ' · FUORI BANDA (nessun reward su questo lato)' : ''}`
        + `${a.sent ? ' · INVIATO al venue' : ' · non inviato (dry-run)'}`
        + `${a.ok ? '' : ` · gate=${a.gate}${a.failStreak ? ` (${a.failStreak}° rifiuto consecutivo, riprovo fra ${Math.round((a.backoffMs || 0) / 1000)}s)` : ''} ${a.reason || ''}`}`);
    } else if (a.action === 'skip') {
      log(`tracking skip · ${a.book.toUpperCase()} · ${a.gate}: ${a.reason}`);
    }
  }
  for (const m of res.markets || []) {
    if (m.gate && m.gate !== 'below-threshold') log(`tracking cid_${String(m.marketId).replace(/^0x/, '').slice(0, 10)}: ${m.gate} — ${m.reason}`);
  }

  // ── LO STATO PER LA DASHBOARD ─────────────────────────────────────────────────────────────────────
  for (const a of (res.actions || []).filter((x) => x.action === 'place')) {
    trackingLog.unshift({ at: res.at, ...a });
  }
  for (const e of res.events || []) trackingLog.unshift({ at: res.at, action: 'event', ...e });
  if (trackingLog.length > TRACKING_LOG_MAX) trackingLog.length = TRACKING_LOG_MAX;

  try {
    atomicWriteJson(TRACKING_STATE_FILE, {
      at: res.at,
      ran: res.ran, gate: res.gate, reason: res.reason,
      placement: process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send' : 'dry-run',
      markets: (res.markets || []).map((m) => ({
        marketId: m.marketId, gate: m.gate, reason: m.reason,
        offsetCents: m.offsetCents, minMoveCents: m.minMoveCents, sizeShares: m.sizeShares,
        referenceMid: m.referenceMid, movedCents: m.movedCents, repriceCount: m.repriceCount,
        mid: m.mid ?? null, midAgeSec: m.midAgeSec ?? null, midSource: m.midSource ?? null,
        midReadAt: m.midReadAt ?? null, paused: m.paused === true,
        plan: m.plan ? { yes: m.plan.yes, no: m.plan.no } : null,
        sides: m.sides || null,
        sideDecisions: m.sideDecisions || null,
        // ── IL BERSAGLIO VERO, PER LATO ────────────────────────────────────────────────────────────
        // `offsetCents` qui sopra e' quello CONFIGURATO nel registro, e da quando il motore si mette
        // «un tick dietro il migliore altrui» non descrive piu' dove sta l'ordine: e' solo il valore di
        // ripiego per quando siamo soli sul lato. Senza questi campi la dashboard mostrava un numero
        // statico al posto di una distanza che cambia a ogni ciclo — un dato falso, non incompleto.
        //
        // Si trasporta solo cio' che serve a dirlo a schermo: modo, se siamo in cima, il migliore
        // altrui, e la distanza REALE dal mid. Non l'oggetto intero, che porterebbe anche i bordi banda
        // e la scala dei livelli senza che nessuno li legga.
        target: m.target
          ? {
            yes: m.target.yes && m.target.yes.ok === true
              ? { mode: m.target.yes.mode, onTop: m.target.yes.onTop, alone: m.target.yes.alone,
                bestOther: m.target.yes.bestOther, offsetCents: m.target.yes.offsetCents, priceCents: m.target.yes.priceCents }
              : null,
            no: m.target.no && m.target.no.ok === true
              ? { mode: m.target.no.mode, onTop: m.target.no.onTop, alone: m.target.no.alone,
                bestOther: m.target.no.bestOther, offsetCents: m.target.no.offsetCents, priceCents: m.target.no.priceCents }
              : null,
          }
          : null,
        // Lo scopo dei comportamenti dinamici: quando e' valorizzato, questo mercato NON e' governato
        // da «mai in cima» ne' dall'erosione, e il pannello deve poter dire perche' invece di mostrare
        // celle vuote che sembrano un guasto.
        dynamicGate: m.erosionGate || null,
      })),
      recent: trackingLog.slice(0, 60),
    });
  } catch (e) { log('tracking state write failed:', e.message); }
  return res;
}

async function main() {
  const tuning = loadAutoRepriceTuning();
  log('starting — band-exit watcher for HAND-PLACED orders only.');
  log(`poll ${tuning.pollMs}ms · confirm ${tuning.confirmSamples} samples · hysteresis ${tuning.hysteresisTicks} tick`
    + ` · min interval ${Math.round(tuning.minIntervalMs / 1000)}s/order · ceiling ${tuning.maxPerHour}/hour/market`
    + ` · mid must be live-book${tuning.requireLiveBook ? '' : ' (RELAXED)'} and ≤ ${tuning.maxMidAgeSec}s old · strategy ${tuning.strategy}`);
  log(`venue-side expiry ${Math.round(tuning.restingGtdSeconds / 60)} min (GTD), proactive renewal with ${Math.round(tuning.refreshMarginSeconds / 60)} min left`
    + ` → one renewal every ${Math.round((tuning.restingGtdSeconds - tuning.refreshMarginSeconds) / 60)} min = ${EXPECTED_RENEWALS_PER_HOUR.toFixed(1)}/hour in quiet conditions.`);
  log(`DEAD-MAN'S SWITCH: if this process stops, nothing renews and the EXCHANGE retires every managed order`
    + ` within ${Math.round(tuning.restingGtdSeconds / 60)} minutes. That protection is the venue's, not ours — no second supervisor is required.`);
  log(`connection blackout: if the venue is unreachable for more than ${tuning.disconnectCancelSeconds}s, the hand orders on managed markets are CANCELLED on reconnect rather than renewed on top of an unobserved state.`);
  log('placement switch: MANUAL_ORDER_PLACEMENT=' + (process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send (an automatic re-price REACHES the venue)' : 'dry-run (nothing reaches POST /order)'));
  log(`manual-lane reconciliation: every ${Math.round(RECONCILE_EVERY_MS / 1000)}s, and ONLY when something is unresolved`
    + ' — resolves expired/cancelled hand orders against venue truth so they stop counting as open exposure.'
    + ' It places nothing and cancels nothing, and is deliberately NOT gated on the kill switch.');
  log('this process owns no adapter and no signing key: to place anything it can only call the same manual replace path the panel button calls.');
  log('the only credential it holds is the L2 (HMAC) pair, used read-only by reward-reale.js for the daily payout comparison — L2 alone cannot sign an order.');
  const tr = readTrackingConfig();
  log(`market making a due lati: ${tr.readable ? `${tr.marketIds.length} mercato/i con tracking attivo` : `configurazione ILLEGGIBILE (${tr.error}) — nessun mercato tracciato (fail closed)`}.`
    + ' Su quei mercati il watcher reattivo sta alla larga: un mercato ha UN SOLO motore di reprice.');
  if (tr.readable) for (const id of tr.marketIds) {
    const m = tr.markets[id];
    log(`  cid_${id.replace(/^0x/, '').slice(0, 10)} · offset ${m.offsetCents}c · soglia ${m.minMoveCents}c · size ${m.sizeShares}`);
  }

  // ── LA FOTOGRAFIA, PRIMA DEL PRIMO GIRO ────────────────────────────────────────────────────────
  // `await`, non «e poi si vedra'»: se il primo ciclo partisse prima della fotografia, per un giro
  // quegli ordini sarebbero gestibili — ed e' il giro in cui il motore decide se riprezzarli.
  await scattaFotografia('avvio di agent40');
  try { const k = killSwitch.killStatus(); killPrecedente = !!(k && (k.effectivelyKilled === true || k.readable === false)); }
  catch { killPrecedente = null; }

  // Never let one bad cycle kill the watcher — but never let a failure be silent either.
  // ══ I DUE CONTROLLI ORARI — DENTRO QUESTO CICLO, NON IN UN PROCESSO NUOVO ═══════════════════════
  //
  // Girano appesi al ciclo da 5 secondi che c'e' gia'. `compitiDovuti` e' puro e riceve l'orologio,
  // quindi decide con una finestra di 4 minuti: un riavvio alle 23:54:58 non deve far perdere la
  // fotografia di quella giornata, e una giornata persa non si recupera.
  //
  // L'IDEMPOTENZA STA NEL FILE, non qui: `registraStima` e `registraReale` non riscrivono una riga
  // gia' completa. Percio' girare piu' volte dentro la finestra non produce doppioni.
  //
  // TRY/CATCH SUO, come la riconciliazione e la chiusura: un confronto che fallisce e' un referto
  // mancato, e non deve poter fermare il motore che riprezza capitale reale.
  let confrontoInCorso = false;
  // L'ultimo verdetto di deriva gia' annunciato: si parla quando CAMBIA, non a ogni giro.
  let ultimoStatoDivergenza = null;
  const controlliOrari = async () => {
    if (confrontoInCorso) return;
    confrontoInCorso = true;
    try {
      const c = compitiDovuti({ now: Date.now() });

      if (c.stima) {
        // La stima e' quella che il pannello mostra: stessa fonte, nessun secondo calcolo.
        const board = await buildMarketBoard({});
        const ordini = await buildOrderBoard();
        const sum = buildSummary(board.markets, ordini);
        const w = registraStima({
          giorno: c.giornoStima,
          stimaUsd: sum && Number.isFinite(sum.estGrossUsdPerDay) ? sum.estGrossUsdPerDay : null,
          perMercato: sum && Array.isArray(sum.estPerMarket) ? sum.estPerMarket : null,
        });
        if (w.scritto) {
          log(`CONFRONTO REWARD · stima di ${c.giornoStima} fotografata:`
            + ` $${sum && Number.isFinite(sum.estGrossUsdPerDay) ? sum.estGrossUsdPerDay.toFixed(2) : 'N/D'}/g`);
        }
      }

      if (c.reale) {
        const r = await leggiRewardReale({ giorno: c.giornoReale });
        const w = registraReale({
          giorno: c.giornoReale, disponibile: r.disponibile,
          realeUsd: r.totaleUsd, motivo: r.motivo, tentativo: c.tentativo,
          // La scomposizione per mercato e la prova che il venue ha ATTRIBUITO la lettura a noi: un
          // 200 pieno di zeri non attribuito non è un consuntivo. Vedi lib/maker/reward-reale.js.
          perMercato: r.perMercato, attribuito: r.attribuito ?? null, righeLette: r.righe ?? null,
          fonte: r.fonte ?? null, pagamenti: r.pagamenti ?? null,
        });
        if (w.scritto) {
          log(r.disponibile
            ? `CONFRONTO REWARD · consuntivo di ${c.giornoReale}: $${r.totaleUsd.toFixed(2)} da ${(r.pagamenti || []).length} pagamento/i (fonte ${r.fonte}, tentativo ${c.tentativo})`
            : `CONFRONTO REWARD · consuntivo di ${c.giornoReale} non disponibile (tentativo ${c.tentativo}/3): ${r.motivo}`
              + (w.esaurito ? ' — tentativi esauriti, la giornata resta marcata non disponibile' : ''));
        }
        // ── L'AVVISO DI DERIVA ────────────────────────────────────────────────────────────────────
        // Si dice UNA volta per verdetto, non a ogni tentativo: un avviso ripetuto ogni notte
        // diventa rumore, e il rumore è il modo in cui un allarme smette di essere letto. Non
        // corregge niente — vedi le soglie in lib/maker/confronto-reward.js.
        const d = leggiConfronto().divergenza;
        if (d && d.stato !== ultimoStatoDivergenza) {
          ultimoStatoDivergenza = d.stato;
          if (d.avviso) log(`CONFRONTO REWARD · ATTENZIONE, DERIVA DELLA STIMA: ${d.messaggio}`);
          else log(`CONFRONTO REWARD · ${d.messaggio}`);
        }
      }
    } catch (e) {
      log('confronto reward NON eseguito:', e && e.message ? e.message : String(e));
    } finally { confrontoInCorso = false; }
  };

  const run = async () => {
    cicloManuale++;
    // Prima del ciclo vero: e' una lettura, non tocca ordini, e un suo fallimento e' gia' isolato.
    controlliOrari().catch(() => {});
    let esito = null; let erroreCiclo = null;
    try { esito = await cycle(); }
    catch (e) { erroreCiclo = e; log('cycle failed:', e && e.message ? e.message : String(e)); }
    // The reconciliation runs on its OWN throttle and its OWN try/catch: a reprice cycle that fails must
    // not stop the ledger being reconciled, and vice versa.
    // `riconciliato` è un FATTO restituito dalla riconciliazione, non un'ipotesi dedotta dall'orologio.
    let riconciliato = false;
    try { riconciliato = await reconcileTask(); }
    catch (e) { log('reconcile task failed:', e && e.message ? e.message : String(e)); }
    // Lo snapshot delle posizioni SENZA CONDIZIONI, come dice da sempre il commento qui accanto: chi
    // calcola i tetti di esposizione lo legge, e se scade oltre 180s ogni piazzamento viene rifiutato.
    // Ha il suo throttle (60s), quindi chiamarlo a ogni giro non moltiplica le chiamate al venue.
    try { await snapshotPosizioniTask(); }
    catch (e) { log('snapshot posizioni task failed:', e && e.message ? e.message : String(e)); }
    // La chiusura automatica gira DOPO una riconciliazione, e questo resta: una posizione non si copre
    // prima di aver osservato il fill che l'ha creata. Ma «dopo una riconciliazione» ora si chiede a
    // lei, invece di dedurlo dal tempo trascorso — che è ciò che la faceva saltare proprio nei giri in
    // cui la riconciliazione aveva davvero lavoro da fare, cioè quando serviva di più.
    try { if (riconciliato) await closeTask(); }
    catch (e) { log('close task failed:', e && e.message ? e.message : String(e)); }

    // IL BATTITO PER ULTIMO, E SEMPRE. `finally` perché la morte è il SILENZIO, non l'errore: se un
    // fallimento saltasse il battito, ogni eccezione transitoria diventerebbe una cancellazione del
    // libro — cioè il difetto del 6 agosto, riprodotto sull'altro motore.
    finally { heartbeat(); scriviBattitoManuale(esito, erroreCiclo); }
  };
  await run();
  setInterval(run, tuning.pollMs);

  // ── LA SCANSIONE DEI REGISTRI: UNA ALL'AVVIO, POI OGNI 30 MINUTI ─────────────────────────────────
  // All'avvio perche' e' il momento in cui e' piu' probabile che ci siano voci vecchie — un processo che
  // riparte dopo ore di fermo — e ogni 30 minuti perche' e' manutenzione: un mercato che muore non ha
  // fretta di essere dimenticato, e una cadenza stretta costerebbe letture del venue per riconfermare
  // ogni volta la stessa cosa.
  //
  // TRY/CATCH SUO, come la riconciliazione e il confronto reward: una scansione che fallisce e' un
  // referto mancato, non un ciclo di riprezzo perso. E non tocca ordini ne' capitale — cancella voci di
  // registro di mercati che il VENUE dichiara chiusi, e solo a libro libero.
  const scansioneSicura = async (quando) => {
    try { await scansioneRegistri({ forzata: quando === 'avvio' }); }
    catch (e) { log(`scansione registri fallita (non fatale): ${e.message}`); }
  };
  await scansioneSicura('avvio');
  setInterval(() => { scansioneSicura('periodica'); }, require('../lib/maker/scansione-registri').CADENZA_MS);

  // ── IL MOTORE DI MARKET MAKING HA IL SUO OROLOGIO ────────────────────────────────────────────────
  // 3 secondi, non i 5 del watcher reattivo. Sono due compiti diversi: quello reattivo interviene solo
  // quando un ordine rischia di uscire dalla banda e puo' permettersi di guardare piu' di rado; questo
  // insegue il mid, e la soglia di movimento ha senso solo se il mid viene guardato spesso abbastanza
  // da coglierne il movimento. Intervallo separato anche perche' un ciclo lento dell'uno non deve poter
  // rallentare l'altro.
  let trackingRunning = false;
  const runTracking = async () => {
    // Niente sovrapposizioni: se un giro dura piu' di 3 secondi il successivo salta invece di
    // accavallarsi, altrimenti due cicli potrebbero cancellare e ripiazzare lo stesso ordine.
    if (trackingRunning) return;
    trackingRunning = true;
    try { await trackingTask(); }
    catch (e) { log('tracking task failed:', e && e.message ? e.message : String(e)); }
    finally { trackingRunning = false; }
  };
  await runTracking();

  // ── PUSH DAL FEED, NON POLLING ─────────────────────────────────────────────────────────────────
  // agent34 e' un processo separato: il websocket del venue arriva LI', non qui. Il canale fra i due e'
  // lo snapshot che agent34 scrive; fs.watch su quel file sveglia il motore nell'istante in cui lo
  // snapshot cambia, invece di scoprirlo al prossimo giro di un intervallo fisso.
  //
  // ONESTA' SU COSA QUESTO COMPRA E COSA NO. Toglie il disallineamento del MOTORE (fino a un intervallo
  // intero di ritardo fra «il prezzo e' cambiato» e «il motore lo sa»). NON scende sotto la cadenza con
  // cui agent34 scrive lo snapshot: quello e' il pavimento vero, e per abbassarlo bisognerebbe toccare
  // WRITE_INTERVAL_MS in agent34 — una decisione separata, con un costo suo.
  //
  // L'intervallo resta come BATTITO DI SICUREZZA: se il file smettesse di cambiare (feed fermo), il
  // ciclo deve girare lo stesso per accorgersene e mettere in pausa i mercati.
  let pushTimer = null;
  try {
    // SI GUARDA LA DIRECTORY, NON IL FILE. agent34 scrive in modo atomico (tmp + rename), quindi
    // l'inode del file cambia a ogni scrittura e un watch sul percorso del file smette di ricevere
    // eventi dopo la PRIMA sostituzione. Misurato: 1 risveglio su 10. Guardando la cartella e
    // filtrando per nome, ogni rename viene visto.
    fs.watch('/tmp', (ev, name) => {
      if (name !== 'clob-live-books.json') return;
      // Debounce corto: una scrittura atomica produce piu' eventi (rename + change) e senza questo il
      // ciclo partirebbe due o tre volte per lo stesso snapshot.
      if (pushTimer) return;
      pushTimer = setTimeout(() => { pushTimer = null; runTracking(); }, 120);
    });
    log('market making: agganciato al feed in PUSH (fs.watch sullo snapshot di agent34) — il ciclo parte quando il prezzo cambia, non a orologio.');
  } catch (e) {
    log('market making: fs.watch non disponibile (' + e.message + ') — resta il solo battito periodico.');
  }
  setInterval(runTracking, TRACKING_POLL_MS);
  log(`market making: battito di sicurezza ogni ${TRACKING_POLL_MS / 1000}s, cosi un feed fermo viene comunque notato.`);
  log(`market making: ciclo ogni ${TRACKING_POLL_MS / 1000}s · mid piu vecchio di ${MID_STALE_PAUSE_SEC}s ⇒ quel mercato va IN PAUSA (e riprende da solo).`);
}

if (require.main === module) {
  main().catch((e) => { log('fatal:', e && e.stack ? e.stack : String(e)); process.exit(1); });
}

module.exports = { cycle, reconcileTask, closeTask, snapshotPosizioniTask, trackingTask, breaches, trackingState };
