'use strict';
// lib/maker/risk-caps.js — QUANTO CAPITALE PUÒ STARE NEL BUCKET RISK, IN TUTTO E PER MERCATO.
//
// ═══ LE DUE DOMANDE ══════════════════════════════════════════════════════════════════════════════════
//   1. Il bucket Risk nel suo insieme sta sotto il 15% del saldo?
//   2. Ogni singolo mercato Risk sta sotto il 10% del saldo?
// Due tetti indipendenti: uno solo dei due non basta. Il tetto per mercato senza quello totale
// lascerebbe passare dieci mercati al 10% ciascuno (cioè il 100%); quello totale senza il per-mercato
// lascerebbe mettere tutto il 15% su un mercato solo.
//
// ═══ «AL MOMENTO DEL CALCOLO», E PERCHÉ CONTA ═══════════════════════════════════════════════════════
// Le percentuali sono sul SALDO LETTO ADESSO, non su un saldo memorizzato quando il piano è nato. Un
// fill cambia il saldo, e un tetto calcolato su un saldo vecchio è un tetto che non protegge più: è
// esattamente il caso «se il saldo cambia nel frattempo e il tetto risulta superato». Per questo la
// funzione non conserva niente e vuole il saldo come parametro a ogni chiamata.
//
// ═══ SALDO NON LEGGIBILE ⇒ NESSUNA NUOVA ESPOSIZIONE ════════════════════════════════════════════════
// Non «tetto infinito» e nemmeno «tetto zero, cancella tutto». Sono due errori opposti e questo modulo
// non commette né l'uno né l'altro: risponde `consentito: false` sulle richieste di AGGIUNGERE, e
// `eccedenza: null` sulla domanda «quanto è di troppo?» — perché senza saldo quella domanda non ha una
// risposta misurata, e inventarla vorrebbe dire cancellare ordini veri sulla base di un numero assente.
// La distinzione è la stessa che operator-board applica al capitale non giudicabile.
//
// ═══ PURO ═══════════════════════════════════════════════════════════════════════════════════════════
// Nessun `fs`, nessuna rete, nessun orologio, nessuno stato fra due chiamate. Il saldo e l'esposizione
// li porta chi chiama, dalla lettura che ha appena fatto.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il bucket Risk, tutto insieme, non può superare questa frazione del saldo totale. */
const RISK_BUCKET_CAP_PCT = 0.15;
/** Un singolo mercato Risk non può superare questa frazione del saldo totale. */
const RISK_PER_MARKET_CAP_PCT = 0.10;

/** I due tetti in dollari, da un saldo. null quando il saldo non è leggibile — mai zero, mai infinito. */
function tettiDa(saldoUsd) {
  if (!fin(saldoUsd) || saldoUsd < 0) {
    return { leggibile: false, saldoUsd: null, bucketCapUsd: null, perMarketCapUsd: null };
  }
  return {
    leggibile: true,
    saldoUsd,
    bucketCapUsd: +(saldoUsd * RISK_BUCKET_CAP_PCT).toFixed(2),
    perMarketCapUsd: +(saldoUsd * RISK_PER_MARKET_CAP_PCT).toFixed(2),
  };
}

/**
 * SI PUÒ AGGIUNGERE QUESTA ESPOSIZIONE? — la domanda della fase di proposta e del piazzamento.
 *
 * @param {object} a
 *   saldoUsd            saldo totale letto ADESSO
 *   marketId            il mercato su cui si vuole aggiungere
 *   aggiuntaUsd         quanto si vuole aggiungere
 *   esposizioneRisk     Map|oggetto marketId → USD già impegnati in Risk (il mercato compreso)
 * @returns {{consentito:boolean, motivo:string|null, ...misure}}
 */
function puoAggiungereRisk({ saldoUsd = null, marketId = null, aggiuntaUsd = 0, esposizioneRisk = null } = {}) {
  const t = tettiDa(saldoUsd);
  const perMercato = normalizza(esposizioneRisk);
  const id = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';

  const totaleAttuale = somma(perMercato);
  const suQuestoMercato = id ? (perMercato.get(id) || 0) : 0;
  const misure = {
    bucketCapUsd: t.bucketCapUsd, perMarketCapUsd: t.perMarketCapUsd, saldoUsd: t.saldoUsd,
    totaleRiskUsd: +totaleAttuale.toFixed(2), mercatoRiskUsd: +suQuestoMercato.toFixed(2),
  };

  if (!t.leggibile) {
    return { consentito: false, motivo: 'saldo non leggibile: nessuna nuova esposizione Risk (un tetto che non si può calcolare non è un tetto ampio)', ...misure };
  }
  if (!fin(aggiuntaUsd) || aggiuntaUsd < 0) {
    return { consentito: false, motivo: `aggiunta non valutabile (${aggiuntaUsd})`, ...misure };
  }
  if (!id) {
    return { consentito: false, motivo: 'marketId assente: il tetto per mercato non si può applicare a un mercato senza nome', ...misure };
  }

  const dopoMercato = suQuestoMercato + aggiuntaUsd;
  const dopoTotale = totaleAttuale + aggiuntaUsd;

  // Il per-mercato per primo: è il più stretto, e il motivo che restituisce è più specifico.
  if (dopoMercato > t.perMarketCapUsd + 1e-9) {
    return {
      consentito: false,
      motivo: `il mercato arriverebbe a $${dopoMercato.toFixed(2)}, oltre il tetto per mercato di $${t.perMarketCapUsd.toFixed(2)}`
        + ` (${(RISK_PER_MARKET_CAP_PCT * 100).toFixed(0)}% del saldo $${t.saldoUsd.toFixed(2)})`,
      ...misure,
    };
  }
  if (dopoTotale > t.bucketCapUsd + 1e-9) {
    return {
      consentito: false,
      motivo: `il bucket Risk arriverebbe a $${dopoTotale.toFixed(2)}, oltre il tetto totale di $${t.bucketCapUsd.toFixed(2)}`
        + ` (${(RISK_BUCKET_CAP_PCT * 100).toFixed(0)}% del saldo $${t.saldoUsd.toFixed(2)})`,
      ...misure,
    };
  }
  return { consentito: true, motivo: null, ...misure };
}

/**
 * QUANTO È DI TROPPO ADESSO? — la domanda del controllo continuo, che gira anche quando nessuno sta
 * aggiungendo niente. Serve al caso «il saldo è sceso per un fill e il tetto ora è superato».
 *
 * Restituisce l'eccedenza TOTALE e quella PER MERCATO, così chi agisce sa dove intervenire invece di
 * sapere solo che «qualcosa è di troppo».
 *
 * @returns {{leggibile:boolean, eccedenzaTotaleUsd:number|null,
 *            eccedenzePerMercato:Array<{marketId,usd,capUsd,eccedenzaUsd}>, ...}}
 */
function eccedenzaRisk({ saldoUsd = null, esposizioneRisk = null } = {}) {
  const t = tettiDa(saldoUsd);
  const perMercato = normalizza(esposizioneRisk);
  const totale = somma(perMercato);

  if (!t.leggibile) {
    // NON si inventa un'eccedenza: senza saldo la domanda non ha risposta misurata, e rispondere
    // «tutto è di troppo» farebbe cancellare ordini veri contro un numero che non c'è.
    return {
      leggibile: false, motivo: 'saldo non leggibile: l\'eccedenza non è calcolabile e non viene indovinata',
      eccedenzaTotaleUsd: null, eccedenzePerMercato: [], totaleRiskUsd: +totale.toFixed(2),
      bucketCapUsd: null, perMarketCapUsd: null, saldoUsd: null,
    };
  }

  const eccedenzePerMercato = [];
  for (const [id, usd] of perMercato.entries()) {
    if (usd > t.perMarketCapUsd + 1e-9) {
      eccedenzePerMercato.push({
        marketId: id, usd: +usd.toFixed(2), capUsd: t.perMarketCapUsd,
        eccedenzaUsd: +(usd - t.perMarketCapUsd).toFixed(2),
      });
    }
  }
  eccedenzePerMercato.sort((a, b) => b.eccedenzaUsd - a.eccedenzaUsd);

  const eccedenzaTotaleUsd = totale > t.bucketCapUsd ? +(totale - t.bucketCapUsd).toFixed(2) : 0;

  return {
    leggibile: true, motivo: null,
    eccedenzaTotaleUsd, eccedenzePerMercato,
    totaleRiskUsd: +totale.toFixed(2),
    bucketCapUsd: t.bucketCapUsd, perMarketCapUsd: t.perMarketCapUsd, saldoUsd: t.saldoUsd,
    /** Vero se c'è qualcosa da fare: o il totale sfora, o almeno un mercato sfora. */
    sforato: eccedenzaTotaleUsd > 0 || eccedenzePerMercato.length > 0,
  };
}

/** Accetta Map o oggetto semplice; chiavi normalizzate, valori non numerici ignorati. */
function normalizza(esposizioneRisk) {
  const m = new Map();
  if (!esposizioneRisk) return m;
  const voci = esposizioneRisk instanceof Map
    ? esposizioneRisk.entries()
    : Object.entries(esposizioneRisk);
  for (const [k, v] of voci) {
    const id = typeof k === 'string' ? k.trim().toLowerCase() : '';
    const usd = fin(v) ? v : (v && fin(v.usd) ? v.usd : null);
    if (!id || !fin(usd) || usd < 0) continue;
    m.set(id, (m.get(id) || 0) + usd);
  }
  return m;
}

function somma(m) {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}

module.exports = {
  puoAggiungereRisk, eccedenzaRisk, tettiDa,
  RISK_BUCKET_CAP_PCT, RISK_PER_MARKET_CAP_PCT,
};
