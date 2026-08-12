'use strict';
// lib/maker/stima-integrata.js — LA STIMA DIVENTA UNA QUANTITÀ, NON PIÙ UN TASSO FOTOGRAFATO.
//
// ═══ IL DIFETTO CHE CHIUDE (docs/diagnosi-sovrastima-465.md) ═══════════════════════════════════════
// `estimatedOperatorSharePerDay` calcola `poolGiornaliero × quota`, cioè un TASSO: «se le cose
// restassero così, in 24 ore incasseresti tanto». `buildSummary` lo fotografava UNA volta, alle 23:55,
// sugli ordini vivi in quell'istante, e `confronto-reward` lo confrontava con il bonifico della
// giornata — che è una QUANTITÀ realizzata su 24 ore. Le due grandezze non sono confrontabili se
// l'ordine non è rimasto vivo tutto il giorno.
//
// Misurato l'8 agosto 2026: i tre mercati della fotografia non esistevano prima delle 21:42:16, cioè
// erano vivi per 2,28 ore = il 9,5% della giornata. $49,17/g fotografati contro $3,68 incassati ⇒
// +1236%. Il conto giusto — $49,17 × 9,5% = $4,67 — porta lo scarto a +27%: la sola assunzione di
// durata spiegava il 97,8% dello scarto di quel giorno.
// E il 10 agosto lo stesso difetto a segno invertito: stima $0 contro $4,25 incassati, perché alle
// 23:55 non c'erano ordini vivi mentre le prime sei ore ne avevano avuti.
//
// ═══ COSA FA QUESTO MODULO — L'OPZIONE A ══════════════════════════════════════════════════════════
//     stima del giorno  =  Σ ( tasso_i × durata_i )
// Il tasso viene campionato DURANTE la giornata e integrato, invece di essere letto una volta sola.
// Il modulo è PURO: non legge il venue, non calcola tassi. Riceve campioni già misurati da chi li sa
// misurare (agent40 con `buildSummary`, o lo script di ricalcolo a ritroso con lo storico del board) e
// risponde a due domande: «registra questo campione» e «quanto fa l'integrale di questo giorno».
//
// ═══ LE TRE REGOLE CHE LO RENDONO ONESTO ══════════════════════════════════════════════════════════
// 1. UN CAMPIONE VALE FINO AL SUCCESSIVO, MA NON PIÙ DI `ESTENSIONE_MAX_MS`. Senza questo tetto, un
//    campione preso prima di un'interruzione di due ore si porterebbe dietro due ore di tasso che
//    nessuno ha osservato — cioè si ricostruirebbe il difetto che il modulo esiste per chiudere, in
//    piccolo. Oltre il tetto l'intervallo resta SCOPERTO e non contribuisce.
// 2. UNO SCOPERTO NON È UNO ZERO, E VA DETTO. L'integrale somma solo gli intervalli coperti, quindi
//    una giornata mal campionata SOTTOSTIMA — il verso sicuro — ma il risultato viaggia sempre con
//    `coperturaFrazione` e `completo`, così chi legge sa se sta guardando una giornata intera o
//    mezza. Un numero senza la sua copertura sarebbe di nuovo una fotografia spacciata per quantità.
// 3. UN TASSO NON FINITO NON È ZERO. Un campione con tasso `null`/NaN non viene registrato: lascia un
//    buco dichiarato invece di una riga che varrebbe «in quel momento non maturavo niente».
//
// ═══ PERCHÉ IL PASSO È 5 MINUTI ═══════════════════════════════════════════════════════════════════
// Costo misurato di un campione sul processo vero (mediana di tre): **124 ms**, di cui ~80 ms è
// l'unica chiamata al venue (`buildOrderBoard`); `buildSummary` costa 0 ms. A 5 minuti sono 288
// campioni al giorno = **0,2 richieste al minuto**, cioè +0,6% sul carico di flotta misurato in
// CLAUDE.md §5 punto 93 (33,33 req/min). Sul lato dell'accuratezza: la finestra reale più corta mai
// osservata è quella dell'8 agosto, 2,28 ore, che a 5 minuti dà **27 campioni**; la vita di un ordine
// è al più la finestra GTD di 23 minuti, quindi nessun ordine può nascere e morire fra due campioni
// senza lasciare traccia in almeno uno. Si cambia con `MAKER_STIMA_PASSO_MS`, e un valore fuori da
// [60 s, 30 min] viene scartato in favore del difetto — la stessa regola di fine scala e orizzonte.
//
// Run dei test: node lib/maker/stima-integrata.test.js

const fs = require('fs');
const path = require('path');

const PASSO_DEFAULT_MS = 5 * 60_000;
const PASSO_MIN_MS = 60_000;
const PASSO_MAX_MS = 30 * 60_000;
/** Quanto può valere un campione da solo: due passi. Oltre, l'intervallo è scoperto. */
const FATTORE_ESTENSIONE = 2;
/** Giorni tenuti nel registro. Ne bastano due per integrare ieri mentre oggi si accumula; il terzo è
 *  margine per un recupero a ritroso di una giornata sola. */
const GIORNI_TENUTI = 3;
const GIORNO_MS = 86_400_000;

function fileCampioni() {
  try { return path.join(require('../safety/store').DATA_DIR, 'stima-campioni.json'); }
  catch { return path.join(__dirname, '..', '..', 'data', 'stima-campioni.json'); }
}

/** Il passo di campionamento in vigore. Fuori intervallo ⇒ difetto (mai spegnere una misura). */
function passoMs(env = process.env) {
  const v = Number(env.MAKER_STIMA_PASSO_MS);
  if (!Number.isFinite(v) || v < PASSO_MIN_MS || v > PASSO_MAX_MS) return PASSO_DEFAULT_MS;
  return v;
}

function estensioneMaxMs(env = process.env) { return passoMs(env) * FATTORE_ESTENSIONE; }

/** Il giorno UTC di un istante. È la stessa chiave con cui `confronto-reward` indicizza le giornate. */
function giornoDi(tMs) { return new Date(tMs).toISOString().slice(0, 10); }

function inizioGiornoMs(giorno) { return Date.parse(`${giorno}T00:00:00.000Z`); }

function leggiGrezzo(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j && typeof j === 'object' && j.giorni && typeof j.giorni === 'object') ? j : { v: 1, giorni: {} };
  } catch { return { v: 1, giorni: {} }; }
}

function scriviAtomico(file, dati) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dati, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * Registra un campione del tasso.
 *
 * @param {number} tMs               istante del campione
 * @param {number} tassoUsdPerDay    il tasso osservato in quell'istante ($/giorno)
 * @param {object} [extra]           campi facoltativi conservati con il campione (capitale in banda…)
 * @returns {{scritto:boolean, motivo?:string, giorno?:string, campioni?:number}}
 */
function registraCampione({ tMs = Date.now(), tassoUsdPerDay = null, capitaleInBandaUsd = null } = {}, deps = {}) {
  // REGOLA 3: un tasso non finito non è uno zero. Nessuna riga, e il buco resterà dichiarato.
  if (!Number.isFinite(tassoUsdPerDay) || tassoUsdPerDay < 0) {
    return { scritto: false, motivo: 'tasso non misurabile: si lascia un buco invece di scrivere uno zero' };
  }
  if (!Number.isFinite(tMs)) return { scritto: false, motivo: 'istante non valido' };

  const file = deps.file || fileCampioni();
  const dati = (deps.leggi || leggiGrezzo)(file);
  const g = giornoDi(tMs);
  if (!Array.isArray(dati.giorni[g])) dati.giorni[g] = [];
  dati.giorni[g].push({
    t: Math.round(tMs),
    r: Math.round(tassoUsdPerDay * 1e6) / 1e6,
    ...(Number.isFinite(capitaleInBandaUsd) ? { c: Math.round(capitaleInBandaUsd * 100) / 100 } : {}),
  });

  // Potatura: si tengono gli ultimi GIORNI_TENUTI per chiave, non per data corrente — così un
  // recupero a ritroso che scrive una giornata vecchia non si autocancella al giro dopo.
  const chiavi = Object.keys(dati.giorni).sort();
  while (chiavi.length > GIORNI_TENUTI) delete dati.giorni[chiavi.shift()];

  dati.aggiornatoIso = new Date(tMs).toISOString();
  (deps.scrivi || scriviAtomico)(file, dati);
  return { scritto: true, giorno: g, campioni: dati.giorni[g].length };
}

/** I campioni di un giorno, ordinati. */
function campioniDi(giorno, deps = {}) {
  const dati = (deps.leggi || leggiGrezzo)(deps.file || fileCampioni());
  const a = Array.isArray(dati.giorni[giorno]) ? dati.giorni[giorno] : [];
  return a.filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.r)).sort((x, y) => x.t - y.t);
}

/**
 * L'INTEGRALE: Σ (tasso_i × durata_i).
 *
 * @param {string} giorno      'YYYY-MM-DD' UTC
 * @param {Array}  [campioni]  se assenti si leggono dal registro
 * @param {number} [now]       per non attribuire a un giorno in corso ore che non sono passate
 * @returns {{usd:number|null, coperturaFrazione:number, completo:boolean, campioni:number,
 *           orizzonteMs:number, copertoMs:number, motivo:string|null}}
 */
function integra({ giorno, campioni = null, now = Date.now(), env = process.env } = {}, deps = {}) {
  const c = Array.isArray(campioni) ? [...campioni].sort((x, y) => x.t - y.t) : campioniDi(giorno, deps);
  const t0 = inizioGiornoMs(giorno);
  if (!Number.isFinite(t0)) {
    return { usd: null, coperturaFrazione: 0, completo: false, campioni: 0, orizzonteMs: 0, copertoMs: 0, motivo: 'giorno non interpretabile' };
  }
  // Il giorno finisce a mezzanotte, ma se è ancora in corso l'orizzonte è «fin qui»: attribuire a una
  // giornata ore che non sono ancora passate la farebbe sembrare scoperta quando invece è solo giovane.
  const fine = Math.min(t0 + GIORNO_MS, Math.max(t0, now));
  const orizzonteMs = Math.max(0, fine - t0);
  if (!c.length) {
    return { usd: null, coperturaFrazione: 0, completo: false, campioni: 0, orizzonteMs, copertoMs: 0, motivo: 'nessun campione per questa giornata' };
  }

  const estMax = estensioneMaxMs(env);
  let usd = 0; let copertoMs = 0;
  for (let i = 0; i < c.length; i++) {
    const inizio = Math.max(t0, c[i].t);
    if (inizio >= fine) continue;
    const prossimo = (i + 1 < c.length) ? c[i + 1].t : Infinity;
    // REGOLA 1: fino al prossimo campione, ma mai oltre due passi — e mai oltre la fine dell'orizzonte.
    const durata = Math.max(0, Math.min(prossimo, inizio + estMax, fine) - inizio);
    if (durata <= 0) continue;
    usd += c[i].r * (durata / GIORNO_MS);
    copertoMs += durata;
  }

  const coperturaFrazione = orizzonteMs > 0 ? Math.min(1, copertoMs / orizzonteMs) : 0;
  return {
    usd: Math.round(usd * 1e4) / 1e4,
    coperturaFrazione: Math.round(coperturaFrazione * 1e4) / 1e4,
    // «Completo» non vuol dire perfetto: vuol dire che non ci sono buchi che cambierebbero il verdetto.
    completo: coperturaFrazione >= 0.95,
    campioni: c.length,
    orizzonteMs, copertoMs,
    motivo: null,
  };
}

module.exports = {
  registraCampione, integra, campioniDi, giornoDi, passoMs, estensioneMaxMs, fileCampioni,
  PASSO_DEFAULT_MS, PASSO_MIN_MS, PASSO_MAX_MS, FATTORE_ESTENSIONE, GIORNI_TENUTI,
};
