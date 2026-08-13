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
const { leggiSaldoUsd } = require('../lib/maker/saldo-cache');
const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const { DATA_DIR } = require('../lib/safety/store');
// ── LA RIGA D'AUDIT DELL'AZZERAMENTO DEL LATCH ──────────────────────────────────────────────────────
// Il giornale maker, lo stesso che usano gli altri percorsi. E' una SCRITTURA SU FILE e nient'altro:
// `audit.js` importa `fs`, `path`, `redact`, `DATA_DIR` e la rotazione — nessuna superficie di
// piazzamento o di firma. La proprieta' che il test dell'albero dei `require` difende resta intatta.
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const audit = (riga) => appendMakerAudit(riga);
const {
  valutaCapitale, calcolaPnl, decidiScatto, baselineDaScrivere, leggiBaseline, costruisciEventoGuardian,
  valutaLatch, eventoRiarmo, ETA_RIARMO_MS,
  confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO,
} = require('../lib/maker/guardian-perdite');

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
    abs: n(out.GUARDIAN_LOSS_ABS !== undefined ? out.GUARDIAN_LOSS_ABS : process.env.GUARDIAN_LOSS_ABS, 30),
  };
}

const POLL_MS = Number(process.env.GUARDIAN_POLL_MS || 30_000);
const BASELINE_FILE = path.join(DATA_DIR, 'guardian-baseline.json');
const STATE_FILE = path.join(DATA_DIR, 'guardian-state.json');
const HEARTBEATS = '/tmp/agent-heartbeats.json';

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
  return valutaCapitale({
    // `affidabile:false` = il numero c'è ma è vecchio oltre il tollerato. Per un gate di piazzamento
    // sarebbe «non autorizzare»; qui è «non misurare», che è la stessa prudenza nell'altra direzione.
    saldoUsd: (saldo && saldo.affidabile === false) ? null : (saldo ? saldo.usd : null),
    posizioni: pos ? pos.positions : null,
    posizioniLeggibili: !!(pos && pos.readable),
  });
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
    const l = valutaLatch({ stato, pnl: pnlL, sogliaPct: soglie.pct, sogliaAbs: soglie.abs, now });
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

  if (!capitale) capitale = await capitaleOra(deps);

  // ── IL BASELINE ───────────────────────────────────────────────────────────────────────────────────
  // Sopravvive ai riavvii di proposito (vedi guardian-perdite). Si crea solo se manca, e solo se il
  // capitale è LEGGIBILE: un baseline nato da una lettura fallita sarebbe un punto zero inventato, e
  // ogni misura successiva erediterebbe quell'errore per sempre.
  const baselineRaw = deps.baselineRaw !== undefined ? deps.baselineRaw : readJson(baselineFile);
  const baseline = leggiBaseline(baselineRaw);
  if (!baseline.valido) {
    if (!capitale.leggibile) {
      return { azione: 'attesa-baseline', motivo: `baseline da creare ma il capitale non è leggibile (${capitale.motivo}) — non si fissa un punto zero su una lettura fallita` };
    }
    const nuovo = baselineDaScrivere({ capitale, now, motivo: baselineRaw ? 'baseline precedente illeggibile' : 'primo avvio' });
    try { scrivi(baselineFile, nuovo); } catch (e) { return { azione: 'baseline-non-scritto', motivo: e.message }; }
    log(`baseline fissato: $${nuovo.baselineUsd.toFixed(2)} (saldo $${Number(capitale.saldoUsd).toFixed(2)} + posizioni $${Number(capitale.valorePosizioniUsd).toFixed(2)} su ${capitale.posizioni.length} mercati).`
      + ' Sopravvive ai riavvii: si azzera solo cancellando il file a mano.');
    return { azione: 'baseline-creato', baselineUsd: nuovo.baselineUsd };
  }

  if (!capitale.leggibile) {
    // NON si scatta al buio. Vedi il blocco in cima a guardian-perdite: un saldo illeggibile letto come
    // zero sarebbe «perdita del 100%», cioè una spazzata totale causata da un RPC lento.
    return { azione: 'capitale-illeggibile', motivo: capitale.motivo };
  }

  const pnl = calcolaPnl({ baselineUsd: baseline.baselineUsd, totaleUsd: capitale.totaleUsd });
  const decisione = decidiScatto({ pnl, sogliaPct: soglie.pct, sogliaAbs: soglie.abs });

  // ── LA PERSISTENZA: NON SI SCATTA SULLA PRIMA LETTURA ────────────────────────────────────────────
  // Lo stato vive nel processo e NON su disco, di proposito: se agent43 riparte non ha visto il
  // campione precedente e non puo' affermare che la perdita persisteva, quindi deve ricominciare a
  // contare. Un file lo farebbe «ricordare» una cosa che non ha osservato.
  // Iniettabile da `deps` perche' i test possano guidare la sequenza senza far girare il loop vero.
  const statoPrima = deps.statoConferme !== undefined ? deps.statoConferme : statoConferme;
  const conf = confermaScatto({ stato: statoPrima, decisione, pnl, now });
  if (deps.statoConferme === undefined) statoConferme = conf.stato;

  if (!conf.scatta) {
    // ⚠ IL PRE-ALLARME SI VEDE. E' esattamente l'evento che prima diventava un latch e adesso no:
    // se sparisse dal log, la modifica sembrerebbe «il guardiano non vede piu' niente».
    if (conf.preAllarme) {
      log(`PRE-ALLARME (${conf.conferme}/${LETTURE_CONSECUTIVE_PER_SCATTO}) — ${decisione.motivo}.`
        + ` Baseline $${baseline.baselineUsd.toFixed(2)} → adesso $${capitale.totaleUsd.toFixed(2)}.`
        + ` NON scatto: ${conf.motivo}`);
    } else if (conf.azzeratoPer === 'rientro') {
      log(`rientrato — ${conf.motivo}. PnL ${pnl.pnlUsd} USD (${pnl.pnlPct}%)`);
    }
    return { azione: conf.preAllarme ? 'pre-allarme' : 'entro-soglia',
      pnlUsd: pnl.pnlUsd, pnlPct: pnl.pnlPct, baselineUsd: baseline.baselineUsd,
      totaleUsd: capitale.totaleUsd, soglie, conferme: conf.conferme,
      statoConferme: conf.stato, azzeratoPer: conf.azzeratoPer,
      motivo: conf.preAllarme ? conf.motivo : decisione.motivo };
  }

  // ── SI SCATTA ─────────────────────────────────────────────────────────────────────────────────────
  log(`SCATTO: ${decisione.motivo}. Baseline $${baseline.baselineUsd.toFixed(2)} → adesso $${capitale.totaleUsd.toFixed(2)}.`
    + ` CONFERMATO da ${conf.conferme} letture consecutive (${conf.motivo}).`
    + ' Cancello TUTTI gli ordini a riposo su ogni venue, poi metto il bot su FERMA. Le posizioni aperte NON si toccano.');
  // Lo scatto consuma il contatore: se l'operatore riarma, si riparte da zero conferme.
  if (deps.statoConferme === undefined) statoConferme = null;

  let results = [];
  try {
    const credsProviders = await (deps.buildCancelCredsProviders || buildCancelCredsProviders)();
    results = await (deps.cancelAllOrders || cancelAllOrders)({ credsProviders });
  } catch (e) {
    log('cancellazione fallita:', e.message);
    results = [{ venue: 'polymarket', ok: false, error: (e && e.message) || String(e), cancelled: 0 }];
  }

  // ── FERMA ─────────────────────────────────────────────────────────────────────────────────────────
  // DOPO la cancellazione: se il flag non si scrivesse, gli ordini sono comunque già via — l'ordine
  // inverso lascerebbe il bot fermo con il libro ancora pieno, che è lo stato peggiore dei due.
  let botFermato = { ok: false, motivo: 'non tentato' };
  try {
    botFermato = (deps.impostaBot || impostaBot)({
      enabled: false, by: 'agent43-guardian',
      reason: `perdita oltre soglia: ${decisione.motivo}`,
    });
    log(botFermato.ok ? `bot messo su FERMA (era ${botFermato.prima ? 'AVVIATO' : 'già fermo'})` : `FERMA NON scritto: ${botFermato.motivo}`);
  } catch (e) { botFermato = { ok: false, motivo: e.message }; log('FERMA non scritto:', e.message); }

  // ── IL REFERTO ────────────────────────────────────────────────────────────────────────────────────
  const base = costruisciCancellazione({ at: now, stalenessSec: null, thresholdSec: null, results, ambito: 'tutto' });
  const evento = costruisciEventoGuardian({
    base, at: now, pnl, capitale, baseline,
    soglieSuperate: decisione.soglieSuperate, sogliaPct: soglie.pct, sogliaAbs: soglie.abs,
    botFermato: botFermato.ok === true,
  });
  try {
    const w = (deps.registraCancellazione || registraCancellazioneDiEmergenza)(evento);
    if (!w.ok) log(`referto NON depositato (${w.reason}) — resta solo in questo log`);
    else log(`referto depositato: ${evento.ordiniCancellati} ordini su ${evento.mercatiToccati} mercati, reason=${evento.reason}`);
  } catch (e) { log('referto NON depositato:', e.message); }

  // La latch, scritta per ultima ma sempre scritta: anche se tutto il resto è fallito, questo giro è
  // avvenuto e non va ripetuto in automatico.
  try {
    scrivi(stateFile, {
      v: 1, scattato: true, at: now, atIso: new Date(now).toISOString(),
      reason: 'guardian-auto-kill', pnlUsd: pnl.pnlUsd, pnlPct: pnl.pnlPct,
      baselineUsd: baseline.baselineUsd, totaleUsd: capitale.totaleUsd,
      soglieSuperate: decisione.soglieSuperate, ordiniCancellati: evento.ordiniCancellati,
      mercati: evento.venues.flatMap((v) => (v.markets || []).map((m) => m.market)).filter(Boolean),
      botFermato: botFermato.ok === true,
      comeRiarmare: 'cancella questo file a mano, poi premi AVVIA sulla dashboard. Nessun riarmo automatico.',
    });
  } catch (e) { log('latch NON scritta:', e.message); }

  return { azione: 'scattato', pnlUsd: pnl.pnlUsd, pnlPct: pnl.pnlPct, soglieSuperate: decisione.soglieSuperate,
    ordiniCancellati: evento.ordiniCancellati, results, evento, botFermato };
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
