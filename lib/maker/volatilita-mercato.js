'use strict';
// lib/maker/volatilita-mercato.js — QUANTO SI È MOSSO, E QUANTO È LARGO LO SPREAD, PER QUESTO MERCATO.
//
// ═══ TRE DOMANDE, TUTTE RELATIVE AL SINGOLO MERCATO ══════════════════════════════════════════════════
//   1. Safe · il mid ha percorso un RANGE ≥ 2× la banda nelle ultime 8 ore? → margine dal bordo RADDOPPIA
//   2. Safe · lo spread corrente è ≥ 3× la sua media mobile? → si blocca finché non rientra
//   3. Risk · il mid ha percorso un RANGE ≥ 0,5× la banda negli ultimi 5 minuti? → mercato NERVOSO
//
// Nessuna delle tre è un valore assoluto uguale per tutti: sono tutte espresse come multiplo di
// qualcosa DI QUEL MERCATO (la sua banda, il suo spread medio). Un mercato a tick 0,001 e uno a tick
// 0,01 hanno bande e spread di ordini di grandezza diversi, e una soglia in centesimi fissi
// bloccherebbe sempre il primo e mai il secondo.
//
// ═══ LA FONTE È UNA SOLA, ED È QUELLA CHE C'È GIÀ ════════════════════════════════════════════════════
// `leggiFinestraMercato` di lib/rewards/velocita-mercato.js legge il giornale mid-history di agent34
// (data/mid-history-*.jsonl) con le stesse funzioni che il pannello usa da settimane. Quel giornale
// porta `adjMid`, `bestBid` e `bestAsk` per campione, quindi range e spread vengono dalla STESSA
// lettura: non c'è una raccolta nuova e non ci sono due fonti che possano divergere.
//
// ═══ STORICO INSUFFICIENTE NON BLOCCA — ED È DELIBERATO ══════════════════════════════════════════════
// Un mercato appena aperto non ha 8 ore di storico. Trattarlo come volatile lo escluderebbe per il solo
// fatto di essere nuovo, che non è una misura di rischio: è l'assenza di una misura. Quindi:
//
//     storico insufficiente ⇒ «non nervoso», nessun margine aggiuntivo, e lo si DICHIARA.
//
// È l'opposto della regola che governa il book (dove un dato mancante blocca), e la differenza ha una
// ragione: lì il dato assente riguarda DOVE va l'ordine adesso, qui riguarda una caratterizzazione
// storica. Nel primo caso agire al buio muove capitale; nel secondo, non agire lo blocca per sempre.
//
// ═══ ONESTÀ SULLA RISOLUZIONE ════════════════════════════════════════════════════════════════════════
// Il giornale campiona ogni ~75 s. La finestra Risk da 5 minuti contiene quindi ~4 campioni: il range
// misurato può solo SOTTOSTIMARE il movimento vero (fra due campioni il mid può essere andato e
// tornato). Ogni verdetto porta `campioni` con sé perché chi legge sappia su quanti punti è stato dato.

const { leggiFinestraMercato } = require('../rewards/velocita-mercato');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── LE SOGLIE ARRIVANO DAL MODULO PURO ────────────────────────────────────────────────────────────
// Non sono scritte qui perché l'interfaccia deve poterle DICHIARARE, e questo file importa `fs` (legge
// il giornale di agent34): un componente client non può importarlo. I numeri stanno in
// lib/maker/soglie-profili.js, che non ha nessun require, e da lì li leggono sia il motore sia la
// frase che li descrive a schermo — lo stesso simbolo, quindi non possono divergere.
const {
  SAFE_VOLATILITY_WINDOW_MIN, SAFE_VOLATILITY_THRESHOLD_MULT,
  SAFE_SPREAD_ANOMALY_MULT, SAFE_SPREAD_WINDOW_MIN,
  RISK_VOLATILITY_WINDOW_MIN, RISK_VOLATILITY_THRESHOLD_MULT,
} = require('./soglie-profili');


/** L'ampiezza della banda in unità di prezzo, dal raggio in centesimi. Ampiezza = 2 × raggio. */
function ampiezzaBanda(bandRadiusCents) {
  return fin(bandRadiusCents) && bandRadiusCents > 0 ? (2 * bandRadiusCents) / 100 : null;
}

/**
 * VOLATILITÀ SAFE — il margine dal bordo va raddoppiato?
 *
 * @returns {{nervoso:boolean, margineMultiplo:1|2, rangeMid:number|null, soglia:number|null,
 *            campioni:number, misurato:boolean, motivo:string}}
 */
function volatilitaSafe({ marketId, bandRadiusCents, now = Date.now(), deps = {} } = {}) {
  const ampiezza = ampiezzaBanda(bandRadiusCents);
  if (ampiezza == null) {
    return { nervoso: false, margineMultiplo: 1, rangeMid: null, soglia: null, campioni: 0, misurato: false,
      motivo: 'ampiezza della banda non calcolabile: nessun margine aggiuntivo imposto su una soglia che non si può derivare' };
  }
  const soglia = ampiezza * SAFE_VOLATILITY_THRESHOLD_MULT;
  const w = (deps.leggiFinestra || leggiFinestraMercato)({
    marketId, windowMinutes: SAFE_VOLATILITY_WINDOW_MIN, now, ...deps,
  });

  if (!w || w.leggibile !== true || w.sufficiente !== true || !fin(w.rangeMid)) {
    // NON BLOCCA. Vedi l'intestazione: l'assenza di storico non è una misura di volatilità.
    return { nervoso: false, margineMultiplo: 1, rangeMid: null, soglia: +soglia.toFixed(6),
      campioni: w && fin(w.campioni) ? w.campioni : 0, misurato: false,
      motivo: `storico insufficiente su ${SAFE_VOLATILITY_WINDOW_MIN} min (${w && w.motivo ? w.motivo : `${w && w.campioni ? w.campioni : 0} campioni`})`
        + ' — trattato come NON nervoso: un mercato nuovo non è un mercato volatile' };
  }

  const nervoso = w.rangeMid + 1e-12 >= soglia;
  return {
    nervoso, margineMultiplo: nervoso ? 2 : 1,
    rangeMid: w.rangeMid, soglia: +soglia.toFixed(6), campioni: w.campioni, misurato: true,
    motivo: nervoso
      ? `range ${(w.rangeMid * 100).toFixed(2)}¢ ≥ ${SAFE_VOLATILITY_THRESHOLD_MULT}× ampiezza banda (${(soglia * 100).toFixed(2)}¢) su ${w.campioni} campioni — margine dal bordo RADDOPPIATO`
      : `range ${(w.rangeMid * 100).toFixed(2)}¢ < ${(soglia * 100).toFixed(2)}¢ su ${w.campioni} campioni — margine invariato`,
  };
}

/**
 * SPREAD ANOMALO SAFE — lo spread corrente è ≥ 3× la sua media mobile?
 *
 * `spreadCorrente` va passato da chi ha il book VIVO davanti: la media mobile viene dallo storico, il
 * valore corrente no. Mescolarli — media dallo storico e «corrente» preso dallo storico — vorrebbe dire
 * confrontare un numero con la media che lo contiene, e su una finestra da 2 ore l'ultimo campione la
 * muove così poco che l'anomalia non scatterebbe quasi mai.
 *
 * @returns {{bloccato:boolean, spreadCorrente:number|null, mediaMobile:number|null,
 *            rapporto:number|null, campioni:number, misurato:boolean, motivo:string}}
 */
function spreadAnomaloSafe({ marketId, spreadCorrente = null, now = Date.now(), deps = {} } = {}) {
  const w = (deps.leggiFinestra || leggiFinestraMercato)({
    marketId, windowMinutes: SAFE_SPREAD_WINDOW_MIN, now, ...deps,
  });
  const media = w && fin(w.spreadMedio) && w.spreadMedio > 0 ? w.spreadMedio : null;

  if (media == null || (w && w.spreadCampioni < 2)) {
    return { bloccato: false, spreadCorrente, mediaMobile: null, rapporto: null,
      campioni: w && fin(w.spreadCampioni) ? w.spreadCampioni : 0, misurato: false,
      motivo: `media mobile dello spread non misurabile su ${SAFE_SPREAD_WINDOW_MIN} min`
        + ' — non si blocca per assenza di storico, come per la volatilità' };
  }
  if (!fin(spreadCorrente) || spreadCorrente < 0) {
    // Qui invece SI BLOCCA: lo spread corrente riguarda il book di ADESSO, e agire senza saperlo
    // significa piazzare al buio. È la stessa distinzione dell'intestazione.
    return { bloccato: true, spreadCorrente: null, mediaMobile: media, rapporto: null,
      campioni: w.spreadCampioni, misurato: false,
      motivo: 'spread corrente non leggibile dal book vivo — non si piazza contro un tocco che non si è potuto misurare' };
  }

  const rapporto = spreadCorrente / media;
  const bloccato = rapporto + 1e-12 >= SAFE_SPREAD_ANOMALY_MULT;
  return {
    bloccato, spreadCorrente, mediaMobile: media, rapporto: +rapporto.toFixed(4),
    campioni: w.spreadCampioni, misurato: true,
    motivo: bloccato
      ? `spread ${(spreadCorrente * 100).toFixed(2)}¢ = ${rapporto.toFixed(1)}× la media mobile di ${(media * 100).toFixed(2)}¢`
        + ` (soglia ${SAFE_SPREAD_ANOMALY_MULT}×) — bloccato finché non rientra`
      : `spread ${(spreadCorrente * 100).toFixed(2)}¢ = ${rapporto.toFixed(1)}× la media di ${(media * 100).toFixed(2)}¢, sotto la soglia ${SAFE_SPREAD_ANOMALY_MULT}×`,
  };
}

/**
 * NERVOSISMO RISK — il mid ha percorso ≥ 0,5× l'ampiezza della banda negli ultimi 5 minuti?
 *
 * @returns {{nervoso:boolean, rangeMid:number|null, soglia:number|null, campioni:number,
 *            misurato:boolean, motivo:string}}
 */
function nervosismoRisk({ marketId, bandRadiusCents, now = Date.now(), deps = {} } = {}) {
  const ampiezza = ampiezzaBanda(bandRadiusCents);
  if (ampiezza == null) {
    return { nervoso: false, rangeMid: null, soglia: null, campioni: 0, misurato: false,
      motivo: 'ampiezza della banda non calcolabile: nessuna soglia derivabile, trattato come non nervoso' };
  }
  const soglia = ampiezza * RISK_VOLATILITY_THRESHOLD_MULT;
  const w = (deps.leggiFinestra || leggiFinestraMercato)({
    marketId, windowMinutes: RISK_VOLATILITY_WINDOW_MIN, now, ...deps,
  });

  if (!w || w.leggibile !== true || w.sufficiente !== true || !fin(w.rangeMid)) {
    return { nervoso: false, rangeMid: null, soglia: +soglia.toFixed(6),
      campioni: w && fin(w.campioni) ? w.campioni : 0, misurato: false,
      motivo: `storico insufficiente su ${RISK_VOLATILITY_WINDOW_MIN} min`
        + ` (${w && fin(w.campioni) ? w.campioni : 0} campioni; il giornale campiona ogni ~75s, quindi qui ne stanno ~4)`
        + ' — trattato come NON nervoso' };
  }

  const nervoso = w.rangeMid + 1e-12 >= soglia;
  return {
    nervoso, rangeMid: w.rangeMid, soglia: +soglia.toFixed(6), campioni: w.campioni, misurato: true,
    motivo: nervoso
      ? `range ${(w.rangeMid * 100).toFixed(2)}¢ ≥ ${RISK_VOLATILITY_THRESHOLD_MULT}× ampiezza banda (${(soglia * 100).toFixed(2)}¢) su ${w.campioni} campioni — mercato NERVOSO`
      : `range ${(w.rangeMid * 100).toFixed(2)}¢ < ${(soglia * 100).toFixed(2)}¢ su ${w.campioni} campioni — non nervoso`,
  };
}

module.exports = {
  volatilitaSafe, spreadAnomaloSafe, nervosismoRisk, ampiezzaBanda,
  SAFE_VOLATILITY_WINDOW_MIN, SAFE_VOLATILITY_THRESHOLD_MULT,
  SAFE_SPREAD_ANOMALY_MULT, SAFE_SPREAD_WINDOW_MIN,
  RISK_VOLATILITY_WINDOW_MIN, RISK_VOLATILITY_THRESHOLD_MULT,
};
