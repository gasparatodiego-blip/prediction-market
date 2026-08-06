'use strict';
// lib/maker/depth-guard.js — QUANTA ROBA ALTRUI C'È DAVANTI, E QUANTO DEL LIVELLO SAREMMO NOI.
//
// ═══ COSA CHIEDE ═════════════════════════════════════════════════════════════════════════════════════
// Due domande, entrambe sul singolo livello di prezzo a cui un ordine riposerebbe:
//
//   1. C'è abbastanza size di ALTRI davanti (a quel prezzo o meglio) perché il nostro ordine non sia
//      il primo a essere eseguito quando il prezzo si muove? Soglia: DEPTH_MIN_AHEAD_USD.
//   2. Saremmo noi la maggior parte di quel livello? Se sì, «c'è profondità» sarebbe una descrizione
//      di noi stessi. Soglia: MAX_SELF_SHARE_AT_LEVEL.
//
// ═══ PERCHÉ È UNA REGOLA DIVERSA DA «MAI PRIMI SUL BOOK» ═════════════════════════════════════════════
// `top-of-book.js` risponde a «a QUALE PREZZO mi metto»: sceglie un tick dietro al miglior prezzo
// altrui, e si ferma al bordo della banda. È una regola di POSIZIONE.
//
// Questa è una regola di CONSISTENZA: si può essere perfettamente «non primi» e stare comunque su un
// livello dove davanti c'è $3 di qualcun altro e $200 nostri. In quel caso non si è in cima al book per
// modo di dire, ma si è i primi a essere presi da qualunque movimento serio — la profondità davanti è
// nominale. Le due regole misurano cose diverse e nessuna implica l'altra.
//
// ═══ I NOSTRI ORDINI NON SONO «GLI ALTRI», E LA SOTTRAZIONE NON SI RISCRIVE QUI ══════════════════════
// L'esclusione dei nostri ordini è ESATTAMENTE il difetto che ha prodotto `othersLadder` in
// top-of-book.js: senza, il motore vede la propria size, la scambia per concorrenza e conclude che c'è
// profondità davanti quando la profondità è sua. Quella funzione fa già la sottrazione per livello,
// somma due nostri ordini sullo stesso prezzo, e distingue «il feed non ha parlato» da «il feed dice
// che non c'è nessuno». Questo modulo la CHIAMA. Non ne scrive una seconda: due sottrazioni della
// stessa cosa sono due posti da cui divergere, ed è già successo.
//
// ═══ «NON LO SO» NON È «VIA LIBERA» ══════════════════════════════════════════════════════════════════
// Se i livelli non sono leggibili, se il tick non c'è, se il prezzo non è un numero — la risposta è
// `allowed: false` con il motivo. Un dato mancante non autorizza: è la stessa regola che governa il
// mid stantio in auto-reprice e il kill-switch illeggibile in bulk-allocate.
//
// ═══ PURO ═══════════════════════════════════════════════════════════════════════════════════════════
// Nessun `fs`, nessuna rete, nessun venue, nessun orologio. Chi chiama porta il book che ha appena
// letto; questo modulo non ha modo di riusare una lettura vecchia perché non ne conserva nessuna.

const { othersLadder } = require('./top-of-book');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── LE SOGLIE, DICHIARATE E IN UN POSTO SOLO ──────────────────────────────────────────────────────
/** Almeno questo controvalore di size ALTRUI al livello o migliore. In dollari, non in share: una
 *  share a 0,05 e una a 0,95 non sono la stessa profondità, e contarle uguali renderebbe la soglia
 *  venti volte più permissiva sui mercati a prezzo basso. */
const DEPTH_MIN_AHEAD_USD = 50;
/** La nostra size non deve superare questa frazione del totale a riposo su quel livello (nostra +
 *  altrui). Sopra, «il livello è profondo» sarebbe una frase su noi stessi. */
const MAX_SELF_SHARE_AT_LEVEL = 0.40;

/**
 * «A quel prezzo o meglio», dal punto di vista di chi compra o di chi vende.
 *
 * Per un BID, «meglio» vuol dire PIÙ ALTO: chi offre più di noi viene eseguito prima di noi, quindi è
 * davanti. Per un ASK, «meglio» vuol dire PIÙ BASSO. È lo stesso specchio che il resto del maker
 * applica al lato NO (un ordine NO a q è un ordine YES a 1−q) e non se ne inventa un secondo.
 */
function davantiA(price, livelloPrice, side) {
  const eps = 1e-9;
  return side === 'SELL'
    ? livelloPrice <= price + eps
    : livelloPrice >= price - eps;
}

/**
 * LA REGOLA.
 *
 * @param {object} a
 *   marketId            solo per il referto: questa funzione non lo usa per cercare niente (FASE 5 —
 *                       nessuno stato condiviso, nessuna cache per mercato)
 *   side                'BUY' | 'SELL' — decide cosa vuol dire «davanti»
 *   proposedSize        le share che vorremmo mettere a quel livello
 *   price               il prezzo del livello valutato
 *   restingBookAtLevel  i livelli PUBBLICATI di quel lato (nostri compresi: li togliamo noi)
 *   ownOrders           i NOSTRI ordini su quel lato, che vengono sottratti
 *   tick                il tick del venue, per agganciare i prezzi alla griglia
 * @returns {{allowed:boolean, reason?:string, depthAheadUsd:number|null,
 *            selfShareAtLevel:number|null, othersAtLevelUsd:number|null}}
 */
function checkDepthGuardRisk({
  marketId = null, side = 'BUY', proposedSize = null, price = null,
  restingBookAtLevel = null, ownOrders = [], tick = null,
} = {}) {
  const vuoto = { depthAheadUsd: null, selfShareAtLevel: null, othersAtLevelUsd: null, marketId };

  if (!fin(price) || price <= 0 || price >= 1) {
    return { allowed: false, reason: `prezzo non valutabile (${price}) — non si autorizza una size su un livello che non si sa dov'è`, ...vuoto };
  }
  if (!fin(proposedSize) || proposedSize <= 0) {
    return { allowed: false, reason: `size proposta non valutabile (${proposedSize})`, ...vuoto };
  }

  // LA SOTTRAZIONE DEI NOSTRI: delegata, mai riscritta. `othersLadder` distingue da sola «il feed non
  // ha pubblicato i livelli» da «il feed dice che non c'è nessuno», e le due cose portano a risposte
  // diverse — la prima è un'incognita, la seconda è un fatto.
  const altrui = othersLadder({ levels: restingBookAtLevel, ownOrders, tick });
  if (altrui.readable !== true) {
    return { allowed: false, reason: `profondità non leggibile: ${altrui.reason} — un dato mancante non è un via libera`, ...vuoto };
  }

  // ── 1 · I DOLLARI ALTRUI DAVANTI ────────────────────────────────────────────────────────────────
  let depthAheadUsd = 0;
  for (const l of altrui.levels) {
    if (!l || !fin(l.price) || !fin(l.size)) continue;
    if (davantiA(price, l.price, side)) depthAheadUsd += l.price * l.size;
  }
  depthAheadUsd = +depthAheadUsd.toFixed(4);

  // ── 2 · QUANTO DEL LIVELLO SAREMMO NOI ──────────────────────────────────────────────────────────
  // Solo il livello ESATTO, non tutto ciò che sta davanti: la domanda è «su questo gradino, chi c'è?».
  const eps = tick && fin(tick) ? tick / 2 : 1e-9;
  let altruiAlLivello = 0;
  for (const l of altrui.levels) {
    if (!l || !fin(l.price) || !fin(l.size)) continue;
    if (Math.abs(l.price - price) <= eps) altruiAlLivello += l.size;
  }
  const totaleAlLivello = altruiAlLivello + proposedSize;
  const selfShareAtLevel = totaleAlLivello > 0 ? +(proposedSize / totaleAlLivello).toFixed(6) : 1;
  const othersAtLevelUsd = +(altruiAlLivello * price).toFixed(4);

  const misure = { depthAheadUsd, selfShareAtLevel, othersAtLevelUsd, marketId };

  if (depthAheadUsd < DEPTH_MIN_AHEAD_USD) {
    return {
      allowed: false,
      reason: `davanti ci sono $${depthAheadUsd.toFixed(2)} di altri operatori, sotto il minimo di $${DEPTH_MIN_AHEAD_USD}`
        + ' — con così poco davanti questo ordine è il primo a essere preso da qualunque movimento',
      ...misure,
    };
  }
  if (selfShareAtLevel > MAX_SELF_SHARE_AT_LEVEL) {
    return {
      allowed: false,
      reason: `saremmo il ${(selfShareAtLevel * 100).toFixed(1)}% della size a riposo su questo livello, oltre il tetto del `
        + `${(MAX_SELF_SHARE_AT_LEVEL * 100).toFixed(0)}% — «il livello è profondo» sarebbe una frase su noi stessi`,
      ...misure,
    };
  }

  return { allowed: true, ...misure };
}

module.exports = {
  checkDepthGuardRisk,
  DEPTH_MIN_AHEAD_USD,
  MAX_SELF_SHARE_AT_LEVEL,
};
