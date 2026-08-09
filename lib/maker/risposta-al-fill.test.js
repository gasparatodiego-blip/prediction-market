#!/usr/bin/env node
'use strict';
// lib/maker/risposta-al-fill.test.js — I TRE SCENARI CHIESTI, SUL CODICE VERO.
//
// Non prova le funzioni pure (lo fa `risposta-al-fill.selfcheck()`): prova il CABLAGGIO dentro
// `completaCoppia`, cioè le cose che solo il collegamento può sbagliare —
//   · che l'ordine «rimanenza» e la gamba contraria vengano davvero proposti al piazzamento;
//   · che l'esenzione da «mai primo sul libro» valga SOLO sulla gamba contraria e su nient'altro;
//   · che il riposizionamento usi il tetto in vigore col ripiego, e non metà del capitale fuso.
//
// NESSUN ORDINE REALE: la corsia di piazzamento è un registratore, niente rete, niente file.

const assert = require('assert');
const AC = require('./auto-close');
const RF = require('./risposta-al-fill');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'f'.repeat(64);
const T0 = 1_700_000_000_000;

const REGOLE = {
  readable: true, marketId: MKT, tick: 0.01, minSize: 20, maxSpreadCents: 4.5,
  books: {
    yes: { scoringMid: 0.50, bestBid: 0.49 },
    no: { scoringMid: 0.50, bestBid: 0.49 },
  },
};
const DP = {
  yes: { bids: [{ price: 0.30, size: 100 }], asks: [{ price: 0.34, size: 100 }] },
  no: { bids: [{ price: 0.30, size: 100 }], asks: [{ price: 0.34, size: 100 }] },
};
const REG = { pulisci: () => {}, leggi: () => null, scrivi: () => {} };

/** Esegue `completaCoppia` vero con la sola corsia di piazzamento sostituita da un registratore. */
async function giro({ sizePosseduta, sizeAltroLato, livello = 2, azione = 'maker-con-tetto', minSize = 20 }) {
  const piazzati = [];
  const auditRighe = [];
  const residui = [];
  const esito = await AC.completaCoppia({
    marketId: MKT, tok: 'tok', book: 'no', rules: { ...REGOLE, minSize },
    liv: {
      livello, azione, prezzo: 0.31, size: Math.max(0, sizePosseduta - sizeAltroLato),
      numeri: { sizePosseduta, sizeAltroLato, mancaAllaCoppia: sizePosseduta - sizeAltroLato, attesaMin: null },
    },
    dpMerge: DP, attesa: null, chiaveMerge: 'k', reg: REG,
    cancelOrderIds: [], prezzoCarico: 0.53, t0: T0,
    deps: {
      cancelOrder: async () => ({ ok: true }),
      placeOrder: async (spec) => { piazzati.push(spec); return { ok: true, orderId: '0x' + piazzati.length }; },
      registraResiduo: (r) => residui.push(r),
    },
    audit: (r) => auditRighe.push(r),
  });
  return { esito, piazzati, auditRighe, residui };
}

(async () => {

  console.log('\n══ SCENARIO 1 · FILL PARZIALE CON RIMASUGLIO SOTTO IL MINIMO');
  {
    // Il caso Dallas vero: 39,7 possedute, 36,3 coperte ⇒ 3,4 scoperte, minimo del venue 20.
    const g = await giro({ sizePosseduta: 39.7, sizeAltroLato: 36.3 });
    ok('classificato come fill PARZIALE', g.esito.tipoFill === RF.FILL_PARZIALE, g.esito.tipoFill);
    ok('il residuo finisce COMUNQUE nel registro (il passo si aggiunge, non sostituisce)',
      g.residui.length === 1 && Math.abs(g.residui[0].sizeScoperta - 3.4) < 1e-6,
      `${g.residui.length} voci`);

    const rim = g.piazzati.find((p) => p.side === 'SELL');
    const contro = g.piazzati.find((p) => p.side === 'BUY');
    ok('l\'ordine RIMANENZA viene piazzato', !!rim, rim ? `${rim.size} ${rim.book} a ${rim.price}` : 'assente');
    ok('  sul lato POSSEDUTO e per la size del rimasuglio', rim && rim.book === 'no' && Math.abs(rim.size - 3.4) < 1e-6);
    ok('  e dichiara inCoda: «mai primo» gli si applica per intero', rim && rim.inCoda === true);
    ok('la GAMBA CONTRARIA viene piazzata contestualmente', !!contro,
      contro ? `${contro.size} ${contro.book} a ${contro.price}` : 'assente');
    ok('  sull\'altro lato e con la STESSA size del rimasuglio',
      contro && contro.book === 'yes' && Math.abs(contro.size - 3.4) < 1e-6);
    ok('  ed è l\'UNICA a essere esente da «mai primo sul libro»',
      contro && contro.inCoda === undefined && rim.inCoda === true);
    ok('  a un tick sopra il miglior bid altrui (scavalca la coda)', contro && contro.price === 0.31,
      String(contro && contro.price));
    ok('  e NON attraversa lo spread (bestAsk 0.34)', contro && contro.price < 0.34);
    ok('la nota dell\'ordine dichiara l\'eccezione per iscritto',
      contro && /PRIMO ASSOLUTO/.test(contro.note || ''));
    ok('l\'audit registra entrambe le gambe con l\'esito',
      g.auditRighe.filter((r) => /^rimasuglio-/.test(r.outcome || '')).length === 2,
      g.auditRighe.map((r) => r.outcome).join(' · '));
    ok('l\'esito è terminale e marcato come rimasuglio',
      g.esito.esito === 'piazzato' && g.esito.rimasuglio === true);
  }

  console.log('\n══ SCENARIO 2 · FILL COMPLETO (nessuna copertura)');
  {
    const g = await giro({ sizePosseduta: 12, sizeAltroLato: 0 });
    ok('classificato come fill COMPLETO', g.esito.tipoFill === RF.FILL_COMPLETO, g.esito.tipoFill);
    const contro = g.piazzati.find((p) => p.side === 'BUY');
    ok('la gamba aggressiva viene proposta sulla stessa size del fill',
      contro && Math.abs(contro.size - 12) < 1e-6, contro ? String(contro.size) : 'assente');
    ok('  ed è esente da «mai primo»', contro && contro.inCoda === undefined);
  }

  console.log('\n══ SCENARIO 3 · IL TETTO DELLA COPPIA (110¢) RESTA DURO');
  {
    // carico 0.53 ⇒ il massimo per la controparte è 1.10 − 0.53 = 0.57. Il bid+tick sarebbe 0.31,
    // quindi qui non morde; si prova il caso in cui morde con un bid altissimo.
    const p = RF.pianificaRimasuglio({
      manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.54, tick: 0.01,
      bidsControparte: [{ price: 0.80 }], asksControparte: [{ price: 0.95 }],
      massimoControparte: 1.10 - 0.53,
    });
    ok('con un bid altissimo il prezzo si ferma al tetto della coppia',
      Math.abs(p.controparte.prezzo - 0.57) < 1e-9, String(p.controparte.prezzo));
    ok('  cioè la coppia non supera mai 110¢',
      (0.53 + p.controparte.prezzo) <= 1.10 + 1e-9, `${((0.53 + p.controparte.prezzo) * 100).toFixed(1)}¢`);
  }

  console.log('\n══ SCENARIO 4 · IL RIPOSIZIONAMENTO: TETTO PIENO, RIDOTTO, E TROPPO PICCOLO');
  {
    const pieno = RF.capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 500, minSize: 20, prezzoRif: 0.5 });
    ok('capitale libero ≥ tetto ⇒ si riposiziona su $130 PIENI',
      pieno.azione === 'riposiziona' && pieno.capitaleUsd === 130, pieno.motivo);
    const ridotto = RF.capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 80, minSize: 20, prezzoRif: 0.5 });
    ok('capitale libero $80 ⇒ si usa $80, NON ci si blocca e NON si forza $130',
      ridotto.azione === 'riposiziona' && ridotto.capitaleUsd === 80, ridotto.motivo);
    const briciola = RF.capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 6, minSize: 20, prezzoRif: 0.5 });
    ok('capitale sotto il minimo del venue ⇒ accumula, non un ordine troppo piccolo',
      briciola.azione === 'accumula', briciola.motivo);
    ok('  e NON è mai il capitale FUSO a decidere la size (era il difetto)',
      pieno.capitaleUsd === 130 && pieno.capitaleUsd !== 3.4);
  }

  console.log('\n══ SCENARIO 5 · «MAI PRIMO SUL LIBRO» RESTA ATTIVO OVUNQUE ALTRO');
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, 'auto-close.js'), 'utf8');
    // Ogni omissione di `inCoda` deve essere condizionata a un flag `primoAssoluto`/`esente`.
    const omissioni = src.match(/\.\.\.\((?:primoAssoluto|esente) \? \{\} : \{ inCoda: true \}\)/g) || [];
    ok('le omissioni di `inCoda` sono ESATTAMENTE due, entrambe condizionate',
      omissioni.length === 2, `${omissioni.length} trovate`);
    ok('  e non esiste nessuna omissione incondizionata di `inCoda`',
      !/\{\s*\}\s*:\s*\{\s*inCoda:\s*true\s*\}/.test(src.replace(/\.\.\.\((?:primoAssoluto|esente) \? \{\} : \{ inCoda: true \}\)/g, '')));
    const conta = (src.match(/inCoda:\s*true/g) || []).length;
    ok(`  e «inCoda: true» resta dichiarato su ${conta} gambe del file`, conta >= 3, String(conta));
    // La regola stessa non è stata toccata.
    const mo = fs.readFileSync(require('path').join(__dirname, 'manual-order.js'), 'utf8');
    ok('la regola «mai primo» non è stata modificata: resta opt-in per chiamante',
      /spec\.inCoda/.test(mo) && /mai-primo-sul-libro/.test(mo));
    // E il modulo nuovo non la nomina nemmeno: propone, non giudica.
    const rf = fs.readFileSync(require('path').join(__dirname, 'risposta-al-fill.js'), 'utf8');
    ok('il modulo nuovo non applica la regola, la dichiara soltanto',
      !/mai-primo-sul-libro'/.test(rf));
  }

  console.log(`\nrisposta al fill (cablaggio): ${pass} passati, ${fail} falliti\n`);
  assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
})();
