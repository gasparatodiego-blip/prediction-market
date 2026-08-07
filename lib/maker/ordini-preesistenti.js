'use strict';
// lib/maker/ordini-preesistenti.js — GLI ORDINI CHE C'ERANO GIA': INVISIBILI AL MOTORE.
//
// ═══ LA REGOLA ════════════════════════════════════════════════════════════════════════════════════
// Quando il motore si avvia o si riarma, fotografa gli ordini GIA' a riposo sul venue in quel momento
// e li marca PRE-ESISTENTI. Da li' in poi, per il bot non esistono: non li riprezza, non li rinnova,
// non li cancella, non li conta nel capitale impegnato, non li vede nella gamba orfana ne' nel lato
// singolo, e non generano eventi. Moriranno da soli con la loro scadenza, oppure li toglie una mano.
//
// LA FONTE DI VERITA' E' IL VENUE, non una nostra credenza: la fotografia si scatta sull'elenco che il
// venue restituisce in quell'istante. Un elenco NON letto (`ok:false`, `simulated:true`) non produce
// nessuna fotografia — «non ho potuto guardare» non e' «non c'era niente», e una fotografia vuota
// scattata al buio renderebbe gestibile tutto cio' che invece andava lasciato stare.
//
// ═══ IL COSTO ACCETTATO, DICHIARATO QUI PERCHE' NON SI SCOPRA ALTROVE ═════════════════════════════
// Se il bot non deve GUARDARE questi ordini, non puo' nemmeno SOTTRARLI. Quindi nella profondita'
// «altrui» (lib/maker/top-of-book.othersLadder, lib/maker/profondita-altrui.js) i pre-esistenti
// compaiono come se fossero di terzi: «mai primo sul libro» stara' dietro a un nostro stesso ordine, e
// il denominatore del pavimento li conta come concorrenza. E' la conseguenza diretta e voluta
// dell'invisibilita', non una svista — e ha una direzione precisa: rende il motore piu' timido, mai
// piu' aggressivo.
//
// ═══ LE DUE ECCEZIONI ═════════════════════════════════════════════════════════════════════════════
// 1 · IL KILL RESTA ASSOLUTO. `lib/maker/cancel-all.js` non passa di qui: elenca dal venue e cancella
//     TUTTO, pre-esistenti compresi. L'invisibilita' e' del motore che gestisce, non dello STOP.
// 2 · UN PRE-ESISTENTE ESEGUITO diventa una POSIZIONE, e le posizioni si gestiscono normalmente
//     (auto-close legge `readPositions`, non gli ordini). A quel punto non e' piu' un ordine da
//     ignorare ma esposizione reale, e lasciarla scoperta sarebbe l'opposto della prudenza.
//
// ═══ COSA QUESTO MODULO NON DECIDE ════════════════════════════════════════════════════════════════
// Non decide QUANDO fotografare: lo decide chi lo chiama (agent40, all'avvio e quando il kill si
// spegne). Qui c'e' solo il deposito e IL FILTRO UNICO — `separaPreesistenti` — che ogni punto del
// ciclo deve attraversare. Un `if` sparso in dieci posti sarebbe dieci occasioni di dimenticarne uno.

const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../safety/store');
const { atomicWriteJson } = require('../atomicJsonWrite');

const FILE = path.join(DATA_DIR, 'maker-ordini-preesistenti.json');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

function vuoto() {
  return { v: 1, snapshotAt: null, snapshotIso: null, motivo: null, ordini: {} };
}

function leggi(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const o = raw && raw.ordini && typeof raw.ordini === 'object' ? raw.ordini : {};
    return {
      v: 1,
      snapshotAt: fin(raw && raw.snapshotAt) ? raw.snapshotAt : null,
      snapshotIso: (raw && raw.snapshotIso) || null,
      motivo: (raw && raw.motivo) || null,
      ordini: o,
    };
  } catch {
    // Mai scritto o illeggibile ⇒ NESSUN pre-esistente noto. E' il ripiego giusto in questa direzione:
    // «non lo so» qui significa «gestisci normalmente», cioe' il comportamento di sempre. Il contrario
    // — considerare pre-esistente tutto — spegnerebbe il motore per un file corrotto.
    return vuoto();
  }
}

function scrivi(file, stato) {
  try { atomicWriteJson(file, stato, { pretty: true }); return { scritto: true, motivo: null }; }
  catch (e) { return { scritto: false, motivo: e.message }; }
}

/** L'id di un ordine, comunque lo chiami la sorgente. */
function idDi(o) {
  const id = o && (o.orderId || o.id || o.orderID || o.order_id);
  return id ? String(id) : null;
}

/**
 * LA FOTOGRAFIA. Ogni ordine a riposo IN QUESTO ISTANTE diventa pre-esistente.
 *
 * @param {object} a
 *   listed   la risposta di `listManualOrders({marketId:null})` — serve `ok`/`simulated`, non solo la lista
 *   now      l'istante della fotografia
 *   motivo   perche' la si scatta ('avvio di agent40', 'kill spento: riarmo', ...)
 * @returns {{scattata:boolean, marcati:number, ordini:Array, motivo:string}}
 */
function fotografaPreesistenti({ listed = null, now = Date.now(), motivo = 'avvio', file = FILE } = {}) {
  if (!listed || listed.ok === false) {
    return { scattata: false, marcati: 0, ordini: [], motivo: `elenco del venue non letto (${(listed && listed.error) || 'nessuna risposta'}): nessuna fotografia — «non ho guardato» non e' «non c'era niente»` };
  }
  if (listed.simulated === true) {
    return { scattata: false, marcati: 0, ordini: [], motivo: 'nessuna credenziale: il venue non e\' stato interrogato, quindi non c\'e\' niente da fotografare' };
  }
  const precedente = leggi(file);
  const ordini = {};
  const elenco = [];
  for (const o of listed.orders || []) {
    const id = idDi(o);
    if (!id) continue;
    const prima = precedente.ordini[id];
    const size = fin(num(o.sizeRemaining)) && num(o.sizeRemaining) > 0 ? num(o.sizeRemaining) : num(o.size);
    const r = {
      marketId: o.marketId ? String(o.marketId) : null,
      tokenId: o.tokenId != null ? String(o.tokenId) : null,
      side: o.side ? String(o.side).toUpperCase() : null,
      price: fin(num(o.price)) ? num(o.price) : null,
      size: fin(size) ? size : null,
      source: o.source || null,
      orderType: o.orderType || null,
      // Un ordine gia' noto conserva la data della PRIMA fotografia: e' l'eta' della sua invisibilita'.
      marcatoIl: prima && fin(prima.marcatoIl) ? prima.marcatoIl : now,
      ultimaVistaMs: now,
    };
    ordini[id] = r;
    elenco.push({ orderId: id, ...r });
  }
  const stato = {
    v: 1, snapshotAt: now, snapshotIso: new Date(now).toISOString(), motivo, ordini,
  };
  const w = scrivi(file, stato);
  return {
    scattata: true, marcati: elenco.length, ordini: elenco,
    motivo: w.scritto ? motivo : `${motivo} — ATTENZIONE: deposito non scritto (${w.motivo}), l'invisibilita' non sopravvive a un riavvio`,
  };
}

/** Gli id pre-esistenti noti, come Set. Vuoto se non c'e' fotografia. */
function idsPreesistenti({ file = FILE } = {}) {
  return new Set(Object.keys(leggi(file).ordini));
}

/** Questo ordine e' pre-esistente? */
function ePreesistente(orderId, { file = FILE } = {}) {
  if (!orderId) return false;
  return Object.prototype.hasOwnProperty.call(leggi(file).ordini, String(orderId));
}

/**
 * IL FILTRO UNICO. Ogni punto del ciclo che tocca, conta o valuta ordini passa di qui.
 * @returns {{gestiti:Array, preesistenti:Array}}
 */
function separaPreesistenti(orders, { file = FILE, ids = null } = {}) {
  const noti = ids instanceof Set ? ids : idsPreesistenti({ file });
  const gestiti = [];
  const preesistenti = [];
  for (const o of orders || []) {
    const id = idDi(o);
    (id && noti.has(id) ? preesistenti : gestiti).push(o);
  }
  return { gestiti, preesistenti };
}

/**
 * LA LISTA SI SVUOTA DA SOLA. Un pre-esistente che il venue non elenca piu' — scaduto, eseguito,
 * cancellato a mano — esce dal deposito alla riconciliazione. Se non uscisse, il suo id resterebbe
 * per sempre e un giorno il venue potrebbe riusarlo su un ordine che invece va gestito.
 *
 * @param {object} a
 *   listed  la risposta del venue con TUTTI gli ordini a riposo (marketId: null). Un elenco non letto
 *           non pota niente: cancellare la memoria su una lettura fallita renderebbe di colpo
 *           gestibili ordini che vanno lasciati stare.
 * @returns {{potata:boolean, rimossi:Array<string>, restano:number, motivo:string|null}}
 */
function potaPreesistenti({ listed = null, now = Date.now(), file = FILE } = {}) {
  if (!listed || listed.ok === false || listed.simulated === true) {
    return { potata: false, rimossi: [], restano: Object.keys(leggi(file).ordini).length,
      motivo: 'elenco del venue non letto: non si pota niente su una lettura mancata' };
  }
  const stato = leggi(file);
  const vivi = new Set();
  for (const o of listed.orders || []) { const id = idDi(o); if (id) vivi.add(id); }
  const rimossi = [];
  for (const id of Object.keys(stato.ordini)) {
    if (vivi.has(id)) { stato.ordini[id].ultimaVistaMs = now; continue; }
    rimossi.push(id);
    delete stato.ordini[id];
  }
  if (rimossi.length) scrivi(file, stato);
  return { potata: true, rimossi, restano: Object.keys(stato.ordini).length, motivo: null };
}

/** Per la dashboard: cosa c'e' nel deposito, con la data della fotografia. */
function elencoPreesistenti({ file = FILE } = {}) {
  const s = leggi(file);
  return {
    snapshotAt: s.snapshotAt, snapshotIso: s.snapshotIso, motivo: s.motivo,
    conteggio: Object.keys(s.ordini).length,
    ordini: Object.entries(s.ordini).map(([orderId, r]) => ({ orderId, ...r })),
  };
}

module.exports = {
  fotografaPreesistenti, potaPreesistenti, separaPreesistenti,
  ePreesistente, idsPreesistenti, elencoPreesistenti, idDi, FILE,
};
