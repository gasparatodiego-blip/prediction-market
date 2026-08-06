'use strict';
// lib/maker/risk-classifier.js — SAFE o RISK, DECISO IN UN POSTO SOLO.
//
// ═══ COSA RISPONDE ═══════════════════════════════════════════════════════════════════════════════════
// Dato UN ordine a riposo, oppure UNA proposta di mercato, dice se c'è un motivo di rischio e QUALE:
//
//     { isRisk: boolean, flags: string[] }
//
// ═══ PERCHÉ UN MODULO E NON TRE CONDIZIONI SPARSE ════════════════════════════════════════════════════
// La stessa classificazione serve in TRE punti che oggi non si parlano:
//   a) i bucket «Safe» / «Risk» degli ordini a riposo (tab Riepilogo e tab Risk)
//   b) i totali in dollari impegnati per bucket, in cima alla pagina (Libero / Safe / Risk)
//   c) il pre-filtro dell'allocatore quando gira col profilo Risk
// Tre copie della stessa regola divergono: è già successo in questo repo (vedi motivi-blocco.js, dove
// «il pulsante è spento» e «i motivi sono questi» erano due espressioni diverse — e sono divergute).
// Qui la regola è UNA funzione pura, e i tre chiamanti la invocano.
//
// ═══ NESSUNA SOGLIA È INVENTATA QUI ══════════════════════════════════════════════════════════════════
// Tutte e tre le soglie sono IMPORTATE dal posto che già le possedeva. Se una cambia là, cambia qui —
// che è l'unico modo perché «la soglia usata dal filtro» e «la soglia scritta nell'etichetta» non
// possano raccontare due numeri diversi:
//
//   · VENUE_GTD_MIN_FUTURE_SEC = 180   lib/maker/order-ttl.js — il pavimento di tradabilità del venue.
//     Fonte primaria Polymarket: «the expiration must be at least 3 minutes in the future». Sotto
//     questa soglia il venue RIFIUTA l'ordine: non è «rischioso», è impossibile.
//   · MIN_HORIZON_DAYS = 2             lib/rewards/horizon.js — il minimo che l'ottimizzatore Safe
//     pretende per rientrare dal costo di adverse selection. È la soglia che il profilo Safe applica.
//   · STALE_S = 300                    lib/rewards/plan-to-orders.js — «dato troppo vecchio», 5 minuti.
//     Lo stesso valore che RewardsAllocatePanel dichiara e che esclude una riga dai totali.
//
// ═══ «NON LO SO» NON È «VA BENE», E NEMMENO «È RISCHIOSO» ════════════════════════════════════════════
// Una banda non giudicabile (regole del venue illeggibili, nessun mid) NON diventa un flag di rischio:
// i flag qui sono affermazioni misurate, e «fuori banda» detto senza aver potuto misurare la banda
// sarebbe una bugia nella direzione opposta. Ma nemmeno finisce zitta nel bucket Safe — perché è
// esattamente così che si finisce per credere che del capitale stia maturando quando non si sa.
// Viaggia in `unknowns`, e chi somma i dollari la tiene FUORI da entrambi i bucket, in un terzo numero
// dichiarato (vedi `bucketizza`). È la stessa regola che operator-board.js applica già con
// `unjudgeableCapitalUsd` e `unknownBandCount`: qui non si inventa una convenzione nuova.
//
// ═══ «PRIMO SUL BOOK» — LA REGOLA C'È, IL DATO PER APPLICARLA QUI NO ═════════════════════════════════
// lib/maker/top-of-book.js implementa davvero la regola (planBehindBest → `onTop`), e questo modulo NON
// ne scrive una seconda copia. Ma per decidere `onTop` serve la scala completa del book MENO i nostri
// ordini, e né una riga di ordine a riposo né una proposta di mercato la portano con sé:
// /api/maker/board pubblica bestBid/bestAsk, non i livelli. Quindi il flag è ACCETTATO ma non calcolato:
// chi ha il book davanti (il motore) può passare `onTop` già deciso da top-of-book.js e il flag compare;
// chi non ce l'ha lo omette e la classificazione resta muta sul punto, invece di indovinare.

const { VENUE_GTD_MIN_FUTURE_SEC } = require('./order-ttl');
const { MIN_HORIZON_DAYS } = require('../rewards/horizon');
const { STALE_S } = require('../rewards/plan-to-orders');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il pavimento del venue, in minuti: 180 s = 3 min. Derivato, mai riscritto. */
const VENUE_FLOOR_MINUTES = VENUE_GTD_MIN_FUTURE_SEC / 60;
/** La soglia dell'ottimizzatore Safe, in minuti: 2 giorni. Derivata, mai riscritta. */
const SAFE_FLOOR_MINUTES = MIN_HORIZON_DAYS * 24 * 60;
/** «Dato troppo vecchio», in secondi. */
const STALE_SECONDS = STALE_S;

const FLAG_FUORI_BANDA = 'fuori banda';
const FLAG_STALE = 'dati stale';
const FLAG_SOTTO_PAVIMENTO = 'sotto il minimo del venue';
const FLAG_PRIMO_SUL_BOOK = 'primo sul book';

/**
 * «scade fra Xm» con X CALCOLATO, e nell'unità in cui il numero si legge.
 * La finestra di rischio va da 3 minuti a 2 giorni: scriverla sempre in minuti darebbe «scade fra
 * 2870m», che è un numero che nessuno converte a mente. Sotto i 90 minuti — il caso che l'operatore
 * deve vedere subito — resta esattamente la forma «scade fra 8 min» del mockup.
 */
function etichettaScadenza(minuti) {
  if (!fin(minuti)) return null;
  if (minuti < 90) return `scade fra ${Math.max(0, Math.round(minuti))} min`;
  const ore = minuti / 60;
  if (ore < 36) return `scade fra ${ore.toFixed(ore < 10 ? 1 : 0)} h`;
  const giorni = ore / 24;
  return `scade fra ${giorni.toFixed(1)} g`;
}

/**
 * Minuti alla risoluzione, dai campi che le varie sorgenti portano davvero. Nessuno viene inventato:
 * se non ce n'è nessuno leggibile la risposta è null e la regola scadenza non si applica.
 *
 * Sorgenti accettate, in ordine di precedenza:
 *   minutesToClose      già in minuti (market-clock)
 *   hoursToResolution   BoardMarket
 *   endDate + nowMs     ISO, come horizon.js
 */
function minutiAllaChiusura({ minutesToClose, hoursToResolution, endDate, nowMs } = {}) {
  if (fin(minutesToClose)) return minutesToClose;
  if (fin(hoursToResolution)) return hoursToResolution * 60;
  if (typeof endDate === 'string' && endDate.trim() && fin(nowMs)) {
    const t = Date.parse(endDate);
    if (Number.isFinite(t)) return (t - nowMs) / 60000;
  }
  return null;
}

/**
 * IL VERDETTO SULLA BANDA, tri-stato, senza mai collassare null su false.
 *   true  → misurato fuori banda
 *   false → misurato dentro
 *   null  → non giudicabile
 * Accetta il verdetto già pronto (`outOfBand`/`inBand`, come lo pubblica operator-board) oppure lo
 * misura da prezzo + estremi della banda. Non ricostruisce la banda dal raggio: bandLo/bandHi sono già
 * calcolati a monte dallo stesso mid di scoring, e rifarlo qui vorrebbe dire poter rispondere diverso.
 */
function fuoriBanda({ outOfBand, inBand, price, bandLo, bandHi } = {}) {
  if (outOfBand === true || outOfBand === false) return outOfBand;
  if (inBand === true || inBand === false) return !inBand;
  if (fin(price) && fin(bandLo) && fin(bandHi)) return price < bandLo - 1e-9 || price > bandHi + 1e-9;
  return null;
}

/**
 * LA CLASSIFICAZIONE.
 *
 * @param {object} soggetto  un ordine a riposo o una proposta di mercato. Campi tutti opzionali: quello
 *   che manca non viene indovinato, e la regola che lo usava semplicemente non si pronuncia.
 *     price, bandLo, bandHi, inBand, outOfBand   → banda
 *     minutesToClose | hoursToResolution | endDate → scadenza
 *     dataAgeSec | midAgeSec | newestTsMs          → freschezza
 *     onTop                                        → già deciso da lib/maker/top-of-book.js, opzionale
 * @param {object} opts
 *     nowMs           orologio (serve solo per endDate/newestTsMs)
 *     safeFloorMinutes  override della soglia Safe (il profilo Risk passa il pavimento del venue)
 * @returns {{isRisk:boolean, flags:string[], unknowns:string[], tradable:boolean,
 *            minutesToClose:number|null, dataAgeSec:number|null, outOfBand:boolean|null}}
 */
function classifyRisk(soggetto = {}, opts = {}) {
  const nowMs = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const safeFloor = fin(opts.safeFloorMinutes) ? opts.safeFloorMinutes : SAFE_FLOOR_MINUTES;

  const flags = [];
  const unknowns = [];

  // ── 1. FUORI BANDA ────────────────────────────────────────────────────────────────────────────────
  const ob = fuoriBanda(soggetto);
  if (ob === true) flags.push(FLAG_FUORI_BANDA);
  else if (ob === null) unknowns.push('banda non giudicabile');

  // ── 2. SCADENZA ───────────────────────────────────────────────────────────────────────────────────
  const min = minutiAllaChiusura({ ...soggetto, nowMs });
  let tradable = true;
  if (min == null) {
    unknowns.push('scadenza non leggibile');
  } else if (min <= VENUE_FLOOR_MINUTES) {
    // Sotto il pavimento del venue non è «rischioso»: il venue rifiuta l'ordine. Un ordine a riposo che
    // ci è arrivato dentro sta per morire, e non appartiene al bucket Safe in nessuna lettura.
    flags.push(FLAG_SOTTO_PAVIMENTO);
    tradable = false;
  } else if (min < safeFloor) {
    const e = etichettaScadenza(min);
    if (e) flags.push(e);
  }

  // ── 3. DATI STALE ─────────────────────────────────────────────────────────────────────────────────
  let ageS = null;
  if (fin(soggetto.dataAgeSec)) ageS = soggetto.dataAgeSec;
  else if (fin(soggetto.midAgeSec)) ageS = soggetto.midAgeSec;
  else if (fin(soggetto.newestTsMs)) ageS = Math.max(0, (nowMs - soggetto.newestTsMs) / 1000);
  if (ageS == null) unknowns.push('età del dato non leggibile');
  else if (ageS > STALE_SECONDS) flags.push(FLAG_STALE);

  // ── 4. PRIMO SUL BOOK (solo se qualcuno l'ha già deciso con top-of-book.js) ───────────────────────
  if (soggetto.onTop === true) flags.push(FLAG_PRIMO_SUL_BOOK);

  return {
    isRisk: flags.length > 0,
    flags,
    unknowns,
    tradable,
    minutesToClose: min,
    dataAgeSec: ageS,
    outOfBand: ob,
  };
}

/**
 * I BUCKET E I LORO DOLLARI, in una passata sola. È il punto (b): i tre numeri in cima alla pagina.
 *
 * `nonGiudicabileUsd` esiste perché un ordine di cui non si è potuto misurare NIENTE non può essere
 * sommato a «Safe» — sarebbe una rassicurazione costruita su un dato assente. Un ordine con qualche
 * incognita ma almeno un flag misurato è Risk e basta: il flag c'è, ed è quello che conta.
 *
 * @param {Array} ordini     righe con `restingNotionalUsd` (o `notionalUsd`) + i campi di classifyRisk
 * @param {object} opts      passato a classifyRisk (nowMs, safeFloorMinutes); `contesto` opzionale è una
 *                           Map marketId → campi di mercato (scadenza, età del dato) da unire alla riga:
 *                           gli ordini di /api/maker/board non portano scadenza né età, i mercati sì.
 */
function bucketizza(ordini = [], opts = {}) {
  const contesto = opts.contesto instanceof Map ? opts.contesto : null;
  const safe = [];
  const risk = [];
  const nonGiudicabili = [];
  let safeUsd = 0, riskUsd = 0, nonGiudicabileUsd = 0;

  for (const o of Array.isArray(ordini) ? ordini : []) {
    if (!o) continue;
    const extra = contesto && o.marketId ? (contesto.get(String(o.marketId).toLowerCase()) || null) : null;
    const soggetto = extra ? { ...extra, ...scartaNulli(o) } : o;
    const verdetto = classifyRisk(soggetto, opts);
    const usd = fin(o.restingNotionalUsd) ? o.restingNotionalUsd
      : fin(o.notionalUsd) ? o.notionalUsd
        : null;
    const riga = { ...o, rischio: verdetto };

    if (verdetto.isRisk) {
      risk.push(riga);
      if (fin(usd)) riskUsd += usd;
    } else if (verdetto.unknowns.length > 0) {
      // Niente di misurato contro, ma nemmeno niente di misurato a favore.
      nonGiudicabili.push(riga);
      if (fin(usd)) nonGiudicabileUsd += usd;
    } else {
      safe.push(riga);
      if (fin(usd)) safeUsd += usd;
    }
  }

  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    safe, risk, nonGiudicabili,
    safeUsd: r2(safeUsd), riskUsd: r2(riskUsd), nonGiudicabileUsd: r2(nonGiudicabileUsd),
    impegnatoUsd: r2(safeUsd + riskUsd + nonGiudicabileUsd),
  };
}

/** Le chiavi a null della riga non devono cancellare quelle valorizzate del contesto di mercato. */
function scartaNulli(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] != null) out[k] = o[k];
  return out;
}

module.exports = {
  classifyRisk,
  bucketizza,
  etichettaScadenza,
  minutiAllaChiusura,
  fuoriBanda,
  VENUE_FLOOR_MINUTES,
  SAFE_FLOOR_MINUTES,
  STALE_SECONDS,
  FLAG_FUORI_BANDA,
  FLAG_STALE,
  FLAG_SOTTO_PAVIMENTO,
  FLAG_PRIMO_SUL_BOOK,
};
