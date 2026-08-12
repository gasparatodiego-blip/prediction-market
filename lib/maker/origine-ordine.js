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
const { scansiona } = require('./giornale-incrementale');
const path = require('path');

const ORIGINE_MANUALE = 'manual-ui';
const ORIGINE_AUTO = 'auto';
const ORIGINE_IGNOTA = 'ignota';
// ── LA TERZA ORIGINE: AUTOMATICA, MA CHE STA CHIUDENDO UNA POSIZIONE ─────────────────────────────
// Non tutto ciò che è automatico è uguale davanti al reset. Un ordine di PIANO è capitale che il ciclo
// ha messo al lavoro e che il ciclo può disfare; un'uscita di `auto-close` è la via d'uscita di una
// posizione aperta, e cancellarla lascia quella posizione scoperta fino al giro successivo di agent40.
// Fino al 12 agosto 2026 la differenza non esisteva, e le uscite sopravvivevano al reset per un
// ACCIDENTE: `SORGENTI_AUTOMATICHE` conteneva la stringa `'auto-close'` mentre il valore realmente
// scritto è `'auto-close-on-fill'` (misurato: 4.686 righe nel giornale vivo, tutte etichettate
// `manual-ui`). Correggere la stringa e basta avrebbe fatto cominciare il reset a spazzare le uscite —
// cioè avrebbe trasformato un refuso protettivo in un danno, senza che nessuno l'avesse deciso.
const ORIGINE_AUTO_CHIUSURA = 'auto-chiusura';

// Le sorgenti automatiche di PIANO: capitale messo al lavoro da un ciclo, che un ciclo può disfare.
// Le costanti sono IMPORTATE, non ricopiate: era proprio una stringa ricopiata a produrre il difetto.
const { AUTO_REPRICE_SOURCE } = require('./auto-reprice-config');
const SORGENTI_AUTOMATICHE = Object.freeze([AUTO_REPRICE_SOURCE, 'mm-tracking']);

// Le sorgenti che CHIUDONO. `auto-close-config` è un modulo di sola configurazione (155 righe, nessun
// require verso qui): importarlo non crea cicli. `mm-tracking` resta una stringa perché il suo modulo è
// il motore da 882 righe e caricarlo per una parola sarebbe sproporzionato — un test verifica che la
// stringa e la costante coincidano, che è la stessa garanzia senza il costo.
const { AUTO_CLOSE_SOURCE } = require('./auto-close-config');
const SORGENTI_DI_CHIUSURA = Object.freeze([AUTO_CLOSE_SOURCE]);

/**
 * L'origine da dichiarare al piazzamento.
 * @param {string} source        la corsia (`manual-ui`, `auto-reprice-band-exit`, …)
 * @param {string|null} esplicita quello che il chiamante ha dichiarato, se l'ha dichiarato
 */
function origineDaSource(source, esplicita = null) {
  if (esplicita === ORIGINE_MANUALE || esplicita === ORIGINE_AUTO || esplicita === ORIGINE_AUTO_CHIUSURA) return esplicita;
  // La chiusura si valuta PRIMA: è la classificazione più stretta delle due, e un ordine che chiude non
  // deve poter cadere nel ramo generico per l'ordine in cui sono scritti gli `if`.
  if (SORGENTI_DI_CHIUSURA.includes(source)) return ORIGINE_AUTO_CHIUSURA;
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
  // ── LETTURA INCREMENTALE, E NON È UN'OTTIMIZZAZIONE ──────────────────────────────────────────
  // Qui c'era `fs.readFileSync(file, 'utf8')`, cioè l'intero giornale in UNA stringa. Il 9 agosto 2026
  // il file ha raggiunto 731 MB e V8 si rifiuta di costruire una stringa oltre ~512 MB: la lettura
  // sollevava, il `catch` restituiva una mappa VUOTA, e una mappa vuota qui vuol dire «ogni ordine è di
  // origine ignota» — quindi il reset di agent41 non cancellava più niente, per un motivo che non
  // compariva in nessun log. Fallire chiuso era giusto; restare in silenzio no.
  //
  // Adesso si legge a blocchi tenendo l'offset già consumato (`giornale-incrementale`, lo stesso
  // meccanismo già in servizio in `attribuzione-ordini`). La mappa è ACCUMULATIVA e sopravvive fra le
  // chiamate: su un giornale append-only è esattamente corretto — una riga scritta non cambia più — e
  // una rotazione o un troncamento la fanno ricostruire da zero.
  return scansiona({
    file, chiave: 'origine-ordine',
    crea: () => m,
    ingest: (riga, acc) => {
      if (!riga || riga.indexOf('origine') === -1) return;
      let r; try { r = JSON.parse(riga); } catch { return; }
      const o = r && r.origine;
      if (o !== ORIGINE_MANUALE && o !== ORIGINE_AUTO && o !== ORIGINE_AUTO_CHIUSURA) return;
      if (r.orderId) acc.set(String(r.orderId), o);
      if (r.idempotencyKey) acc.set(String(r.idempotencyKey), o);
      if (r.response && r.response.orderId) acc.set(String(r.response.orderId), o);
    },
  });
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
  const protetti = [];
  for (const o of Array.isArray(ordini) ? ordini : []) {
    const org = origineDiUnOrdine(o, mappa);
    // ── LA REGOLA, ESPLICITA ────────────────────────────────────────────────────────────────────
    // Il reset spazza gli ordini automatici DI PIANO. NON tocca gli ordini che stanno CHIUDENDO una
    // posizione: cancellare un'uscita protettiva la lascerebbe scoperta fino al giro dopo di agent40,
    // e il reset non ha modo di sapere se quella posizione puo' permetterselo. E' una DECISIONE, non
    // piu' l'effetto di una stringa che non corrispondeva al valore scritto.
    if (org === ORIGINE_AUTO) { automatici.push({ ...o, origine: org }); continue; }
    const riga = { ...o, origine: org };
    if (org === ORIGINE_AUTO_CHIUSURA) protetti.push(riga);
    daLasciare.push(riga);
  }
  return { automatici, daLasciare, protetti };
}

module.exports = {
  ORIGINE_MANUALE, ORIGINE_AUTO, ORIGINE_IGNOTA, ORIGINE_AUTO_CHIUSURA,
  SORGENTI_AUTOMATICHE, SORGENTI_DI_CHIUSURA,
  origineDaSource, mappaOrigini, origineDiUnOrdine, separaPerOrigine,
};
