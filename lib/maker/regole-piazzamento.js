'use strict';
// lib/maker/regole-piazzamento.js — I DUE PERCORSI, E L'INSTRADAMENTO FRA LORO.
//
// ═══ COSA DECIDE ═════════════════════════════════════════════════════════════════════════════════════
// Dato un mercato, un lato e il book vivo: si piazza? e a quale prezzo? La risposta passa da UNO dei due
// percorsi, mai da entrambi, mai da un mescolamento:
//
//   SAFE — sei controlli, TUTTI devono passare:
//     1 tick/banda            controlloMaiPrimo → top-of-book.js   MAI il livello migliore assoluto
//     2 depth adattiva        findAdaptiveDepthLevelSafe      pavimento $15 cumulato dal 2° livello
//     3 volatilità 8h         volatilitaSafe                  ≥2× banda ⇒ margine dal bordo ×2
//     4 spread anomalo        spreadAnomaloSafe               ≥3× la media mobile ⇒ blocco
//     5 quota massima 65%     dentro findAdaptiveDepthLevelSafe (è parte della ricerca del livello)
//     6 esposizione 30%       lib/rewards/concentration.js    (la funzione che usa già «Ottimizza»)
//
//   RISK — tre controlli, con il controllo di BASE davanti a tutti:
//     0 tick/banda            top-of-book.js                  MAI il livello migliore assoluto
//     1 tick + depth          findAdaptiveDepthLevelRisk      pavimento $20 sul singolo livello
//     2 nervosismo 5min       nervosismoRisk                  ≥0,5× banda ⇒ nervoso
//     3 spostamento se nervoso  dentro findAdaptiveDepthLevelRisk (un tick più lontano, dentro banda)
//   più i tetti di bucket già esistenti (lib/maker/risk-caps.js), che il chiamante applica a monte.
//
// ═══ PERCHÉ L'INSTRADAMENTO STA QUI E NON NEL MOTORE ═════════════════════════════════════════════════
// Perché «quale percorso» è una decisione, e le decisioni di questo repo vivono in funzioni pure che si
// possono esercitare. Il motore chiama QUESTA e riceve un verdetto; non contiene nessun `if (profilo)`.
// La differenza non è estetica: è ciò che permette al test di dimostrare che i due percorsi non si
// mescolano, cosa che un ramo dentro un ciclo da 5 secondi non lascerebbe verificare.
//
// ═══ NESSUNO STATO, NÉ FRA MERCATI NÉ FRA PERCORSI ═══════════════════════════════════════════════════
// Nessuna cache, nessuna Map di modulo, nessun contatore. Ogni valutazione riceve il book che il
// chiamante ha appena letto e risponde solo su quello. Due mercati valutati nello stesso giro non
// possono influenzarsi, e nemmeno lo stesso mercato fra due giri.

const { findAdaptiveDepthLevelSafe, findAdaptiveDepthLevelRisk } = require('./depth-adattiva');
// «MAI PRIMI SUL LIBRO» — il controllo di BASE, e vale per ENTRAMBI i profili. Vedi la nota in
// `valutaRisk`: non è alternativo alla regola tick2/tick3, è complementare.
const { bestOtherBid, planBehindBest } = require('./top-of-book');
const { volatilitaSafe, spreadAnomaloSafe, nervosismoRisk } = require('./volatilita-mercato');
// IL TETTO DEL 30% PER MERCATO — la stessa funzione che «Ottimizza capitale» usa per costruire il
// piano. Riusata, non riscritta: due strade che rispondono alla stessa domanda devono usare lo stesso
// numero, ed è la ragione per cui quel modulo esiste.
const { capPerMarketUsd, CONCENTRATION_CAP_FRAC } = require('../rewards/concentration');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Un controllo che non è passato, con il suo nome e il suo motivo. Mai un booleano nudo. */
const bocciato = (controllo, motivo, extra = {}) => ({ controllo, motivo, ...extra });

/**
 * IL CONTROLLO DI BASE — «MAI PRIMI SUL LIBRO», PER TUTTI E DUE I PROFILI.
 *
 * ═══ PERCHÉ È SEPARATO DALLA REGOLA DI PROFONDITÀ ═══════════════════════════════════════════════════
 * Rispondono a due domande diverse e nessuna implica l'altra:
 *
 *   · questa   → «c'è qualcun altro DAVANTI a me?» Se siamo il miglior prezzo del lato, siamo i primi
 *                a essere eseguiti da chi sa qualcosa che noi non sappiamo. È il costo che il reward
 *                non compensa, e vale identico su un mercato Safe e su uno Risk.
 *   · la depth → «il gradino su cui mi appoggio regge?» Si può essere perfettamente non-primi e stare
 *                comunque su un livello con $3 davanti.
 *
 * ═══ LA LACUNA CHE QUESTO CHIUDE (6 agosto 2026) ════════════════════════════════════════════════════
 * `valutaRisk` applicava SOLO la sua regola tick2/tick3. Il ragionamento implicito era che partire dal
 * SECONDO livello impedisse già di essere primi — ma è falso: il secondo livello della scala ALTRUI,
 * tolti i nostri ordini, può benissimo essere il miglior prezzo assoluto se davanti c'era solo roba
 * nostra. Il percorso Safe il controllo ce l'aveva (a monte, in top-of-book); quello Risk no.
 *
 * Si esegue PRIMA della profondità: se si fallisce qui, calcolare la depth è lavoro sprecato.
 */
function controlloMaiPrimo({ bookLevels, ownOrders, tick, scoringMid, bandRadiusCents, side, deps = {} }) {
  const bo = (deps.bestOtherBid || bestOtherBid)({ levels: bookLevels, ownOrders: ownOrders || [], tick });
  if (!bo || bo.readable !== true) {
    return { ok: false, motivo: `miglior prezzo altrui non leggibile: ${bo ? bo.reason : 'nessuna risposta'}`
      + ' — non si piazza senza sapere se si finirebbe primi', bestOther: null, alone: null };
  }
  if (bo.alone === true) {
    // Nessun altro su questo lato: «primi» non descrive niente, non esiste una coda in cui accodarsi.
    // È la premessa dichiarata in top-of-book.js, e non la si riscrive qui: la si rispetta.
    return { ok: true, motivo: 'nessun altro su questo lato: «primi» non descrive niente', bestOther: null, alone: true };
  }
  const piano = (deps.planBehindBest || planBehindBest)({
    bestOther: bo.price, tick, scoringMid, bandRadiusCents,
  });
  if (piano && piano.quotabile === false) {
    return { ok: false, motivo: `un tick dietro il miglior prezzo altrui (${bo.price}) uscirebbe dalla banda premiante: ${piano.reason}`,
      bestOther: bo.price, alone: false };
  }
  if (piano && piano.onTop === true) {
    return { ok: false, motivo: 'si finirebbe in cima al libro: non si resta primi nemmeno per restare premianti',
      bestOther: bo.price, alone: false };
  }
  return { ok: true, motivo: `un tick dietro ${bo.price} resta in banda`, bestOther: bo.price, alone: false,
    prezzoSuggerito: piano ? piano.price : null };
}

/**
 * PERCORSO SAFE — tutti e sei, e il primo che fallisce ferma il giro su quel lato.
 *
 * L'ordine dei controlli è scelto: prima quelli che NON dipendono dal book (volatilità, spread,
 * esposizione), poi la ricerca del livello. Un mercato bloccato dallo spread non ha motivo di far
 * scorrere la scala del book, e il motivo che l'operatore legge è quello vero invece dell'ultimo.
 *
 * @param {object} a
 *   marketId, side, bookLevels, bandBounds{lo,hi}, bandRadiusCents, tick, ownOrders,
 *   proposedSize, spreadCorrente, saldoUsd, esposizioneMercatoUsd, now, deps
 * @returns {{ok:boolean, price:number|null, level:number|null, profilo:'safe',
 *            controlli:object, bocciature:Array, margineMultiplo:number, reason:string}}
 */
function valutaSafe(a = {}) {
  const {
    marketId = null, side = 'BUY', bookLevels = null, bandBounds = null, bandRadiusCents = null,
    tick = null, ownOrders = [], ownOrderIds = null, proposedSize = null,
    spreadCorrente = null, saldoUsd = null, esposizioneMercatoUsd = 0,
    now = Date.now(), deps = {},
  } = a;

  const bocciature = [];
  const controlli = {};

  // ── 1 · MAI PRIMI SUL LIBRO — lo stesso controllo di base del percorso Risk, la stessa funzione ──
  // Il percorso Safe lo aveva già a monte (il motore lo applica in auto-reprice). Chiamarlo anche qui
  // rende il verdetto AUTOSUFFICIENTE: chi legge `valutaSafe` non deve sapere che qualcun altro ha già
  // controllato. E rende i due percorsi confrontabili: stesso controllo, stessa funzione, stesso nome.
  const base = (deps.controlloMaiPrimo || controlloMaiPrimo)({
    bookLevels, ownOrders, tick, scoringMid: a.scoringMid, bandRadiusCents, side, deps,
  });
  controlli.maiPrimo = base;
  if (!base.ok) bocciature.push(bocciato('mai-primo-sul-libro', base.motivo, { bestOther: base.bestOther }));

  // ── 3 · VOLATILITÀ 8h ───────────────────────────────────────────────────────────────────────────
  // Non boccia mai da sola: cambia il MARGINE richiesto dal bordo. Il moltiplicatore viaggia nel
  // verdetto perché il chiamante (che conosce il tick) lo applichi al bordo banda.
  const vol = (deps.volatilitaSafe || volatilitaSafe)({ marketId, bandRadiusCents, now, deps });
  controlli.volatilita = vol;

  // ── 4 · SPREAD ANOMALO ──────────────────────────────────────────────────────────────────────────
  const spr = (deps.spreadAnomaloSafe || spreadAnomaloSafe)({ marketId, spreadCorrente, now, deps });
  controlli.spread = spr;
  if (spr.bloccato) bocciature.push(bocciato('spread-anomalo', spr.motivo, { rapporto: spr.rapporto }));

  // ── 6 · ESPOSIZIONE NETTA PER MERCATO (30% del saldo) ───────────────────────────────────────────
  // Il tetto viene da lib/rewards/concentration.js — lo stesso che il pianificatore applica quando
  // costruisce la griglia delle size. Qui è un controllo al momento del piazzamento: il piano può
  // essere stato fatto su un saldo diverso da quello di adesso.
  const capMercato = capPerMarketUsd(saldoUsd);
  const nuovaEsposizione = (fin(esposizioneMercatoUsd) ? esposizioneMercatoUsd : 0)
    + (fin(proposedSize) && fin(a.proposedPrice) ? proposedSize * a.proposedPrice : 0);
  controlli.esposizione = { capUsd: capMercato, attualeUsd: esposizioneMercatoUsd, dopoUsd: +nuovaEsposizione.toFixed(2), frac: CONCENTRATION_CAP_FRAC };
  if (capMercato == null) {
    bocciature.push(bocciato('esposizione-mercato',
      'saldo non leggibile: il tetto del 30% per mercato non è calcolabile, e un tetto che non si può calcolare non è un tetto ampio'));
  } else if (nuovaEsposizione > capMercato + 1e-9) {
    bocciature.push(bocciato('esposizione-mercato',
      `il mercato arriverebbe a $${nuovaEsposizione.toFixed(2)}, oltre il ${Math.round(CONCENTRATION_CAP_FRAC * 100)}% del saldo ($${capMercato.toFixed(2)})`,
      { capUsd: capMercato }));
  }

  // ── 2 + 5 · DEPTH ADATTIVA CON QUOTA MASSIMA ────────────────────────────────────────────────────
  const liv = (deps.findAdaptiveDepthLevelSafe || findAdaptiveDepthLevelSafe)({
    marketId, side, bookLevels, bandBounds, ownOrders, ownOrderIds, proposedSize, tick,
  });
  controlli.depth = liv;
  if (!liv.ok) bocciature.push(bocciato('depth-adattiva', liv.reason, { scartati: liv.scartati }));

  const ok = bocciature.length === 0;
  return {
    ok, profilo: 'safe',
    price: ok ? liv.price : null,
    level: ok ? liv.level : null,
    margineMultiplo: vol.margineMultiplo,
    controlli, bocciature,
    reason: ok
      ? `sei controlli superati · livello ${liv.level} @${liv.price} · margine dal bordo ×${vol.margineMultiplo} (${vol.misurato ? 'volatilità misurata' : 'volatilità non misurabile'})`
      : bocciature.map((b) => `${b.controllo}: ${b.motivo}`).join(' · '),
  };
}

/**
 * PERCORSO RISK — tre controlli. Niente spread, niente quota massima, niente esposizione per mercato:
 * quei tre non esistono su questo percorso, e non è una dimenticanza — è la specifica.
 *
 * I tetti di bucket (RISK_BUCKET_CAP_PCT / RISK_PER_MARKET_CAP_PCT, lib/maker/risk-caps.js) restano a
 * carico del chiamante, che è l'unico a conoscere l'esposizione dell'INTERO bucket.
 */
function valutaRisk(a = {}) {
  const {
    marketId = null, side = 'BUY', bookLevels = null, bandBounds = null, bandRadiusCents = null,
    tick = null, ownOrders = [], ownOrderIds = null, now = Date.now(), deps = {},
  } = a;

  const bocciature = [];
  const controlli = {};

  // ── 0 · MAI PRIMI SUL LIBRO — il controllo di BASE, prima di tutto il resto ─────────────────────
  // Se si fallisce qui non serve calcolare nessuna profondità: l'ordine non si piazza comunque.
  const base = (deps.controlloMaiPrimo || controlloMaiPrimo)({
    bookLevels, ownOrders, tick, scoringMid: a.scoringMid, bandRadiusCents, side, deps,
  });
  controlli.maiPrimo = base;
  if (!base.ok) {
    return {
      ok: false, profilo: 'risk', price: null, level: null, nervous: false,
      controlli, bocciature: [bocciato('mai-primo-sul-libro', base.motivo, { bestOther: base.bestOther })],
      reason: `mai-primo-sul-libro: ${base.motivo}`,
    };
  }

  // ── 2 · NERVOSISMO 5 min ────────────────────────────────────────────────────────────────────────
  const nerv = (deps.nervosismoRisk || nervosismoRisk)({ marketId, bandRadiusCents, now, deps });
  controlli.nervosismo = nerv;

  // ── 1 + 3 · TICK + DEPTH, spostati di uno se nervoso ────────────────────────────────────────────
  const liv = (deps.findAdaptiveDepthLevelRisk || findAdaptiveDepthLevelRisk)({
    marketId, side, bookLevels, bandBounds, ownOrders, ownOrderIds, tick,
    nervousMarket: nerv.nervoso === true,
  });
  controlli.depth = liv;
  if (!liv.ok) bocciature.push(bocciato('depth-adattiva-risk', liv.reason, { tentativi: liv.tentativi }));

  const ok = bocciature.length === 0;
  return {
    ok, profilo: 'risk',
    price: ok ? liv.price : null,
    level: ok ? liv.level : null,
    nervous: nerv.nervoso === true,
    controlli, bocciature,
    reason: ok
      ? `tre controlli superati · livello ${liv.level} @${liv.price}${nerv.nervoso ? ' (spostato: mercato nervoso)' : ''}`
      : bocciature.map((b) => `${b.controllo}: ${b.motivo}`).join(' · '),
  };
}

/**
 * L'INSTRADAMENTO. Un mercato Safe non attraversa mai le regole Risk e viceversa.
 *
 * `profilo` è richiesto ESPLICITAMENTE: non viene dedotto qui, non ha un difetto «safe» comodo che
 * lascerebbe passare un mercato Risk dal percorso sbagliato per una chiamata scritta male. Un profilo
 * assente o sconosciuto NON sceglie: rifiuta, e lo dice.
 */
function valutaPiazzamento(a = {}) {
  const p = typeof a.profilo === 'string' ? a.profilo.trim().toLowerCase() : '';
  if (p === 'safe') return valutaSafe(a);
  if (p === 'risk') return valutaRisk(a);
  return {
    ok: false, profilo: null, price: null, level: null, controlli: {},
    bocciature: [bocciato('profilo', `profilo non riconosciuto (${a.profilo ?? 'assente'}): non si sceglie un percorso per difetto`)],
    reason: 'profilo non riconosciuto: nessun percorso applicato',
  };
}

module.exports = { valutaPiazzamento, valutaSafe, valutaRisk, controlloMaiPrimo };
