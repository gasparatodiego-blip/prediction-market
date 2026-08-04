'use strict';
// lib/rewards/scadenza-mercato.js — DOVE PUBLYMARKET PUBBLICA DAVVERO LA DATA DI RISOLUZIONE.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Gamma espone `endDate` sul record del singolo mercato, ma lo OMETTE spesso — e non in casi rari:
// misurato il 4 agosto 2026, la pagina all'offset 300 dell'endpoint `/markets?active=true&closed=false`
// restituiva 100 record su 100 senza `endDate`, e 100 su 100 con la data presente sull'EVENTO padre.
// Sul board reward vivo erano 21 mercati su 117, venti dei quali negRisk, tutti mostrati con «—».
//
// ═══ PERCHÉ EREDITARE NON È INVENTARE ════════════════════════════════════════════════════════════════
// Su un evento multi-esito (negRisk) la data di risoluzione è una proprietà dell'EVENTO, non del singolo
// esito: «Wisconsin Governor Election Winner» si decide il 2026-11-03, e questo vale identicamente per
// la riga «Republicans win» e per la riga «Democrats win» — sono due esiti dello stesso voto, non due
// scadenze diverse. Leggere la data sul padre non è una stima né un default: è leggerla dove il venue
// la pubblica.
//
// Questo modulo non deduce MAI una data. Non c'è nessun ripiego «se non c'è metti fra un anno», nessuna
// data mediana, nessuna euristica sul testo della domanda. Tre esiti soltanto:
//
//   'market'  la data è sul mercato               → si usa quella, il padre non viene neanche guardato
//   'event'   la data è solo sull'evento padre    → si eredita, e si DICHIARA che è ereditata
//   null      non c'è né sull'uno né sull'altro   → resta ignota, e a valle deve restare visibile
//
// La provenienza esiste perché in futuro «scadenza 2026-11-03» e «scadenza 2026-11-03 ereditata» non
// siano lo stesso dato: se un giorno Polymarket pubblicasse per un esito una data diversa da quella del
// suo evento, l'ereditata sarebbe quella sbagliata e si vuole poterle distinguere senza rifare l'analisi.

/** Una stringa non vuota, o null. Nessuna coercizione, nessun trim silenzioso su valori non stringa. */
function testo(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Risolve la data di risoluzione di un mercato Gamma.
 * @param {object} m  il record del mercato come arriva da Gamma (con l'array `events` annidato)
 * @returns {{endDate: string|null, endDateSource: 'market'|'event'|null}}
 */
function risolviScadenza(m) {
  const rec = m || {};
  const propria = testo(rec.endDate);
  if (propria) return { endDate: propria, endDateSource: 'market' };

  // L'evento padre. Gamma annida un array `events`; nella pratica ne porta uno solo, ma se ne portasse
  // più d'uno si prende il PRIMO CHE HA UNA DATA anziché il primo e basta — un evento senza `endDate`
  // in testa all'array non deve nascondere quello che ce l'ha.
  const eventi = Array.isArray(rec.events) ? rec.events : [];
  for (const ev of eventi) {
    const d = ev && testo(ev.endDate);
    if (d) return { endDate: d, endDateSource: 'event' };
  }

  // Né sul mercato né sull'evento. Non si inventa: resta ignota, e chi la usa deve dichiararlo.
  return { endDate: null, endDateSource: null };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/scadenza-mercato').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  const A = '2026-11-03T00:00:00Z';
  const B = '2027-01-01T00:00:00Z';

  ok('data sul mercato → source market', (() => {
    const r = risolviScadenza({ endDate: A, events: [{ endDate: B }] });
    return r.endDate === A && r.endDateSource === 'market';
  })());

  ok('  e il padre non la sovrascrive MAI, neanche se diversa', (() => {
    const r = risolviScadenza({ endDate: A, events: [{ endDate: B }] });
    return r.endDate === A;
  })());

  ok('data assente sul mercato, presente sull evento → ereditata e dichiarata', (() => {
    const r = risolviScadenza({ endDate: null, events: [{ slug: 'wisconsin-governor-winner-2026', endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('  stringa vuota sul mercato conta come assente (non come data)', (() => {
    const r = risolviScadenza({ endDate: '   ', events: [{ endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('  il primo evento CON data vince sul primo evento e basta', (() => {
    const r = risolviScadenza({ events: [{ endDate: null }, { endDate: A }] });
    return r.endDate === A && r.endDateSource === 'event';
  })());

  ok('nessuna data da nessuna parte → null, e la provenienza è null', (() => {
    const r = risolviScadenza({ endDate: null, events: [{ slug: 'x' }] });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  nessun evento affatto → null (non esplode)', (() => {
    const r = risolviScadenza({ endDate: null });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  record nullo → null (non esplode)', (() => {
    const r = risolviScadenza(null);
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('  events non array → ignorato senza esplodere', (() => {
    const r = risolviScadenza({ events: { endDate: A } });
    return r.endDate === null && r.endDateSource === null;
  })());

  ok('NON si inventa mai una data: senza fonti l esito è null, non una data plausibile', (() => {
    const r = risolviScadenza({ question: 'Will X happen by December 2026?' });
    return r.endDate === null;
  })());

  ok('un numero non è una data', (() => {
    const r = risolviScadenza({ endDate: 1799999999999, events: [] });
    return r.endDate === null && r.endDateSource === null;
  })());

  console.log('scadenza-mercato: ' + n + ' assertions passed');
  return n;
}

module.exports = { risolviScadenza, selfcheck };
