#!/usr/bin/env node
'use strict';
// lib/maker/riposizionamento-cablato.test.js — IL PUNTO (d) È ATTIVO, NON SOLO SCRITTO.
//
// ═══ COSA PROVA, E PERCHÉ SERVIVA UN TEST A PARTE ════════════════════════════════════════════════════
// `capitalePerRiposizionamento` è provata dal suo selfcheck, e `completaCoppia` dal test del cablaggio.
// Restava scoperta la cosa che decide se il punto (d) funziona DAVVERO su capitale reale: le due
// letture — `tettoMercato` e `capitaleLibero` — sono iniettate da agent40 oppure no?
//
// Senza di esse `runAutoCloseCycle` risponde `azione: 'niente'` e il riposizionamento non parte: è
// esattamente lo stato in cui il modulo è stato consegnato, di proposito. Questo file prova le due
// metà della domanda:
//   1 · che agent40 le inietti davvero (lettura del sorgente: è un fatto sul cablaggio, non sul flusso);
//   2 · che con quel contratto il ciclo VERO produca un'azione con un capitale reale, e senza che
//       nessuna delle due produca `niente`.
//
// NESSUN ORDINE REALE: piazzamento e cancellazione sono registratori, nessuna rete, nessun file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runAutoCloseCycle } = require('./auto-close');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + '7'.repeat(64);
const TOK_YES = 'tok-yes';
const TOK_NO = 'tok-no';
const NOW = 5_000_000;

function registroFinto() {
  const m = new Map();
  return { leggi: (k) => m.get(k) || null, scrivi: (k, v) => m.set(k, v), pulisci: (k) => m.delete(k) };
}

/**
 * Un giro completo con il CONTRATTO ESATTO che agent40 inietta dopo il cablaggio.
 * `tetto` e `libero` sono i due valori nuovi; passare `undefined` simula il PRIMA del cablaggio.
 */
async function ciclo({ tetto, libero, minSize = 20, cablato = true }) {
  const piazzati = [];
  const deps = {
    now: () => NOW,
    marketIds: [MKT],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize, maxSpreadCents: 4.5, negRisk: false,
      books: { yes: { scoringMid: 0.50, bestBid: 0.49 }, no: { scoringMid: 0.50, bestBid: 0.49 } },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    // Coppia COMPLETA: 30 YES e 30 NO ⇒ `decidiLivello` risponde `merge`, il ramo che riposiziona.
    readPositions: async () => ({ ok: true, positions: [
      { tokenId: TOK_YES, size: 30, avgPrice: 0.50 },
      { tokenId: TOK_NO, size: 30, avgPrice: 0.50 },
    ] }),
    listOrders: async () => ({ ok: true, orders: [] }),
    readDepth: () => ({ readable: true, yes: { bids: [{ price: 0.30 }], asks: [{ price: 0.34 }] },
      no: { bids: [{ price: 0.30 }], asks: [{ price: 0.34 }] } }),
    attesaMerge: registroFinto(),
    // La fusione riesce: è il percorso che accoda il riposizionamento.
    mergeOnChain: async () => ({ eseguito: true, transactionHash: '0xhash', transactionID: 'tx1', stato: 'STATE_CONFIRMED' }),
    placeOrder: async (spec) => { piazzati.push(spec); return { ok: true, sent: true, orderId: 'ord-' + piazzati.length }; },
    cancelOrder: async () => ({ ok: true }),
    audit: () => {},
  };
  if (cablato) {
    deps.tettoMercato = () => ({ readable: true, capUsd: tetto, stale: false, ageSec: 10 });
    deps.capitaleLibero = () => libero;
  }
  const res = await runAutoCloseCycle(deps);
  const rips = (res.actions || []).filter((a) => a.action === 'riposizionamento-dopo-chiusura');
  return { res, rip: rips[0], rips, piazzati };
}

(async () => {

  console.log('\n══ 1 · IL CABLAGGIO ESISTE DAVVERO IN agent40');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    ok('agent40 inietta `tettoMercato`', /tettoMercato:\s*\(marketId\)\s*=>/.test(src));
    ok('  e lo legge da `readAllocatedCapital`, la stessa fonte del rimpiazzo di gamba',
      /tettoMercato:[^\n]*readAllocatedCapital\(marketId\)/.test(src));
    ok('agent40 inietta `capitaleLibero`', /capitaleLibero:\s*\(\)\s*=>/.test(src));
    ok('  e passa il numero SOLO se il saldo è affidabile (stantio ⇒ null, mai zero)',
      /capitaleLibero:[\s\S]{0,200}?affidabile === true[\s\S]{0,120}?:\s*null\)/.test(src));
    // La finestra e' 800 caratteri e non 200 perche' dal 12 agosto fra le due righe si costruiscono
    // anche i due registri del ciclo (attese di merge e modalita' chiusura). La proprieta' difesa e'
    // «una lettura sola, e prima del ciclo», non «le due righe sono adiacenti».
    ok('  il saldo è letto UNA volta per giro, prima del ciclo',
      /const saldoGiro = await saldoDelGiro\(\);[\s\S]{0,800}?runAutoCloseCycle\(/.test(src)
      // UNA sola lettura DENTRO il giro di chiusura: l'altra occorrenza nel file appartiene al ciclo
      // di riprezzo, che e' un giro diverso e ha il suo saldo.
      && (src.match(/const saldoGiro = await saldoDelGiro\(\)/g) || []).length === 1);
    ok('le due letture sono INIETTATE, non importate dentro auto-close', (() => {
      const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
      return !/require\('\.\/allocated-capital'\)/.test(ac) && !/require\('\.\/saldo-cache'\)/.test(ac);
    })());
  }

  console.log('\n══ 2 · PRIMA DEL CABLAGGIO: «niente» (lo stato in cui il modulo era stato consegnato)');
  {
    const { rip } = await ciclo({ cablato: false });
    ok('senza le due deps il riposizionamento NON parte', !!rip && rip.ok === false, rip && rip.azione);
    ok('  e lo dichiara come `niente`, non come un fallimento', rip && rip.azione === 'niente', rip && rip.reason);
  }

  console.log('\n══ 3 · DOPO IL CABLAGGIO · CAPITALE PIENO ⇒ AZIONE REALE A $130');
  {
    const { rip, rips, piazzati } = await ciclo({ tetto: 130, libero: 500 });
    ok('il riposizionamento PARTE (non più «niente»)', !!rip && rip.azione !== 'niente', rip && rip.reason);
    ok('  ed è riuscito', rip && rip.ok === true, rip && rip.reason);
    ok('  con la causa dichiarata', rip && rip.causa === 'merge riuscito', rip && rip.causa);
    ok('  e due gambe proposte', rip && rip.gambe === 2, String(rip && rip.gambe));
    // La coppia e' completa su ENTRAMBI i lati, quindi il ciclo la fonde una volta per posizione e
    // accoda DUE riposizionamenti: e' il comportamento giusto e va misurato per riposizionamento.
    const dopoMerge = piazzati.filter((p) => /riposizionamento dopo chiusura/.test(p.note || ''));
    ok('  ogni riposizionamento propone BUY YES e BUY NO', dopoMerge.length === 2 * rips.length
      && dopoMerge.some((p) => p.book === 'yes') && dopoMerge.some((p) => p.book === 'no'),
      dopoMerge.map((p) => `${p.book} ${p.size}@${p.price}`).join(' · '));
    const perRip = dopoMerge.slice(0, 2).reduce((a, p) => a + p.size * p.price, 0);
    ok('  e ognuno impegna ~$130, NON i 30 share fusi (era il difetto)',
      Math.abs(perRip - 130) < 2, `$${perRip.toFixed(2)} per riposizionamento · ${rips.length} riposizionamenti`);
    ok('  e il capitale deciso viaggia nel referto', rips.every((x) => x.capitaleUsd === 130));
    ok('  ogni gamba dichiara inCoda: «mai primo» resta attivo qui', dopoMerge.every((p) => p.inCoda === true));
  }

  console.log('\n══ 4 · DOPO IL CABLAGGIO · CAPITALE RIDOTTO ⇒ SI USA QUELLO CHE C\'È');
  {
    const { rip, piazzati } = await ciclo({ tetto: 130, libero: 80 });
    ok('il riposizionamento PARTE lo stesso', !!rip && rip.ok === true, rip && rip.reason);
    const dopoMerge = piazzati.filter((p) => /riposizionamento dopo chiusura/.test(p.note || ''));
    const perRip = dopoMerge.slice(0, 2).reduce((a, p) => a + p.size * p.price, 0);
    ok('  e usa $80, non $130 e non zero', Math.abs(perRip - 80) < 2, `$${perRip.toFixed(2)} per riposizionamento`);
    ok('  il motivo dice che il tetto non è stato raggiunto', rip && /capitale libero adesso/.test(rip.reason || ''),
      rip && rip.reason);
  }

  console.log('\n══ 5 · I DUE FAIL-CLOSED CHE NON DEVONO CEDERE');
  {
    const briciola = await ciclo({ tetto: 130, libero: 6 });
    ok('capitale sotto il minimo del venue ⇒ accumula, nessun ordine forzato',
      briciola.rip && briciola.rip.azione === 'accumula' && briciola.rip.ok === false, briciola.rip && briciola.rip.reason);
    const cieco = await ciclo({ tetto: 130, libero: null });
    ok('capitale libero ILLEGGIBILE ⇒ non si riposiziona al buio',
      cieco.rip && cieco.rip.azione === 'niente', cieco.rip && cieco.rip.reason);
    ok('  e `null` NON viene contato come zero', cieco.rip.azione !== briciola.rip.azione);
    const senzaTetto = await ciclo({ tetto: null, libero: 500 });
    ok('tetto non leggibile ⇒ non si riposiziona (fail-closed)',
      senzaTetto.rip && senzaTetto.rip.azione === 'niente', senzaTetto.rip && senzaTetto.rip.reason);
  }

  console.log(`\nriposizionamento cablato: ${pass} passati, ${fail} falliti\n`);
  assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
})();
