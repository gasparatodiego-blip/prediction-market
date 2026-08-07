'use strict';
// lib/maker/origine-ordine.js — CHI HA VOLUTO QUESTO ORDINE: una mano o un ciclo.
//
// ═══ IL PROBLEMA, E PERCHÉ NON BASTAVA CIÒ CHE C'ERA ═══════════════════════════════════════════════
// `lib/maker/attribuzione-ordini.js` risponde già a una domanda: «l'ha piazzato la CORSIA manuale o
// agent35?». È la domanda giusta per decidere chi può toccare un ordine, e non va toccata.
//
// Ma dentro la corsia manuale ci sono due mittenti diversi, e finora erano indistinguibili:
//   · l'OPERATORE, che preme un bottone nel pannello;
//   · agent41, che ogni sei ore ricalcola il piano e piazza da solo — e passa dalla stessa funzione,
//     con la stessa etichetta (`bulk-allocate` timbra `source: 'manual-ui'`, e il commento accanto lo
//     dice: «it IS the operator acting, through one button instead of many»).
//
// Finché è l'operatore a premere il bottone quella frase è vera. Quando a premerlo è uno scheduler
// ogni sei ore, non lo è più: il reset di agent41 cancella tutto ciò che trova sui mercati in
// gestione, e ciò che trova comprende gli ordini che una persona ha messo a mano dieci minuti prima.
// Non c'era modo di distinguerli, perché il timbro era lo stesso.
//
// ═══ COSA AGGIUNGE, E COSA NON CAMBIA ══════════════════════════════════════════════════════════════
// Un campo NUOVO — `origine` — accanto a `source`, non al posto suo. `source` continua a dire quale
// corsia ha piazzato (ed è quello che agent40 e agent35 leggono per sapere di chi è un ordine);
// `origine` dice se dietro c'era una mano o un ciclo. Cambiare `source` avrebbe fatto sparire quegli
// ordini dalla corsia manuale, e il watcher di riprezzo avrebbe smesso di gestirli: una correzione che
// ne rompe un'altra.
//
// ═══ «NON LO SO» È UNA RISPOSTA, E QUI È LA PIÙ IMPORTANTE ═════════════════════════════════════════
// Un ordine di cui il registro non dice l'origine risponde `ignota`. Chi decide di CANCELLARE deve
// trattare `ignota` come «potrebbe essere di una mano» e lasciarlo stare: fra i due errori possibili —
// cancellare un ordine dell'operatore, o lasciare in piedi un ordine dello scheduler — solo il primo
// distrugge lavoro che qualcuno ha fatto apposta. Il secondo costa un ciclo.

const fs = require('fs');
const path = require('path');

const ORIGINE_MANUALE = 'manual-ui';
const ORIGINE_AUTO = 'auto';
const ORIGINE_IGNOTA = 'ignota';

/** Le sorgenti che sono per costruzione automatiche: nessuna mano preme niente, lì. */
const SORGENTI_AUTOMATICHE = Object.freeze(['auto-reprice-band-exit', 'mm-tracking', 'auto-close']);

/**
 * L'origine da dichiarare al piazzamento.
 * @param {string} source        la corsia (`manual-ui`, `auto-reprice-band-exit`, …)
 * @param {string|null} esplicita quello che il chiamante ha dichiarato, se l'ha dichiarato
 */
function origineDaSource(source, esplicita = null) {
  if (esplicita === ORIGINE_MANUALE || esplicita === ORIGINE_AUTO) return esplicita;
  if (SORGENTI_AUTOMATICHE.includes(source)) return ORIGINE_AUTO;
  // `manual-ui` senza dichiarazione resta manuale: è il pannello, ed è il caso di gran lunga più
  // frequente. Chi piazza da un ciclo DEVE dirlo — ed è agent41 l'unico che deve.
  return ORIGINE_MANUALE;
}

/**
 * La mappa orderId/idempotencyKey → origine, letta dal registro append-only del maker.
 *
 * Stessa fonte e stessa forma della lettura che fa `attribuzione-ordini.manualIdempotencyKeys`, ma
 * tenuta separata: quella risponde «di chi è la corsia», questa «chi l'ha voluto». Unirle vorrebbe
 * dire che un cambio a una risposta muove anche l'altra.
 *
 * Lettura intera e senza cache: la chiama il reset di agent41, una volta ogni sei ore, e una cache
 * incrementale qui varrebbe un rischio di disallineamento in cambio di niente.
 */
function mappaOrigini(deps = {}) {
  const m = new Map();
  let file = deps.auditFile;
  if (!file) {
    try { file = path.join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl'); }
    catch { return m; }
  }
  let testo;
  try { testo = fs.readFileSync(file, 'utf8'); }
  catch { return m; }               // registro assente ⇒ mappa vuota ⇒ tutti `ignota` ⇒ nessuno cancellato
  for (const riga of testo.split('\n')) {
    if (!riga || riga.indexOf('origine') === -1) continue;
    let r; try { r = JSON.parse(riga); } catch { continue; }
    const o = r && r.origine;
    if (o !== ORIGINE_MANUALE && o !== ORIGINE_AUTO) continue;
    if (r.orderId) m.set(String(r.orderId), o);
    if (r.idempotencyKey) m.set(String(r.idempotencyKey), o);
    if (r.response && r.response.orderId) m.set(String(r.response.orderId), o);
  }
  return m;
}

/** L'origine di UN ordine del venue. `ignota` quando il registro non ne parla. */
function origineDiUnOrdine(o, mappa) {
  if (!o || !mappa) return ORIGINE_IGNOTA;
  for (const k of [o.orderId, o.id, o.orderID, o.order_id, o.idempotencyKey]) {
    if (k != null && mappa.has(String(k))) return mappa.get(String(k));
  }
  return ORIGINE_IGNOTA;
}

/**
 * Divide una lista di ordini in «li può toccare un ciclo automatico» e «no».
 *
 * LA DIREZIONE È DELIBERATA: passa solo ciò che è PROVATAMENTE automatico. Manuale e ignoto restano
 * fuori. È la stessa regola che `attributeOrder` applica all'altra domanda — «non è mio» è la risposta
 * giusta quando non c'è prova che lo sia.
 */
function separaPerOrigine(ordini, mappa) {
  const automatici = [];
  const daLasciare = [];
  for (const o of Array.isArray(ordini) ? ordini : []) {
    const org = origineDiUnOrdine(o, mappa);
    if (org === ORIGINE_AUTO) automatici.push({ ...o, origine: org });
    else daLasciare.push({ ...o, origine: org });
  }
  return { automatici, daLasciare };
}

module.exports = {
  ORIGINE_MANUALE, ORIGINE_AUTO, ORIGINE_IGNOTA, SORGENTI_AUTOMATICHE,
  origineDaSource, mappaOrigini, origineDiUnOrdine, separaPerOrigine,
};
