#!/usr/bin/env node
'use strict';
// IL RIMPIAZZO E' COLLEGATO, NON SOLO SCRITTO.
//
// Questo file esiste per un difetto vero, trovato il 5 agosto 2026 e introdotto il giorno prima:
// `decideRimpiazzo` era scritto, documentato e coperto da cinque scenari di test — e NON LO CHIAMAVA
// NESSUNO. `deps.rimpiazzaGamba` non era iniettato da nessuna parte, quindi la guardia
// `typeof deps.rimpiazzaGamba === 'function'` in auto-close era permanentemente falsa.
//
// I test di allora passavano tutti. Provavano la DECISIONE e mai il CABLAGGIO, e fra le due c'è
// esattamente lo spazio in cui un modulo può vivere per giorni senza essere mai eseguito.
//
// C'era un secondo difetto nella stessa riga: la chiamata passava `d.offsetCents`, che `decideClose`
// non ha mai restituito. Anche con la dipendenza iniettata sarebbe arrivato `null`, e `planQuotes`
// avrebbe rifiutato con «offset non valido» — un rimpiazzo che non si sarebbe mai piazzato.
//
// Quindi qui non si prova che la decisione sia giusta (lo fa tre-fasi.test.js): si prova che il
// percorso ci ARRIVI.

const fs = require('fs');
const path = require('path');
const { runAutoCloseCycle } = require('./auto-close');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const M = '0x' + 'a1'.repeat(32);

(async () => {

  console.log('\n══ IL CABLAGGIO ESISTE NEL SORGENTE');
  {
    const ag = fs.readFileSync(path.join(ROOT, 'agents', 'agent40-manual-reprice.js'), 'utf8');
    ok('agent40 INIETTA rimpiazzaGamba', /rimpiazzaGamba: async \(\{/.test(ag),
      'senza questa riga la decisione esiste ma non viene mai presa');
    ok('  e chiama davvero decideRimpiazzo', /decideRimpiazzo\(\{/.test(ag));
    ok('  risolvendo l offset dal registro per mercato', /resolveOffsetFor\(\{ marketId, book/.test(ag));
    ok('  e il tetto dal piano di allocazione corrente', /readAllocatedCapital\(marketId\)/.test(ag));
    ok('  e piazza con la regola della coda accesa', /inCoda: true, source: AUTO_CLOSE_SOURCE/.test(ag));

    const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    ok('auto-close NON passa piu offsetCents', !/offsetCents: d\.offsetCents/.test(ac),
      'decideClose non lo restituisce: passarlo significava mandare null');
    ok('  ma passa i due nozionali che il tetto deve contare',
      /posizioneUsd: Number\(pos\.avgPrice\) \* Number\(pos\.size\)/.test(ac)
      && /uscitaUsd: Number\(d\.price\) \* Number\(d\.size\)/.test(ac));
  }

  console.log('\n══ E IL CICLO VERO CI ARRIVA (la prova che i test di prima non facevano)');
  {
    const visti = [];
    const piazzati = [];
    const r = await runAutoCloseCycle({
      marketIds: [M],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true, reason: null }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({
        readable: true, marketId: M, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
        midSource: 'live-book', midAgeSec: 3,  // ⚠ book DATABILE: dal 19/08 `decideClose` rifiuta un bid senza eta (c919981). Il gate e difeso in coda al file, non aggirato.
        tokenId: '111', tokenIdNo: '222',
        books: { yes: { scoringMid: 0.43, bestBid: 0.42, bestAsk: 0.44 }, no: { scoringMid: 0.57, bestBid: 0.56, bestAsk: 0.58 } },
      }),
      listOrders: async () => ({ ok: true, orders: [] }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: '111', size: 100, avgPrice: 0.42 }] }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: false, orderId: 'sim' }; },
      rimpiazzaGamba: async (a) => { visti.push(a); return { action: 'rimpiazza', ok: true, price: 0.42, size: 95.2, reason: 'test' }; },
      audit: () => {},
    });

    ok('l uscita e stata piazzata', piazzati.length === 1 && piazzati[0].side === 'SELL', JSON.stringify(piazzati[0] || null));
    // ⚠⚠ ASSERZIONE RISCRITTA IL 24 AGOSTO 2026, NON AMMORBIDITA E NON CANCELLATA.
    // Diceva «con la regola della coda accesa anche su di essa», ed era la codifica del difetto: `inCoda` manda il prezzo a
    // `prezzo-in-coda`, che su `0x4d79d306` ha riportato la decisione della scala da 0.495 a **0.288**
    // — 8,3 volte la concessione che §7 consente. Per decisione dell'operatore un ordine di USCITA
    // ora NON e' `inCoda` per costruzione (`auto-close.chiudendo` lo toglie all'intera classe), e la
    // proprieta' da difendere e' piu' forte: non «il prezzo si sposta secondo la coda» ma «il prezzo
    // non si sposta affatto». Si verifica su tutte e tre le facce: marcato, non in coda, prezzo intatto.
    ok('  e\' marcato USCITA: il prezzo deciso dalla scala e\' vincolante',
      piazzati[0] && piazzati[0].uscita === true, JSON.stringify({ uscita: piazzati[0] && piazzati[0].uscita, inCoda: piazzati[0] && piazzati[0].inCoda }));
    ok('  e NON e\' `inCoda` per costruzione — la toglie `chiudendo`, non il chiamante',
      piazzati[0] && piazzati[0].inCoda === undefined, String(piazzati[0] && piazzati[0].inCoda));
    ok('  e il prezzo che parte E\' quello deciso, non uno riscritto',
      piazzati[0] && Number.isFinite(piazzati[0].prezzoDeciso) && Math.abs(piazzati[0].prezzoDeciso - piazzati[0].price) < 1e-9,
      piazzati[0] && `deciso ${piazzati[0].prezzoDeciso} vs partito ${piazzati[0].price}`);
    ok('IL RIMPIAZZO E STATO INVOCATO', visti.length === 1, `${visti.length} chiamate`);
    ok('  senza offsetCents fra gli argomenti (lo risolve chi rimpiazza)', visti[0] && visti[0].offsetCents === undefined);
    ok('  con la posizione appena aperta: $42 = 100 x 0.42', visti[0] && Math.abs(visti[0].posizioneUsd - 42) < 0.01, String(visti[0] && visti[0].posizioneUsd));
    ok('  e con l uscita appena messa a riposo', visti[0] && visti[0].uscitaUsd > 0, String(visti[0] && visti[0].uscitaUsd));
    ok('  e il referto registra l azione «rimpiazzo»', r.actions.some((x) => x.action === 'rimpiazzo'),
      JSON.stringify(r.actions.map((x) => x.action)));
  }

  console.log('\n══ SENZA LA DIPENDENZA IL CICLO NON ESPLODE, MA NON RIMPIAZZA (lo stato di prima)');
  {
    const r = await runAutoCloseCycle({
      marketIds: [M],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true, reason: null }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({
        readable: true, marketId: M, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
        midSource: 'live-book', midAgeSec: 3,  // ⚠ book DATABILE, come nel blocco qui sopra (c919981)
        tokenId: '111', tokenIdNo: '222',
        books: { yes: { scoringMid: 0.43, bestBid: 0.42, bestAsk: 0.44 }, no: { scoringMid: 0.57, bestBid: 0.56, bestAsk: 0.58 } },
      }),
      listOrders: async () => ({ ok: true, orders: [] }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: '111', size: 100, avgPrice: 0.42 }] }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      placeOrder: async () => ({ ok: true, sent: false, orderId: 'sim' }),
      audit: () => {},
    });
    ok('la chiusura avviene comunque', r.actions.some((x) => x.action === 'close'));
    ok('  ma nessun rimpiazzo — ed e ESATTAMENTE cio che succedeva in produzione',
      !r.actions.some((x) => x.action === 'rimpiazzo'));
  }


// ── IL GATE `book-non-databile` SUL PERCORSO DI QUESTO FILE ─────────────────────────────────────────
// La regola (`c919981`) e' provata a fondo in `bid-databile.test.js`. Qui si verifica l'altra meta',
// che quel file non puo' vedere: che il gate stia A MONTE di QUESTO percorso. Ogni file di questa
// famiglia entra in `decideClose` da una porta diversa, e la posizione del gate rispetto a ciascuna
// e' proprio cio' che la sua correzione ha stabilito. Alimentare la fixture senza difendere il gate
// sarebbe stato ammorbidire il test, non ripararlo.
// ⚠ Si asserisce «nessuna VENDITA», non «nessun ordine»: il gate ferma chi vende, non chi compra la
//   gamba mancante — il completamento della coppia e il merge restano validi a libro fermo (R8).
{
  const inviati = [];
  await runAutoCloseCycle({
    marketIds: [M],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true, reason: null }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, marketId: M, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
      midSource: 'live-book',   // ⚑ eta' ASSENTE, di proposito
      tokenId: '111', tokenIdNo: '222',
      books: { yes: { scoringMid: 0.43, bestBid: 0.42, bestAsk: 0.44 }, no: { scoringMid: 0.57, bestBid: 0.56, bestAsk: 0.58 } },
    }),
    listOrders: async () => ({ ok: true, orders: [] }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: '111', size: 100, avgPrice: 0.42 }] }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    placeOrder: async (spec) => { inviati.push(spec); return { ok: true, sent: true, orderId: 'x' }; },
    audit: () => {},
  });
  const sell = inviati.filter((x) => x && x.side === 'SELL');
  ok('gate: senza eta del book nessuna vendita', sell.length === 0, `${sell.length} SELL su ${inviati.length}`);
  // ⚑ IL CONTROLLO, senza il quale il rifiuto qui sopra non proverebbe niente: con lo STESSO scenario e
  //   un book databile la vendita c'e' davvero. Un'asserzione «non e successo X» su uno scenario in cui
  //   X non succede comunque e' verde per sempre e non difende nulla.
  // Misurato scrivendo questo blocco: con `midAgeSec: 3` lo stesso scenario manda `SELL@0.43`.
  const sani = [];
  await runAutoCloseCycle({
    marketIds: [M],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true, reason: null }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, marketId: M, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
      midSource: 'live-book', midAgeSec: 3,
      tokenId: '111', tokenIdNo: '222',
      books: { yes: { scoringMid: 0.43, bestBid: 0.42, bestAsk: 0.44 }, no: { scoringMid: 0.57, bestBid: 0.56, bestAsk: 0.58 } },
    }),
    listOrders: async () => ({ ok: true, orders: [] }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: '111', size: 100, avgPrice: 0.42 }] }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    placeOrder: async (spec) => { sani.push(spec); return { ok: true, sent: true, orderId: 'x' }; },
    audit: () => {},
  });
  ok('  CONTROLLO: con un book databile la vendita parte',
    sani.some((x) => x && x.side === 'SELL'), JSON.stringify(sani.map((x) => x && x.side)));
  // ⚑ IL CONTROLLO: senza, «nessuna vendita» sarebbe vero anche se non ci fosse MAI una vendita.
  const conEta = [];
  await runAutoCloseCycle({
    marketIds: [M],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true, reason: null }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, marketId: M, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
      midSource: 'live-book', midAgeSec: 3,
      tokenId: '111', tokenIdNo: '222',
      books: { yes: { scoringMid: 0.43, bestBid: 0.42, bestAsk: 0.44 }, no: { scoringMid: 0.57, bestBid: 0.56, bestAsk: 0.58 } },
    }),
    listOrders: async () => ({ ok: true, orders: [] }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: '111', size: 100, avgPrice: 0.42 }] }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    placeOrder: async (spec) => { conEta.push(spec); return { ok: true, sent: true, orderId: 'x' }; },
    audit: () => {},
  });
  ok('  CONTROLLO: con l eta la vendita c e', conEta.some((x) => x && x.side === 'SELL'),
    JSON.stringify(conEta.map((x) => x && x.side)));
}

  console.log(`\nrimpiazzo collegato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
