#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent43-guardian — IL GUARDIANO DELLE PERDITE ECONOMICHE.
//
// NOME: era `agent42-guardian` fino all'8 agosto 2026, e condivideva il 42 con agent42-watch-makers.
// pm2 distingue per nome intero e i due non collidevano, ma la convenzione di questa flotta e' «un
// numero, un processo» (vedi agent37: «Named 37, not 36»), e il blocco in ecosystem.config.js aveva
// gia' indicato agent43 come il candidato. Rinominato su richiesta dell'operatore.
//
// ═══ COSA SORVEGLIA, E PERCHÉ NON BASTAVA agent37 ═══════════════════════════════════════════════════
// agent37 chiede «il motore è vivo?». Se un battito si ferma, i suoi ordini restano soli sul venue e
// vanno tolti. È una domanda sulla SALUTE DEI PROCESSI, e la sua risposta non guarda un dollaro.
//
// Questo chiede l'altra cosa, che agent37 per costruzione non può vedere: un motore perfettamente vivo,
// che batte regolare, che passa ogni preflight — e che sta perdendo soldi. Nessun battito manca, nessun
// processo muore, e il capitale scende. Due guasti indipendenti, quindi due guardiani.
//
// ═══ COSA FA ALLO SCATTO, IN ORDINE ═════════════════════════════════════════════════════════════════
//   1. cancella OGNI ordine a riposo su OGNI venue     (lib/maker/cancel-all — la stessa di agent37)
//   2. deposita il referto con reason='guardian-auto-kill'  (lo stesso registro del dead-man)
//   3. mette il bot su FERMA                            (lib/maker/bot-enabled — l'interruttore vero)
// Poi si ferma e non riprova: nessun auto-riarmo, nessun timer, nessuna condizione di uscita. Si riparte
// solo cancellando data/guardian-state.json a mano.
//
// ═══ COSA NON FA, E PERCHÉ ══════════════════════════════════════════════════════════════════════════
// NON tocca le posizioni aperte. Cancella ordini A RIPOSO — capitale che non è ancora impegnato in
// niente — e lascia in piedi l'uscita automatica, che è ciò che porta a casa una posizione già aperta.
// Un guardiano che fermasse anche quella lascerebbe scoperto proprio ciò che c'era da proteggere.
//
// ═══ PERCHÉ FERMA (bot-enabled) E NON IL KILL ═══════════════════════════════════════════════════════
// Questa è la scelta più importante del file, ed è obbligata. Servono due cose insieme: bloccare i
// piazzamenti nuovi E lasciare vivere l'uscita post-fill. Nel progetto ci sono tre candidati, e due sono
// trappole:
//
//   · kill-switch (lib/safety/kill-switch)   — lo leggono TUTTI i percorsi, ma lo legge anche
//     lib/maker/auto-close, che si ferma con «una chiusura è comunque un ordine nuovo». Killare
//     lascerebbe le posizioni aperte senza uscita, per sempre. È l'emergenza assoluta, non questo.
//   · un gate dentro manual-order.placeManualOrder — stessa trappola, per la stessa ragione:
//     l'auto-close PIAZZA ATTRAVERSO quella funzione. Bloccarla lì blocca le uscite.
//   · bot-enabled (FERMA) — documentato esattamente così: «ferma i NUOVI piazzamenti e le rotazioni,
//     le posizioni già aperte restano gestite: auto-close, riprezzatura, rinnovi continuano».
//
// Quindi FERMA, che è l'interruttore ESISTENTE con la semantica esatta richiesta — non uno nuovo.
//
// ONESTÀ SULLA COPERTURA, perché un guardiano che promette più di quello che fa è peggio di nessuno:
// FERMA è letto da agent41 (il riallocatore, cioè la cosa che apre posizioni da sola). NON è letto da
// agent35 — che però oggi è fermato a monte da MAKER_MODE=off e non può piazzare — né dal pannello
// manuale, che è la mano dell'operatore, cioè della stessa persona che deve riarmare. Non esiste, in
// questo progetto, un punto in cui bloccare i piazzamenti nuovi SENZA bloccare anche le uscite: chi
// volesse coprire anche pannello e agent35 dovrebbe mettere il gate dentro placeManualOrder, e a quel
// punto spegnerebbe l'auto-close. È un limite reale, dichiarato qui e non nascosto.
//
// ═══ SUPERFICIE ═════════════════════════════════════════════════════════════════════════════════════
// STRUTTURALMENTE INCAPACE DI PIAZZARE. La sua unica superficie di scrittura verso il venue è
// lib/maker/cancel-all (adapter di sola cancellazione, signer che non sa firmare). Non importa
// lib/venues/polymarket-clob-maker/{adapter,signer,orders} da nessun ramo del suo albero — verificato da
// lib/maker/guardian-perdite.test.js, che fallisce se qualcuno ce lo trascina dentro.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { fileRuntime } = require('../lib/percorsi-runtime');
// ── IL CARICATORE DI `.env` — PERCHÉ UN RIAVVIO AUTOMATICO NON DEVE ROMPERE NIENTE ──────────────────
// Stesso blocco di agent40 e agent41, e per la stessa ragione. Un riavvio automatico di pm2 (crash,
// OOM) riparte con la descrizione in memoria del demone, che le variabili ce le ha. Ma un riavvio del
// DEMONE — riavvio del server, `pm2 update` — risorge dal dump su disco, che su questa macchina è
// PULITO (misurato l'8 agosto 2026, CLAUDE.md §5 §3): nessuna delle variabili critiche è lì dentro.
// Senza un caricatore, un reboot notturno lascerebbe questo processo vivo e senza le variabili che gli
// servono. Con il caricatore le variabili tornano a venire da un file, che sopravvive a tutto.
//
// NON SOVRASCRIVE MAI: `process.env[k] === undefined` è la condizione, quindi ciò che pm2 già passa
// vince sul file. Può solo riempire i buchi — non può cambiare il comportamento di un avvio che oggi
// funziona.
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file assente → si prosegue con l'ambiente che c'è */ }
}

const { cancelAllOrders } = require('../lib/maker/cancel-all');
const { buildCancelCredsProviders } = require('../lib/maker/cancel-creds-provider');
const { costruisciCancellazione, registraCancellazioneDiEmergenza } = require('../lib/maker/cancellazione-di-emergenza');
const { impostaBot, statoBot } = require('../lib/maker/bot-enabled');
// ── IL SECONDO SCATTO: LA PERDITA GIORNALIERA REALIZZATA (17 agosto 2026) ─────────────────────────
// Decisione dell'operatore: «il kill a -$100 deve CANCELLARE gli ordini a libro, non solo rifiutare i
// nuovi. Oggi e' un gate di piazzamento e non e' un kill.» Aveva ragione: `maxDailyLossUsd` viveva solo
// dentro `evaluateLimits`, cioe' scattava quando si valutava un ORDINE — a libro pieno e senza ordini in
// arrivo non succedeva niente. La soglia e il numero si IMPORTANO dalle stesse due funzioni che il gate
// di piazzamento usa: due idee di «perdita giornaliera» che divergono sarebbero il reperto D1 su una
// decisione di rischio.
const { valutaPerditaGiornaliera } = require('../lib/maker/kill-perdita-giornaliera');
const { resolveLimits } = require('../lib/safety/risk-limits');
const { readUsage } = require('../lib/safety/usage');
const UTENTE_OPERATORE = process.env.MAKER_OPERATOR_USER || 'operator';
const { leggiSaldoUsd } = require('../lib/maker/saldo-cache');
const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const { DATA_DIR } = require('../lib/safety/store');
// ── LA RIGA D'AUDIT DELL'AZZERAMENTO DEL LATCH ──────────────────────────────────────────────────────
// Il giornale maker, lo stesso che usano gli altri percorsi. E' una SCRITTURA SU FILE e nient'altro:
// `audit.js` importa `fs`, `path`, `redact`, `DATA_DIR` e la rotazione — nessuna superficie di
// piazzamento o di firma. La proprieta' che il test dell'albero dei `require` difende resta intatta.
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');

// ── I PERCORSI PRIMA DI TUTTO — 17 agosto 2026 ─────────────────────────────────────────────────────
// Se `data/`, la directory di servizio o un file di servizio gia' esistente non sono utilizzabili da
// QUESTO processo, ci si ferma qui e lo si dice. Non e' prudenza generica: il 17 agosto nove file di
// `/tmp` erano di un altro utente, gli scrittori prendevano EACCES e **i lettori continuavano a leggere
// la copia vecchia, che da quel momento non invecchiava piu'**. Un processo «online» che decide su una
// fotografia ferma e' peggio di un processo caduto. Dettagli in `lib/safety/percorsi-critici.js`.
require('../lib/safety/percorsi-critici').verificaOMuori('agent43-guardian');
const audit = (riga) => appendMakerAudit(riga);
const {
  valutaCapitale, calcolaPnl, decidiScatto, leggiBaseline, costruisciEventoGuardian,
  valutaLatch, eventoRiarmo, ETA_RIARMO_MS,
  confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO,
} = require('../lib/maker/guardian-perdite');
const {
  aggiornaRiferimento, sogliaAssoluta, FRAZIONE_SOGLIA_ASSOLUTA,
} = require('../lib/maker/guardian-riferimento');

// ── LO STATO DELLA PERSISTENZA, FRA UN GIRO E L'ALTRO ────────────────────────────────────────────
// In memoria e non su disco: vedi il commento dentro `poll`. Un riavvio lo azzera, ed e' voluto.
let statoConferme = null;

const ENV_FILES = ['.env.local', '.env'];
const RADICE = path.join(__dirname, '..');

// ── LE SOGLIE SI RILEGGONO A OGNI GIRO ──────────────────────────────────────────────────────────────
// `process.env` in un processo pm2 è una fotografia dell'avvio: cambiare .env non lo tocca. Quindi il
// file si rilegge, ogni ciclo, e sono le sue righe a decidere — non quelle di trenta ore fa. Costa una
// lettura di poche centinaia di byte ogni 30 secondi, e in cambio una soglia si corregge senza un
// riavvio, cioè senza la finestra scoperta che un riavvio produce.
function leggiSoglie() {
  const out = {};
  for (const f of ENV_FILES) {
    try {
      for (const line of fs.readFileSync(path.join(RADICE, f), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
        if (m && out[m[1]] === undefined) out[m[1]] = m[2];
      }
    } catch { /* file assente: si prova il successivo */ }
  }
  const n = (v, dflt) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : dflt; };
  return {
    pct: n(out.GUARDIAN_LOSS_PCT !== undefined ? out.GUARDIAN_LOSS_PCT : process.env.GUARDIAN_LOSS_PCT, 5),
    // ⚠ NON e' piu' LA soglia assoluta: e' il suo PAVIMENTO in dollari. La soglia vera e' derivata dal
    // riferimento (vedi `sogliaAssoluta`), e questo valore morde solo quando il conto e' cosi' piccolo
    // che il 5% varrebbe meno di tanto. Il .env non viene ignorato — continua a decidere, ma da sotto.
    absPavimento: n(out.GUARDIAN_LOSS_ABS !== undefined ? out.GUARDIAN_LOSS_ABS : process.env.GUARDIAN_LOSS_ABS, 30),
    absFrazione: n(out.GUARDIAN_LOSS_ABS_PCT !== undefined ? out.GUARDIAN_LOSS_ABS_PCT : process.env.GUARDIAN_LOSS_ABS_PCT, FRAZIONE_SOGLIA_ASSOLUTA * 100) / 100,
  };
}

const POLL_MS = Number(process.env.GUARDIAN_POLL_MS || 30_000);
const BASELINE_FILE = path.join(DATA_DIR, 'guardian-baseline.json');
const STATE_FILE = path.join(DATA_DIR, 'guardian-state.json');
const HEARTBEATS = fileRuntime('agent-heartbeats.json');

const log = (...a) => console.log(new Date().toISOString(), '[agent43-guardian]', ...a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function heartbeat() {
  const hb = readJson(HEARTBEATS) || {};
  // La chiave del battito segue il nome del processo. NESSUNO LA LEGGE oggi — agent-monitor non
  // sorveglia questo processo (non e' in WATCHED_AGENTS_RAW) — quindi rinominarla non instrada niente
  // di diverso; la vecchia chiave resta nel file finche' non lo si riscrive, e non fa danno.
  hb['agent43-guardian'] = Date.now();
  try { atomicWriteJson(HEARTBEATS, hb); } catch { /* best-effort */ }
}

/** Il capitale adesso: saldo pUSD + posizioni valutate al prezzo corrente. Le stesse due fonti che usa
 *  il resto del sistema — non una terza, che divergerebbe da quella operativa. */
async function capitaleOra(deps = {}) {
  const saldo = deps.saldo || await leggiSaldoUsd();
  const pos = deps.posizioni || readVenuePositions();
  // ── L'ISTANTE IN CUI IL SALDO È STATO LETTO DAVVERO ─────────────────────────────────────────────
  // La cache restituisce `etaMs`, cioè quanto è vecchia la voce: `now − etaMs` è l'istante in cui
  // quella voce è stata scritta. Serve a `confermaScatto` per distinguere una seconda OSSERVAZIONE
  // da una copia della prima — vedi il blocco in guardian-perdite.js. Non leggibile ⇒ `null`, e da lì
  // in giù «non si può dimostrare che sia un dato nuovo», che è la direzione prudente.
  const etaSaldo = saldo && Number.isFinite(Number(saldo.etaMs)) ? Number(saldo.etaMs) : null;
  const osservazione = {
    saldoLetturaAt: etaSaldo === null ? null : (deps.now ? deps.now() : Date.now()) - etaSaldo,
    saldoFonte: saldo ? saldo.fonte : null,
    posizioniEtaMs: pos && Number.isFinite(Number(pos.ageMs)) ? Number(pos.ageMs) : null,
  };
  const cap = valutaCapitale({
    // `affidabile:false` = il numero c'è ma è vecchio oltre il tollerato. Per un gate di piazzamento
    // sarebbe «non autorizzare»; qui è «non misurare», che è la stessa prudenza nell'altra direzione.
    saldoUsd: (saldo && saldo.affidabile === false) ? null : (saldo ? saldo.usd : null),
    posizioni: pos ? pos.positions : null,
    posizioniLeggibili: !!(pos && pos.readable),
  });
  // L'osservazione viaggia ACCANTO al capitale, non dentro: `valutaCapitale` è puro e non deve
  // imparare cos'è una cache. Chi decide lo scatto ha bisogno di entrambi.
  return { ...cap, osservazione };
}

/**
 * Un giro. Restituisce un oggetto di stato (lo usa anche il test), e non solleva mai verso il loop.
 * `deps` inietta orologio, letture, cancellazione e scritture, così l'intera decisione — comprese le
 * due soglie e lo scatto — si esercita senza rete, senza venue e senza toccare lo stato in esecuzione.
 */
async function poll(deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const baselineFile = deps.baselineFile || BASELINE_FILE;
  const stateFile = deps.stateFile || STATE_FILE;
  const soglie = deps.soglie || leggiSoglie();
  const scrivi = deps.scriviJson || ((f, o) => atomicWriteJson(f, o, { pretty: true }));

  // ── LA LATCH ──────────────────────────────────────────────────────────────────────────────────────
  // Già scattato ⇒ non si rifà niente. Senza questa, ogni 30 secondi partirebbe una nuova spazzata e un
  // nuovo referto sulla stessa perdita, e l'operatore che riarma il bot per rimetterlo in piedi se lo
  // vedrebbe rispegnere al giro dopo — un guardiano che litiga con la persona che deve riarmarlo.
  // ══ IL LATCH NON SI LEGGE PIU' COME UN BOOLEANO (12 agosto 2026) ════════════════════════════════
  // Era: `scattato === true` ⇒ esci, e nient'altro veniva guardato. Conseguenza misurata: il latch del
  // 9 agosto teneva il guardiano fuori servizio il 12, con il P&L tornato a +$2,54 su soglie -$30/-5%
  // — cioe' nel momento in cui il capitale era sano, nessuno lo sorvegliava.
  //
  // Adesso il latch si VALUTA dal P&L corrente. Ma il P&L costa una lettura del venue, e leggerlo prima
  // di sapere se serve significherebbe farlo a ogni giro anche a latch fresco: si guarda quindi prima
  // l'eta'. Sotto le 24h la risposta e' la stessa di prima e non si legge niente.
  // `!== undefined` E NON `||`: un chiamante che passa `stato: null` sta DICHIARANDO che non c'e'
  // latch, e con `||` quella dichiarazione veniva ignorata cadendo sul file vero. E' la stessa forma
  // di `baselineRaw` due blocchi piu' sotto, che questa riga non seguiva.
  const stato = deps.stato !== undefined ? deps.stato : readJson(stateFile);
  const latchPresente = !!(stato && stato.scattato === true);
  let capitale = null;

  if (latchPresente) {
    const etaMs = Number.isFinite(Number(stato.at)) ? now - Number(stato.at) : null;
    if (etaMs == null || etaMs < ETA_RIARMO_MS) {
      const l = valutaLatch({ stato, pnl: null, sogliaPct: soglie.pct, sogliaAbs: soglie.abs, now });
      return { azione: 'gia-scattato', scattatoAl: stato.atIso || null, etaMs, motivo: l.motivo };
    }
    // Oltre le 24h: adesso il P&L serve davvero, e decide lui.
    capitale = await capitaleOra(deps);
    const baselineRawL = deps.baselineRaw !== undefined ? deps.baselineRaw : readJson(baselineFile);
    const baselineL = leggiBaseline(baselineRawL);
    const pnlL = (capitale.leggibile && baselineL.valido)
      ? calcolaPnl({ baselineUsd: baselineL.baselineUsd, totaleUsd: capitale.totaleUsd })
      : null;
    // La soglia assoluta e' DERIVATA anche qui: il riarmo deve usare lo stesso metro dello scatto, o
    // il latch si azzererebbe con un criterio diverso da quello che lo ha prodotto.
    const absL = sogliaAssoluta({ riferimentoUsd: baselineL.valido ? baselineL.baselineUsd : null,
      pavimentoUsd: soglie.absPavimento, frazione: soglie.absFrazione }).sogliaUsd;
    const l = valutaLatch({ stato, pnl: pnlL, sogliaPct: soglie.pct, sogliaAbs: absL, now });
    if (!l.azzera) {
      return { azione: 'gia-scattato', scattatoAl: stato.atIso || null, etaMs: l.etaMs, motivo: l.motivo };
    }
    // ── L'AZZERAMENTO, DICHIARATO PRIMA DI ESSERE FATTO ────────────────────────────────────────
    // La riga d'audit si scrive PRIMA di togliere il file: se la cancellazione fallisce resta la
    // traccia del tentativo, e «ho provato e non ci sono riuscito» e' un'informazione. Al contrario,
    // cancellare e poi non riuscire a scrivere l'audit lascerebbe un azzeramento muto.
    const ev = eventoRiarmo({ stato, pnl: pnlL, etaMs: l.etaMs, motivo: l.motivo, at: now });
    try { (deps.audit || audit)(ev); } catch { /* un audit che non riesce non blocca il riarmo */ }
    let tolto = false;
    try {
      if (typeof deps.rimuoviStato === 'function') { deps.rimuoviStato(stateFile); tolto = true; }
      else { fs.unlinkSync(stateFile); tolto = true; }
    } catch (e) {
      return { azione: 'riarmo-fallito', motivo: `latch da azzerare ma il file non si e' potuto rimuovere: ${e.message}` };
    }
    log(`LATCH AZZERATO — ${l.motivo}`);
    // Si prosegue nello STESSO giro: il guardiano e' di nuovo in servizio adesso, non fra trenta
    // secondi, e il capitale e' gia' letto.
    void tolto;
  }

  // ══ IL SECONDO SCATTO: LA PERDITA REALIZZATA DI OGGI ═══════════════════════════════════════════
  // Sta QUI, prima della lettura del venue, per una ragione precisa: la perdita realizzata si legge dal
  // REGISTRO DEI FILL, quindi e' conoscibile anche quando il venue non risponde — ed e' proprio la
  // giornata in cui il venue fa i capricci quella in cui non si vuole restare a libro pieno.
  // Non e' un secondo interruttore: e' un secondo INGRESSO alla stessa azione (spazzata + FERMA), che
  // resta scritta una volta sola piu' sotto.
  const perdita = (() => {
    try {
      // ⚠ LA FORMA DI `resolveLimits` E' `{ok, limits:{...}}`, NON I LIMITI IN PIANO — e la prima
      // stesura leggeva `lim.maxDailyLossUsd`, cioe' `undefined`, cioe' «soglia non leggibile», cioe'
      // NON SI SCATTA MAI. Il kill che doveva cancellare era INERTE, e il suo test passava perche'
      // iniettava una forma inventata da me (`{readable:true, maxDailyLossUsd:100}`): provava la
      // DECISIONE e non il CABLAGGIO. E' la classe di §5.3 nella sua forma piu' costosa, e l'ha presa il
      // banco al passo 17 — non la rilettura.
      const lim = (deps.resolveLimits || resolveLimits)({ userId: UTENTE_OPERATORE });
      const limiti = (lim && lim.limits && typeof lim.limits === 'object') ? lim.limits : lim;
      const uso = (deps.readUsage || readUsage)({ userId: UTENTE_OPERATORE, now });
      return valutaPerditaGiornaliera({ perditaRealizzataUsd: uso ? uso.realisedDailyPnlUsd : null,
        sogliaUsd: (lim && lim.ok === false) ? null : (limiti ? limiti.maxDailyLossUsd : null) });
    } catch (e) {
      // ⚠ Un'eccezione qui NON deve poter cancellare niente e non deve fermare il giro del drawdown:
      // si dichiara e si prosegue col guardiano di sempre.
      return { scatta: false, leggibile: false, perditaUsd: null, sogliaUsd: null,
        motivo: `perdita giornaliera non valutabile (${e && e.message ? e.message : String(e)}): non si cancella al buio` };
    }
  })();
  if (perdita.scatta) {
    log(`SCATTO PER PERDITA GIORNALIERA: ${perdita.motivo}`);
    const esito = await spazzaEFerma({
      motivo: perdita.motivo,
      causa: 'perdita-giornaliera',
      dettagli: { perditaRealizzataUsd: perdita.perditaUsd, sogliaUsd: perdita.sogliaUsd },
      now, stateFile, scrivi, deps,
    });
    return { azione: 'scattato-perdita-giornaliera', ...esito,
      perditaRealizzataUsd: perdita.perditaUsd, sogliaUsd: perdita.sogliaUsd, motivo: perdita.motivo };
  }

  if (!capitale) capitale = await capitaleOra(deps);

  // ── IL BASELINE ───────────────────────────────────────────────────────────────────────────────────
  // Sopravvive ai riavvii di proposito (vedi guardian-perdite). Si crea solo se manca, e solo se il
  // capitale è LEGGIBILE: un baseline nato da una lettura fallita sarebbe un punto zero inventato, e
  // ogni misura successiva erediterebbe quell'errore per sempre.
  const baselineRaw = deps.baselineRaw !== undefined ? deps.baselineRaw : readJson(baselineFile);
  const baseline = leggiBaseline(baselineRaw);
  if (!capitale.leggibile) {
    // NON si scatta al buio, e NON si tocca il riferimento al buio. Vedi il blocco in cima a
    // guardian-perdite: un saldo illeggibile letto come zero sarebbe «perdita del 100%», cioè una
    // spazzata totale causata da un RPC lento. Questa guardia sta PRIMA del riferimento di proposito:
    // un massimo mobile aggiornato su una lettura fallita resterebbe sbagliato per sempre.
    return { azione: baseline.valido ? 'capitale-illeggibile' : 'attesa-baseline',
      motivo: baseline.valido ? capitale.motivo
        : `riferimento da creare ma il capitale non è leggibile (${capitale.motivo}) — non si fissa un punto zero su una lettura fallita` };
  }

  // ── IL RIFERIMENTO: MASSIMO MOBILE, SPOSTATO DAI MOVIMENTI DI CASSA ESTERNI ──────────────────────
  // Sostituisce la baseline-fotografia di §5.2 p.14, che con un deposito faceva fallire il guardiano
  // APERTO. Si aggiorna a OGNI giro e si riscrive solo quando cambia davvero.
  const rif = aggiornaRiferimento({ stato: baselineRaw, capitale, now });
  if (rif.cambiato && rif.stato) {
    try { scrivi(baselineFile, rif.stato); } catch (e) { return { azione: 'riferimento-non-scritto', motivo: e.message }; }
    log(`riferimento aggiornato: $${Number(rif.riferimentoUsd).toFixed(2)} — ${rif.motivo}.`
      + (rif.movimento && rif.movimento.esterno
        ? ' ⚠ MOVIMENTO DI CASSA ESTERNO riconosciuto: non entra nel P&L.' : ''));
    try {
      (deps.audit || audit)({ ts: now, venue: 'polymarket', source: 'agent43-guardian',
        op: 'guardian-riferimento',
        outcome: rif.movimento && rif.movimento.esterno ? 'movimento-cassa-esterno' : 'nuovo-massimo',
        observed: { riferimentoUsd: rif.riferimentoUsd, totaleUsd: capitale.totaleUsd,
          movimentoUsd: rif.movimento ? rif.movimento.movimentoUsd : null,
          movimentiEsterniCumulatiUsd: rif.stato.movimentiEsterniUsd },
        reason: rif.motivo });
    } catch { /* un audit che non riesce non ferma il guardiano */ }
  }
  if (!Number.isFinite(Number(rif.riferimentoUsd))) {
    return { azione: 'attesa-baseline', motivo: `riferimento non calcolabile: ${rif.motivo}` };
  }
  if (rif.creato === true) {
    // Contratto invariato dal 7 agosto: alla creazione da zero il giro si chiude qui. Non c'e' niente
    // da giudicare — il drawdown e' zero per costruzione — e il log resta quello che l'operatore conosce.
    log(`riferimento fissato: $${Number(rif.riferimentoUsd).toFixed(2)} (saldo $${Number(capitale.saldoUsd).toFixed(2)} + posizioni $${Number(capitale.valorePosizioniUsd).toFixed(2)} su ${capitale.posizioni.length} mercati).`
      + ' E\' un MASSIMO MOBILE: sale coi guadagni, si sposta coi depositi e i prelievi, e non invecchia.');
    return { azione: 'baseline-creato', baselineUsd: Number(rif.riferimentoUsd) };
  }
  // Da qui in poi `baseline.baselineUsd` E' il riferimento: una sola grandezza, un solo nome a valle.
  baseline.valido = true;
  baseline.baselineUsd = Number(rif.riferimentoUsd);

  const pnl = calcolaPnl({ baselineUsd: baseline.baselineUsd, totaleUsd: capitale.totaleUsd });
  // ⚠ LA SOGLIA ASSOLUTA E' DERIVATA DAL RIFERIMENTO, non piu' i $30 fissi del .env: su $2.150 quei
  // $30 valevano l'1,4% e avrebbero fatto scattare il guardiano su rumore di mercato. Il valore del
  // .env resta come PAVIMENTO in dollari, cioe' morde sui conti piccoli.
  const abs = sogliaAssoluta({ riferimentoUsd: baseline.baselineUsd,
    pavimentoUsd: soglie.absPavimento, frazione: soglie.absFrazione });
  soglie.abs = abs.sogliaUsd;
  soglie.absDerivata = abs.derivata;
  soglie.absMotivo = abs.motivo;
  const decisione = decidiScatto({ pnl, sogliaPct: soglie.pct, sogliaAbs: soglie.abs });

  // ── LA PERSISTENZA: NON SI SCATTA SULLA PRIMA LETTURA ────────────────────────────────────────────
  // Lo stato vive nel processo e NON su disco, di proposito: se agent43 riparte non ha visto il
  // campione precedente e non puo' affermare che la perdita persisteva, quindi deve ricominciare a
  // contare. Un file lo farebbe «ricordare» una cosa che non ha osservato.
  // Iniettabile da `deps` perche' i test possano guidare la sequenza senza far girare il loop vero.
  const statoPrima = deps.statoConferme !== undefined ? deps.statoConferme : statoConferme;
  const conf = confermaScatto({ stato: statoPrima, decisione, pnl, now,
    // ⚠ SENZA QUESTA RIGA la conferma tornerebbe a valere contro una copia della stessa lettura: è la
    // dep che rende effettiva la correzione del 13 agosto 2026 (§5.2 p.16). Non iniettata ⇒
    // `saldoLetturaAt: null` ⇒ nessuna conferma conta, cioè il guardiano non scatta più: è il verso
    // giusto in cui rompersi, ma va saputo.
    osservazione: capitale && capitale.osservazione ? capitale.osservazione : null });
  if (deps.statoConferme === undefined) statoConferme = conf.stato;

  if (!conf.scatta) {
    // ⚠ IL PRE-ALLARME SI VEDE. E' esattamente l'evento che prima diventava un latch e adesso no:
    // se sparisse dal log, la modifica sembrerebbe «il guardiano non vede piu' niente».
    if (conf.preAllarme) {
      log(`PRE-ALLARME (${conf.conferme}/${LETTURE_CONSECUTIVE_PER_SCATTO}`
        + `${conf.inAttesaDiDatoFresco ? ', FERMO in attesa di un saldo fresco' : ''}) — ${decisione.motivo}.`
        + ` Baseline $${baseline.baselineUsd.toFixed(2)} → adesso $${capitale.totaleUsd.toFixed(2)}.`
        + ` NON scatto: ${conf.motivo}`);
    } else if (conf.azzeratoPer === 'rientro') {
      log(`rientrato — ${conf.motivo}. PnL ${pnl.pnlUsd} USD (${pnl.pnlPct}%)`);
    }
    return { azione: conf.preAllarme ? 'pre-allarme' : 'entro-soglia',
      pnlUsd: pnl.pnlUsd, pnlPct: pnl.pnlPct, baselineUsd: baseline.baselineUsd,
      totaleUsd: capitale.totaleUsd, soglie, conferme: conf.conferme,
      inAttesaDiDatoFresco: conf.inAttesaDiDatoFresco === true, saldoLetturaAt: conf.saldoLetturaAt,
      statoConferme: conf.stato, azzeratoPer: conf.azzeratoPer,
      motivo: conf.preAllarme ? conf.motivo : decisione.motivo };
  }

  // ── SI SCATTA ─────────────────────────────────────────────────────────────────────────────────────
  log(`SCATTO: ${decisione.motivo}. Baseline $${baseline.baselineUsd.toFixed(2)} → adesso $${capitale.totaleUsd.toFixed(2)}.`
    + ` CONFERMATO da ${conf.conferme} letture consecutive (${conf.motivo}).`
    + ' Cancello TUTTI gli ordini a riposo su ogni venue, poi metto il bot su FERMA. Le posizioni aperte NON si toccano.');
  // Lo scatto consuma il contatore: se l'operatore riarma, si riparte da zero conferme.
  if (deps.statoConferme === undefined) statoConferme = null;

  const esito = await spazzaEFerma({
    motivo: decisione.motivo, causa: 'drawdown',
    dettagli: { pnl, capitale, baseline, soglie, soglieSuperate: decisione.soglieSuperate },
    now, stateFile, scrivi, deps,
  });
  return { azione: 'scattato', pnlUsd: pnl.pnlUsd, pnlPct: pnl.pnlPct, soglieSuperate: decisione.soglieSuperate, ...esito };
}

// ══ L'AZIONE, SCRITTA UNA VOLTA SOLA ═══════════════════════════════════════════════════════════════
// Spazzata degli ordini a riposo → FERMA → referto → latch. Estratta il 17 agosto 2026 quando alla
// perdita giornaliera realizzata e' stato dato il suo ingresso: due ingressi alla stessa azione, non due
// azioni. Ricopiarla avrebbe prodotto due spazzate che un giorno divergono su cosa cancellano, e questa
// e' l'unica funzione del repo che puo' togliere TUTTI gli ordini da TUTTI i venue.
//
// ⚠ L'ORDINE DEI QUATTRO PASSI NON E' CASUALE, ed era gia' scritto: FERMA va DOPO la cancellazione,
// perche' se il flag non si scrive gli ordini sono comunque via — l'ordine inverso lascerebbe il bot
// fermo col libro pieno, che e' lo stato peggiore dei due. E il latch si scrive per ULTIMO ma sempre:
// anche se tutto il resto e' fallito, questo giro e' avvenuto e non va ripetuto in automatico.
async function spazzaEFerma({ motivo, causa, dettagli = {}, now, stateFile, scrivi, deps = {} }) {
  const pnl = dettagli.pnl || null;
  const capitale = dettagli.capitale || null;
  const baseline = dettagli.baseline || null;
  const soglie = dettagli.soglie || null;

  let results = [];
  try {
    const credsProviders = await (deps.buildCancelCredsProviders || buildCancelCredsProviders)();
    results = await (deps.cancelAllOrders || cancelAllOrders)({ credsProviders });
  } catch (e) {
    log('cancellazione fallita:', e.message);
    results = [{ venue: 'polymarket', ok: false, error: (e && e.message) || String(e), cancelled: 0 }];
  }

  let botFermato = { ok: false, motivo: 'non tentato' };
  try {
    botFermato = (deps.impostaBot || impostaBot)({
      enabled: false, by: 'agent43-guardian',
      reason: `${causa === 'perdita-giornaliera' ? 'perdita giornaliera realizzata' : 'perdita oltre soglia'}: ${motivo}`,
    });
    log(botFermato.ok ? `bot messo su FERMA (era ${botFermato.prima ? 'AVVIATO' : 'gia\' fermo'})` : `FERMA NON scritto: ${botFermato.motivo}`);
  } catch (e) { botFermato = { ok: false, motivo: e.message }; log('FERMA non scritto:', e.message); }

  const base = costruisciCancellazione({ at: now, stalenessSec: null, thresholdSec: null, results, ambito: 'tutto' });
  // ⚠ Il referto del drawdown vuole pnl/capitale/baseline; quello della perdita giornaliera non li ha e
  // non li inventa. `costruisciEventoGuardian` li accetta nulli e il referto lo DICHIARA nella causa.
  const evento = costruisciEventoGuardian({
    base, at: now, pnl, capitale, baseline,
    soglieSuperate: dettagli.soglieSuperate || [causa],
    sogliaPct: soglie ? soglie.pct : null, sogliaAbs: soglie ? soglie.abs : (dettagli.sogliaUsd ?? null),
    botFermato: botFermato.ok === true,
  });
  try {
    const w = (deps.registraCancellazione || registraCancellazioneDiEmergenza)(evento);
    if (!w.ok) log(`referto NON depositato (${w.reason}) — resta solo in questo log`);
    else log(`referto depositato: ${evento.ordiniCancellati} ordini su ${evento.mercatiToccati} mercati, reason=${evento.reason}`);
  } catch (e) { log('referto NON depositato:', e.message); }

  try {
    scrivi(stateFile, {
      v: 1, scattato: true, at: now, atIso: new Date(now).toISOString(),
      reason: 'guardian-auto-kill', causa: causa || 'drawdown',
      pnlUsd: pnl ? pnl.pnlUsd : null, pnlPct: pnl ? pnl.pnlPct : null,
      baselineUsd: baseline ? baseline.baselineUsd : null,
      totaleUsd: capitale ? capitale.totaleUsd : null,
      perditaRealizzataUsd: dettagli.perditaRealizzataUsd ?? null,
      sogliaPerditaGiornalieraUsd: dettagli.sogliaUsd ?? null,
      soglieSuperate: dettagli.soglieSuperate || [causa],
      ordiniCancellati: evento.ordiniCancellati,
      mercati: evento.venues.flatMap((v) => (v.markets || []).map((m) => m.market)).filter(Boolean),
      botFermato: botFermato.ok === true,
      comeRiarmare: 'cancella questo file a mano, poi premi AVVIA sulla dashboard. Nessun riarmo automatico.',
    });
  } catch (e) { log('latch NON scritta:', e.message); }

  return { ordiniCancellati: evento.ordiniCancellati, results, evento, botFermato };
}

async function loop() {
  try {
    const r = await poll();
    if (r.azione === 'entro-soglia') {
      log(`ok — PnL ${r.pnlUsd >= 0 ? '+' : ''}${r.pnlUsd.toFixed(2)} USD`
        + `${r.pnlPct === null ? '' : ` (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(3)}%)`}`
        + ` · baseline $${r.baselineUsd.toFixed(2)} → $${r.totaleUsd.toFixed(2)} · soglie −${r.soglie.abs} USD / −${r.soglie.pct}%`);
    } else if (r.azione === 'capitale-illeggibile' || r.azione === 'attesa-baseline') {
      log(`niente misura questo giro: ${r.motivo}`);
    } else if (r.azione === 'gia-scattato') {
      log(`fermo: ${r.motivo}`);
    }
  } catch (e) { log('poll fallito (non fatale):', e.message); }
  heartbeat();
  setTimeout(loop, POLL_MS);
}

function main() {
  const s = leggiSoglie();
  log(`starting — un giro ogni ${POLL_MS}ms; soglie −${s.pct}% / −$${s.abs} (rilette a OGNI giro da .env, nessun riavvio serve).`);
  log('  sorveglia le PERDITE, non i processi: agent37 resta il dead-man dei battiti e i due non si sovrappongono.');
  log(`  allo scatto: cancel-all (sola cancellazione) → referto reason=guardian-auto-kill → bot su FERMA. Nessun auto-riarmo.`);
  log('  NON tocca le posizioni aperte e NON ferma l\'uscita automatica: una posizione aperta resta gestita.');
  const bot = statoBot();
  log(`  stato attuale del bot: ${bot.enabled ? 'AVVIATO' : 'FERMO'}${bot.motivo ? ` (${bot.motivo})` : ''}`);
  loop();
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

if (require.main === module) main();

module.exports = { poll, capitaleOra, leggiSoglie, BASELINE_FILE, STATE_FILE, POLL_MS };
