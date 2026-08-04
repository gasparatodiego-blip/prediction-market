'use strict';
// lib/rewards/coda-piazzamento.js — LA CODA AVANZA SOLO SU UN ESITO, MAI SU UN TOCCO.
//
// ═══ COSA GOVERNA ════════════════════════════════════════════════════════════════════════════════════
// Il terzo percorso di piazzamento della tab «Ottimizza», accanto ai due che esistevano già:
//
//   · «1 · Anteprima» sulla card  →  abilita il mercato. Non piazza, e non deve.
//   · «Conferma ed esegui»        →  RESET: cancella tutto, spegne ciò che esce dal piano, riaccende e
//                                    ripiazza il piano intero. È il percorso del riallocatore delle 6h.
//   · questa coda                 →  i mercati scelti dall'operatore, UNO PER VOLTA, ognuno con la sua
//                                    conferma. Non azzera niente e non tocca ciò che non è in coda.
//
// ═══ LA PROPRIETÀ CHE DEVE REGGERE ═══════════════════════════════════════════════════════════════════
// QUESTO MODULO NON PIAZZA. Non ha una funzione che invii, non importa un adapter, non conosce un
// endpoint. Decide soltanto SE la coda può avanzare, sentendo un esito che qualcun altro ha prodotto.
// È la ragione per cui un avanzamento automatico non è un rischio da sorvegliare ma una cosa che qui
// non si può scrivere.
//
// E avanza solo all'ULTIMA GAMBA. Un piano a due lati produce due esiti sullo stesso mercato: avanzare
// al primo lascerebbe il secondo orfano — cioè capitale su un solo lato, che fuori dal range
// [0,10–0,90] matura zero e dentro un terzo. Esattamente ciò che il piano a due gambe esiste per evitare.

/** Un esito è utilizzabile solo se dice tutto ciò che serve per decidere. Un campo mancante ⇒ non si
 *  avanza: «non lo so» non è «è andata bene». */
function esitoUtilizzabile(e) {
  return !!e
    && typeof e.marketId === 'string' && e.marketId.trim() !== ''
    && Number.isFinite(e.legIdx) && Number.isFinite(e.legTotal) && e.legTotal >= 1
    && Number.isFinite(e.at);
}

/**
 * LA DECISIONE. La coda può avanzare sentendo questo esito?
 *
 * @param {object} a
 *   coda            string[]  gli id in attesa; la testa è coda[0]
 *   esito           l'esito riportato da chi ha piazzato: {marketId, legIdx, legTotal, at}
 *   ultimoAt        number|null  l'`at` dell'ultimo esito già consumato (contro il doppio avanzamento)
 * @returns {{avanza: boolean, motivo: string}}
 */
function decidiAvanzamento({ coda = [], esito = null, ultimoAt = null } = {}) {
  const testa = Array.isArray(coda) && coda.length ? coda[0] : null;
  if (!testa) return { avanza: false, motivo: 'coda-vuota' };
  if (!esitoUtilizzabile(esito)) return { avanza: false, motivo: 'esito-non-utilizzabile' };
  if (ultimoAt != null && esito.at === ultimoAt) return { avanza: false, motivo: 'esito-gia-consumato' };
  if (String(esito.marketId).toLowerCase() !== String(testa).toLowerCase()) {
    // Un piazzamento su un mercato che NON è in testa non fa scorrere la coda. Succede davvero: si può
    // piazzare a mano da un'altra sezione mentre una coda è aperta, e quel piazzamento non è una
    // conferma di questo.
    return { avanza: false, motivo: 'altro-mercato' };
  }
  if (esito.legIdx + 1 < esito.legTotal) return { avanza: false, motivo: 'gamba-mancante' };
  return { avanza: true, motivo: 'ultima-gamba-piazzata' };
}

/** Toglie la testa e registra com'è andata. Puro: restituisce lo stato nuovo, non lo muta. */
function avanza({ coda = [], esiti = [], come = 'saltato', nome = null, capitale = 0 } = {}) {
  const testa = coda[0];
  if (!testa) return { coda, esiti };
  return {
    coda: coda.slice(1),
    esiti: [...esiti, {
      marketId: testa,
      nome: nome ?? String(testa).slice(0, 10) + '…',
      esito: come === 'piazzato' ? 'piazzato' : 'saltato',
      // Il capitale conta SOLO per ciò che è stato davvero piazzato: un saltato non impegna niente.
      capitale: come === 'piazzato' && Number.isFinite(capitale) ? capitale : 0,
    }],
  };
}

/** Aggiunge un mercato in fondo, senza duplicarlo. */
function metti({ coda = [], marketId = '' } = {}) {
  if (typeof marketId !== 'string' || !marketId.trim()) return coda;
  return coda.some((x) => String(x).toLowerCase() === marketId.toLowerCase()) ? coda : [...coda, marketId];
}

/** Il riepilogo finale: quanti piazzati, quanti saltati, quanto capitale impegnato. */
function riepilogo(esiti = []) {
  const piazzati = esiti.filter((x) => x.esito === 'piazzato');
  const saltati = esiti.filter((x) => x.esito === 'saltato');
  return {
    trattati: esiti.length,
    piazzati: piazzati.length,
    saltati: saltati.length,
    capitaleUsd: +piazzati.reduce((s, x) => s + (Number.isFinite(x.capitale) ? x.capitale : 0), 0).toFixed(2),
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/coda-piazzamento').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const E = (marketId, legIdx, legTotal, at) => ({ marketId, legIdx, legTotal, at });

  ok('coda vuota → non avanza', decidiAvanzamento({ coda: [], esito: E('A', 0, 1, 1) }).avanza === false);
  ok('esito sul mercato in testa, gamba unica → avanza',
    decidiAvanzamento({ coda: ['A', 'B'], esito: E('A', 0, 1, 1) }).avanza === true);
  ok('esito su un ALTRO mercato → non avanza',
    decidiAvanzamento({ coda: ['A', 'B'], esito: E('B', 0, 1, 1) }).motivo === 'altro-mercato');
  ok('  il confronto è insensibile al maiuscolo',
    decidiAvanzamento({ coda: ['0xAB'], esito: E('0xab', 0, 1, 1) }).avanza === true);
  ok('PRIMA gamba di due → NON avanza: l altra resterebbe orfana',
    decidiAvanzamento({ coda: ['A'], esito: E('A', 0, 2, 1) }).motivo === 'gamba-mancante');
  ok('seconda gamba di due → avanza',
    decidiAvanzamento({ coda: ['A'], esito: E('A', 1, 2, 2) }).avanza === true);
  ok('lo stesso esito non fa avanzare due volte',
    decidiAvanzamento({ coda: ['A'], esito: E('A', 0, 1, 7), ultimoAt: 7 }).motivo === 'esito-gia-consumato');
  ok('un esito incompleto non fa avanzare',
    decidiAvanzamento({ coda: ['A'], esito: { marketId: 'A' } }).motivo === 'esito-non-utilizzabile');
  ok('  nessun esito → non avanza', decidiAvanzamento({ coda: ['A'], esito: null }).avanza === false);

  // ── LA CODA
  ok('metti aggiunge in fondo', metti({ coda: ['A'], marketId: 'B' }).join() === 'A,B');
  ok('  e non duplica', metti({ coda: ['A'], marketId: 'a' }).join() === 'A');
  ok('  ignora un id vuoto', metti({ coda: ['A'], marketId: '  ' }).join() === 'A');

  const s1 = avanza({ coda: ['A', 'B'], esiti: [], come: 'piazzato', nome: 'Mercato A', capitale: 60 });
  ok('avanza toglie la testa', s1.coda.join() === 'B');
  ok('  e registra l esito', s1.esiti[0].esito === 'piazzato' && s1.esiti[0].capitale === 60);
  const s2 = avanza({ ...s1, come: 'saltato', nome: 'Mercato B' });
  ok('un saltato non impegna capitale', s2.esiti[1].esito === 'saltato' && s2.esiti[1].capitale === 0);

  const r = riepilogo(s2.esiti);
  ok('riepilogo: 2 trattati, 1 piazzato, 1 saltato', r.trattati === 2 && r.piazzati === 1 && r.saltati === 1);
  ok('  capitale solo dei piazzati', r.capitaleUsd === 60);

  console.log('coda-piazzamento: ' + n + ' assertions passed');
  return n;
}

module.exports = { decidiAvanzamento, avanza, metti, riepilogo, esitoUtilizzabile, selfcheck };
