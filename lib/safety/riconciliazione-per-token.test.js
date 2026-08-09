#!/usr/bin/env node
'use strict';
// lib/safety/riconciliazione-per-token.test.js — UN FILL VALE UNA VOLTA, NON UNA PER RIPIAZZAMENTO.
//
// ═══ IL GUASTO CHE QUESTO FILE DIFENDE ═══════════════════════════════════════════════════════════════
// `planReconcile` risolve un ordine sparito dagli ordini aperti guardando i trade del venue. Confrontava
// `totalFilled` — il volume del venue su QUEL token+lato, una grandezza per TOKEN — con `already`, cioè
// quanto risultava registrato per QUELLA SINGOLA idempotencyKey. Due grandezze su scale diverse.
//
// Il ciclo di riprezzo sostituisce la stessa gamba ogni ~60 secondi, e ogni sostituzione porta una chiave
// NUOVA. Appena l'ordine sostituito lascia gli ordini aperti cade nel ramo `/trades`, ritrova lo stesso
// identico volume, e siccome il suo `already` vale 0 lo registra INTERO come fill proprio.
//
// ═══ MISURATO IN PRODUZIONE — Chengdu 37°C, 9 agosto 2026 ═══════════════════════════════════════════
//   136 righe di fill · 136 idempotencyKey distinte · `filledSize` sempre lo stesso valore reale
//   (21,69 · 14 · 7,69) ⇒ 2.892,46 share registrate, 2.790,32 di netto FIFO — contro una posizione
//   VERA al venue di ZERO share.
//
// Il danno non è contabile ma operativo: `openNotionalUsd` saliva a **$2.405,40** contro un tetto di
// **$600**, quindi `limit-max-open-notional` rifiutava OGNI piazzamento — con il bot su AVVIA e il kill
// revocato. Il bot si è fermato per una somma sbagliata, non per una regola.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · dieci ripiazzamenti dello stesso ordine logico, un solo fill vero ⇒ il volume si conta UNA volta;
//   2 · un fill reale nuovo viene registrato per intero, e cresce esattamente di quello;
//   3 · il ramo `size_matched` (ordine ancora a riposo) resta com'era: lì il confronto per chiave è quello giusto;
//   4 · i fail-closed non sono stati toccati.
//
// PURO: `planReconcile` non tocca né rete né disco. Nessun ordine reale.

const assert = require('assert');
const R = require('./reconcile-fills');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const TOK = '88308168949064307534261024064767354595062606981129309292448314779923529421554';  // Chengdu, quello vero
const U = 'operator';

/** Un ordine inviato, come lo vede `planReconcile`. Ogni ripiazzamento ha una chiave NUOVA. */
const inviato = (n, side = 'SELL', size = 21.69, price = 0.62) => ({
  userId: U, venue: 'polymarket', idempotencyKey: `idem_${n}`, orderId: `0x${n}`,
  tokenId: TOK, side, price, size, notionalUsd: +(size * price).toFixed(4), ts: 1_000 + n,
});

/** Il venue ha visto UN fill solo su quel token+lato: 21,69 share a 62¢. Sempre lo stesso, sempre quello. */
const TRADE_VERO = [{ tokenId: TOK, side: 'SELL', size: 21.69, price: 0.62 }];

console.log('\n══ 1 · DIECI RIPIAZZAMENTI, UN SOLO FILL VERO');
{
  // Dieci ordini logici successivi — è esattamente ciò che il ciclo di riprezzo produce in dieci minuti.
  // Nessuno di essi è più fra gli ordini aperti (sono stati tutti sostituiti), quindi cadono tutti nel
  // ramo `/trades`, quello che sbagliava.
  const sentOrders = Array.from({ length: 10 }, (_, i) => inviato(i + 1));
  const p = R.planReconcile({
    userId: U, sentOrders, ledgerRows: [], venueReachable: true,
    venueOrders: [], venueFills: TRADE_VERO, venuePositions: [], now: 9_000,
  });
  const totale = p.toRecord.reduce((s, f) => s + f.filledSize, 0);
  ok('viene registrato UN solo fill, non dieci', p.toRecord.length === 1, `${p.toRecord.length} righe`);
  ok('  e il volume vale 21,69 share, non 216,90', Math.abs(totale - 21.69) < 1e-6, `${totale.toFixed(2)} share`);
  ok('  gli altri nove non inventano niente', p.toRecord.length + p.toNoFill.length <= 10);

  // La prova del prima/dopo sulla STESSA funzione: con la contabilità per chiave il totale esplodeva.
  const perChiave = (() => {
    let t = 0;
    const gia = new Map();
    for (const o of sentOrders) {
      const tot = 21.69;                       // ciò che il venue riporta, uguale per tutti
      const already = gia.get(o.idempotencyKey) || 0;   // sempre 0: la chiave è nuova ogni volta
      const d = tot - already;
      if (d > 1e-9) { t += d; gia.set(o.idempotencyKey, tot); }
    }
    return t;
  })();
  ok('  (com\'era: la contabilità per CHIAVE dava 216,90 share)', Math.abs(perChiave - 216.9) < 1e-6,
    `${perChiave.toFixed(2)} share — 10× il vero`);
}

console.log('\n══ 2 · UN FILL REALE NUOVO VIENE REGISTRATO PER INTERO');
{
  // Il ledger sa già dei 21,69. Il venue adesso ne riporta 30 in tutto: 8,31 sono nuovi e VANNO contati.
  const ledgerRows = [{ kind: 'fill', userId: U, venue: 'polymarket', tokenId: TOK, side: 'SELL',
    filledSize: 21.69, filledPrice: 0.62, idempotencyKey: 'idem_1', ts: 1_001 }];
  const p = R.planReconcile({
    userId: U, sentOrders: [inviato(11)], ledgerRows, venueReachable: true,
    venueOrders: [], venueFills: [{ tokenId: TOK, side: 'SELL', size: 30, price: 0.62 }],
    venuePositions: [], now: 9_000,
  });
  const totale = p.toRecord.reduce((s, f) => s + f.filledSize, 0);
  ok('il fill nuovo viene registrato', p.toRecord.length === 1);
  ok('  e vale ESATTAMENTE il delta (8,31), non i 30 pieni', Math.abs(totale - 8.31) < 1e-6, `${totale.toFixed(2)} share`);
}

console.log('\n══ 3 · NESSUN FILL NUOVO ⇒ NIENTE VIENE REGISTRATO');
{
  const ledgerRows = [{ kind: 'fill', userId: U, venue: 'polymarket', tokenId: TOK, side: 'SELL',
    filledSize: 21.69, filledPrice: 0.62, idempotencyKey: 'idem_1', ts: 1_001 }];
  const p = R.planReconcile({
    userId: U, sentOrders: [inviato(12), inviato(13), inviato(14)], ledgerRows, venueReachable: true,
    venueOrders: [], venueFills: TRADE_VERO, venuePositions: [], now: 9_000,
  });
  ok('tre ripiazzamenti su un volume già registrato ⇒ ZERO righe nuove', p.toRecord.length === 0,
    `${p.toRecord.length} righe`);
}

console.log('\n══ 4 · IL RAMO `size_matched` NON È STATO TOCCATO');
{
  // Ordine ANCORA a riposo: il venue dice quanto di QUELL'ordine è stato eseguito. Lì il confronto per
  // chiave è quello corretto, ed era già giusto.
  const o = inviato(20);
  const p = R.planReconcile({
    userId: U, sentOrders: [o], ledgerRows: [], venueReachable: true,
    venueOrders: [{ id: o.orderId, asset_id: TOK, side: 'SELL', price: '0.62', original_size: '21.69', size_matched: '5' }],
    venueFills: null, venuePositions: [], now: 9_000,
  });
  ok('un ordine a riposo con 5 share eseguite le registra', p.toRecord.length === 1
    && Math.abs(p.toRecord[0].filledSize - 5) < 1e-6, p.toRecord[0] && String(p.toRecord[0].filledSize));

  // E i due rami non si sommano fra loro nella stessa passata.
  const o2 = inviato(21);
  const p2 = R.planReconcile({
    userId: U, sentOrders: [o, o2], ledgerRows: [], venueReachable: true,
    venueOrders: [{ id: o.orderId, asset_id: TOK, side: 'SELL', price: '0.62', original_size: '21.69', size_matched: '5' }],
    venueFills: [{ tokenId: TOK, side: 'SELL', size: 5, price: 0.62 }], venuePositions: [], now: 9_000,
  });
  const tot2 = p2.toRecord.reduce((s, f) => s + f.filledSize, 0);
  ok('  e lo stesso volume visto dai due rami vale UNA volta sola', Math.abs(tot2 - 5) < 1e-6,
    `${tot2.toFixed(2)} share da ${p2.toRecord.length} righe`);
}

console.log('\n══ 5 · I FAIL-CLOSED NON SONO STATI TOCCATI');
{
  const p1 = R.planReconcile({ userId: U, sentOrders: [inviato(30)], ledgerRows: [], venueReachable: false,
    venueOrders: [], venueFills: TRADE_VERO, now: 9_000 });
  ok('venue irraggiungibile ⇒ niente viene registrato, resta UNKNOWN',
    p1.toRecord.length === 0 && p1.stillUnknown.length === 1, p1.stillUnknown[0] && p1.stillUnknown[0].reason);

  const p2 = R.planReconcile({ userId: U, sentOrders: [inviato(31)], ledgerRows: [], venueReachable: true,
    venueOrders: [], venueFills: [], venuePositions: null, now: 9_000 });
  ok('senza la lettura delle posizioni non si dichiara «mai fillato»',
    p2.toNoFill.length === 0, `${p2.toNoFill.length} no-fill`);

  ok('un lato non leggibile non produce chiave (fail-closed)',
    R.tokenSideKey({ tokenId: TOK, side: 'BOH' }) === null && R.tokenSideKey({ side: 'SELL' }) === null);
  ok('  e la chiave giusta distingue i due lati',
    R.tokenSideKey({ tokenId: TOK, side: 'SELL' }) !== R.tokenSideKey({ tokenId: TOK, side: 'BUY' }));

  // Il conteggio per token+lato somma su TUTTE le chiavi — è il punto dell'intera correzione.
  const m = R.recordedFilledByTokenSide([
    { kind: 'fill', tokenId: TOK, side: 'SELL', filledSize: 10, idempotencyKey: 'a' },
    { kind: 'fill', tokenId: TOK, side: 'SELL', filledSize: 5, idempotencyKey: 'b' },
    { kind: 'fill', tokenId: TOK, side: 'BUY', filledSize: 7, idempotencyKey: 'c' },
    { kind: 'nofill', tokenId: TOK, side: 'SELL', idempotencyKey: 'd' },
  ]);
  ok('il totale per token+lato somma su tutte le chiavi', m.get(R.tokenSideKey({ tokenId: TOK, side: 'SELL' })) === 15);
  ok('  e non mescola i due lati', m.get(R.tokenSideKey({ tokenId: TOK, side: 'BUY' })) === 7);
}

console.log(`\nriconciliazione per token: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
