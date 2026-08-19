#!/usr/bin/env node
'use strict';
// L'AGGANCIO del trigger a banda dentro il ciclo di uscita: decideClose deve giudicare un'uscita GIA'
// a riposo, non limitarsi a dire «gia coperta». E la vecchia soglia fissa non deve sopravvivere da
// nessuna parte.
//
// Nessun venue, nessun ordine: tutto iniettato.

const fs = require('fs');
const path = require('path');
const { decideClose, runAutoCloseCycle } = require('./auto-close');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const H = 3_600_000;
const NOW = 1_000_000_000;

const regole = (mid = 0.50, raggioC = 2.25, bid = 0.495, extra = {}) => ({
  readable: true, tick: 0.01, minSize: 50, maxSpreadCents: raggioC,
  midSource: 'live-book', midAgeSec: 3,  // ⚠ book DATABILE: dal 19/08 `decideClose` rifiuta un bid senza eta (c919981). Il gate e difeso in coda al file, non aggirato.
  tokenId: 'ty', tokenIdNo: 'tn',
  books: { yes: { scoringMid: mid, bestBid: bid }, no: { scoringMid: +(1 - mid).toFixed(4), bestBid: +(1 - bid).toFixed(4) } },
  ...extra,
});
const pos = { tokenId: 'ty', size: 50, avgPrice: 0.50 };

console.log('\n── nessuna uscita a riposo ⇒ se ne piazza una all obiettivo');
{
  const d = decideClose({ position: pos, restingOrders: [], rules: regole(), book: 'yes', now: NOW });
  ok('azione close', d.action === 'close', d.action);
  ok('  a carico +1%', d.price === 0.51, String(d.price));
}

console.log('\n── uscita a riposo DENTRO banda e nei tempi ⇒ si aspetta');
{
  const resting = [{ orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H }];
  const d = decideClose({ position: pos, restingOrders: resting, rules: regole(), book: 'yes', now: NOW });
  ok('azione already-covered', d.action === 'already-covered', d.action);
  ok('  e il motivo riporta il verdetto del trigger', /dentro banda/.test(d.reason), d.reason.slice(-60));
}

console.log('\n── TRIGGER BANDA · il mid si e mosso ⇒ chiusura a MERCATO');
{
  const resting = [{ orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H }];
  const d = decideClose({ position: pos, restingOrders: resting, rules: regole(0.42, 2.25, 0.415), book: 'yes', now: NOW });
  ok('azione close-at-market', d.action === 'close-at-market', d.action);
  ok('  trigger band-exit', d.trigger === 'band-exit');
  ok('  si vende al MIGLIOR BID, non a un prezzo inventato', d.price === 0.415, String(d.price));
  ok('  e dice quale ordine va cancellato prima', Array.isArray(d.cancelOrderIds) && d.cancelOrderIds.includes('e1'));
}

console.log('\n── TRIGGER BANDA · la banda si e RISTRETTA, il mid e fermo');
{
  const resting = [{ orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H }];
  const largo = decideClose({ position: pos, restingOrders: resting, rules: regole(0.50, 2.25), book: 'yes', now: NOW });
  ok('con banda larga si aspetta', largo.action === 'already-covered');
  const stretto = decideClose({ position: pos, restingOrders: resting, rules: regole(0.50, 0.5), book: 'yes', now: NOW });
  ok('  ristretta, la STESSA uscita fa scattare il trigger', stretto.action === 'close-at-market', stretto.action);
  ok('  col mid identico', stretto.trigger === 'band-exit');
}

console.log('\n── TETTO DI ATTESA · 24 ore, anche dentro banda');
{
  const vecchia = [{ orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 25 * H }];
  const d = decideClose({ position: pos, restingOrders: vecchia, rules: regole(), book: 'yes', now: NOW });
  ok('oltre 24h si chiude a mercato', d.action === 'close-at-market', d.action);
  ok('  trigger max-wait', d.trigger === 'max-wait');
  ok('  ed e configurabile', decideClose({ position: pos, restingOrders: [{ ...vecchia[0], createdMs: NOW - 2 * H }],
    rules: regole(), book: 'yes', now: NOW, maxWaitMs: H }).trigger === 'max-wait');
}


// ── IL GATE `book-non-databile` SUL PERCORSO DI QUESTO FILE ─────────────────────────────────────────
// La regola (`c919981`) e' provata a fondo in `bid-databile.test.js`. Qui si verifica l'altra meta',
// che quel file non puo' vedere: che il gate stia A MONTE di QUESTO percorso. Ogni file di questa
// famiglia entra in `decideClose` da una porta diversa, e la posizione del gate rispetto a ciascuna
// e' proprio cio' che la sua correzione ha stabilito. Alimentare la fixture senza difendere il gate
// sarebbe stato ammorbidire il test, non ripararlo.
{
  const cieco = decideClose({ position: pos, restingOrders: [], rules: regole(0.50, 2.25, 0.495, { midAgeSec: undefined }), book: 'yes', now: NOW });
  ok('gate: senza eta del book non si vende', cieco.action === 'skip' && cieco.gate === 'book-non-databile', `(${cieco.action}/${cieco.gate})`);
  const vecchio = decideClose({ position: pos, restingOrders: [], rules: regole(0.50, 2.25, 0.495, { midAgeSec: 100000 }), book: 'yes', now: NOW });
  ok('gate: con un book fermo da ore non si vende', vecchio.action === 'skip' && vecchio.gate === 'book-vecchio', `(${vecchio.gate})`);
  // ⚑ IL CONTROLLO, senza il quale il rifiuto qui sopra non proverebbe niente: con lo STESSO scenario e
  //   un book databile la vendita c'e' davvero. Un'asserzione «non e successo X» su uno scenario in cui
  //   X non succede comunque e' verde per sempre e non difende nulla.
  const conEta = decideClose({ position: pos, restingOrders: [], rules: regole(), book: 'yes', now: NOW });
  ok('  CONTROLLO: con un book databile il gate non morde',
    conEta.gate !== 'book-non-databile' && conEta.gate !== 'book-vecchio', `(${conEta.action}/${conEta.gate || '-'})`);
  // ⚑ IL CONTROLLO: senza, «nessuna vendita» sarebbe vero anche se non ci fosse MAI una vendita.
  const sano = decideClose({ position: pos, restingOrders: [], rules: regole(), book: 'yes', now: NOW });
  ok('  CONTROLLO: con l eta nessuno dei due gate morde',
    sano.gate !== 'book-non-databile' && sano.gate !== 'book-vecchio', `(${sano.action}/${sano.gate || '-'})`);
}

console.log('\n── senza un bid leggibile non si chiude a un prezzo inventato');
{
  const r = regole(0.42, 2.25, 0.415);
  r.books.yes.bestBid = null;
  const resting = [{ orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H }];
  const d = decideClose({ position: pos, restingOrders: resting, rules: r, book: 'yes', now: NOW });
  ok('si salta con un gate che si nomina', d.action === 'skip' && d.gate === 'no-market-bid', `${d.action}/${d.gate}`);
}

(async () => {
  console.log('\n── IL CICLO: prima cancella, poi vende');
  {
    const cancellati = [], piazzati = [];
    const res = await runAutoCloseCycle({
      marketIds: ['0x' + 'c1'.repeat(32)],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => regole(0.42, 2.25, 0.415),
      listOrders: async () => ({ ok: true, simulated: false, orders: [
        { orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H },
      ] }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: 'ty', size: 50, avgPrice: 0.50 }] }),
      placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: false }; },
      cancelOrder: async (s) => { cancellati.push(s.orderId); return { ok: true }; },
      audit: () => {},
      isEnabled: () => ({ enabled: true, reason: null }),
      now: () => NOW,
    });
    const a = (res.actions || []).find((x) => x.action === 'close-at-market');
    ok('l azione compare nel ciclo', !!a, a ? String(a.trigger) : 'assente');
    ok('  l uscita e stata CANCELLATA', cancellati.includes('e1'), cancellati.join() || 'nessuna');
    ok('  e POI e stata piazzata la vendita a mercato', piazzati.length === 1 && piazzati[0].side === 'SELL', JSON.stringify(piazzati[0] || {}).slice(0, 70));
    ok('  al miglior bid', piazzati[0] && piazzati[0].price === 0.415, String(piazzati[0] && piazzati[0].price));
  }

  console.log('\n── se la cancellazione FALLISCE non si vende (mai due vendite sulla stessa posizione)');
  {
    const piazzati = [];
    const res = await runAutoCloseCycle({
      marketIds: ['0x' + 'c2'.repeat(32)],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => regole(0.42, 2.25, 0.415),
      listOrders: async () => ({ ok: true, simulated: false, orders: [
        { orderId: 'e1', tokenId: 'ty', side: 'SELL', price: 0.51, sizeRemaining: 50, createdMs: NOW - 2 * H },
      ] }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: 'ty', size: 50, avgPrice: 0.50 }] }),
      placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: false }; },
      cancelOrder: async () => ({ ok: false, reason: 'venue irraggiungibile (finto)' }),
      audit: () => {},
      isEnabled: () => ({ enabled: true, reason: null }),
      now: () => NOW,
    });
    const a = (res.actions || []).find((x) => x.action === 'close-at-market');
    ok('l azione risulta fallita', a && a.ok === false && a.gate === 'cancel-failed', a ? String(a.gate) : 'assente');
    ok('  e NESSUNA vendita e partita', piazzati.length === 0,
      'vendere con l uscita ancora viva significherebbe due ordini di vendita sulla stessa posizione');
  }

  console.log('\n── LA VECCHIA SOGLIA FISSA NON SOPRAVVIVE DA NESSUNA PARTE');
  {
    const ep = require('./exit-plan');
    ok('exit-plan non esporta MAX_ADVERSE_PCT', typeof ep.MAX_ADVERSE_PCT === 'undefined');
    const ac = require('./auto-close');
    ok('auto-close non esporta closeTargetPrice', typeof ac.closeTargetPrice === 'undefined');
    ok('  ne closeFloorPrice', typeof ac.closeFloorPrice === 'undefined');
    const src = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, 'exit-plan.js'), 'utf8');
    ok('nessun «pavimento» residuo nel codice attivo', !/atFloor|riskFloor|MAX_ADVERSE/.test(src));
    ok('e il trigger a banda e l unico giudice di un uscita a riposo', /decideExit\(/.test(src));
  }

  console.log(`\ntrigger a banda nel ciclo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
