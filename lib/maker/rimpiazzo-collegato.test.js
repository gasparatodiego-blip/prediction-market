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
    ok('  con la regola della coda accesa anche su di essa', piazzati[0] && piazzati[0].inCoda === true);
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

  console.log(`\nrimpiazzo collegato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
