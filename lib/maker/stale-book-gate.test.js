#!/usr/bin/env node
'use strict';
// IL GATE CHE IMPEDISCE DI PIAZZARE SU UN PREZZO MORTO.
//
// Il pannello promette all'operatore un prezzo live: chiede una sottoscrizione temporanea al book e la
// tiene finché resta aperto. Fra il momento in cui la schermata dice «si può» e il momento in cui
// l'ordine parte c'è del tempo, e la sottoscrizione può cadere proprio lì in mezzo. Chi promette lo
// dichiara in `requireFreshBookMs`, e questo gate lo tiene alla promessa.
//
// NESSUN ORDINE VIENE PIAZZATO QUI. Ogni caso si ferma a un rifiuto — è esattamente ciò che si verifica —
// e il caso che NON deve essere rifiutato viene fermato dal gate immediatamente successivo, con deps
// iniettate che rendono impossibile raggiungere l'adattatore di piazzamento.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { placeManualOrder } = require('./manual-order');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'ab'.repeat(32);

(async () => {
  // ── IL MONDO IN CUI GIRA IL TEST ────────────────────────────────────────────────────────────────
  // Iniettato per intero, mai toccando data/ o /tmp reali:
  //   · manualDeps.stateFile → un file temporaneo che dichiara il mercato in gestione manuale, cosi'
  //     GATE 1 (proprieta') si apre e si arriva davvero al gate in prova;
  //   · deps.books → uno snapshot del book live sintetico, in cui SIAMO NOI a decidere `ageMs`;
  //   · deps.norm  → le regole di venue, cosi' GATE 2 non muore su «regole non leggibili».
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalegate-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: Date.now() } } }));

  const norm = { markets: [{
    marketId: MKT, title: 'Mercato in prova', midpoint: 0.5, tickSize: 0.01,
    maxSpread: 4.5, minSize: 50, tokenId: 'tok-yes', tokenIdNo: 'tok-no', negRisk: false,
    updatedAt: new Date().toISOString(),
  }] };

  /** Uno snapshot del book live con l'eta' che scegliamo. `books:null` ⇒ il mid cade sulla riga di board. */
  const world = ({ inLiveBook, ageMs }) => ({
    norm,
    books: inLiveBook ? { markets: { [MKT]: {
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', mid: 0.5, minSize: 50, maxSpread: 4.5, ageMs,
      yes: { live: true, ageMs, bestBid: 0.49, bestAsk: 0.51, adjustedMid: 0.5 },
      no: { live: true, ageMs, bestBid: 0.49, bestAsk: 0.51, adjustedMid: 0.5 },
    } } } : { markets: {} },
    manualDeps: { stateFile },
    env: { MANUAL_ORDER_PLACEMENT: 'dry-run' },
  });

  const run = (opts, extra = {}) => placeManualOrder(
    { marketId: MKT, book: 'yes', price: 0.5, size: 50, ...extra },
    world(opts),
  );

  console.log('\n── il prezzo non viene dal book live');
  {
    const r = await run({ inLiveBook: false }, { requireFreshBookMs: 30_000 });
    ok('RIFIUTATO', r.ok === false && r.sent === false);
    ok('  con il gate giusto', r.gate === 'stale-book', String(r.gate));
    ok('  e il motivo nomina la fonte vera', /board-row|manual-catalog|fonte ignota/.test(r.reason || ''), (r.reason || '').slice(0, 80));
    ok('  e dice cosa fare', /riapri il pannello/i.test(r.reason || ''));
  }

  console.log('\n── il book live c\'e ma e fermo da troppo');
  {
    const r = await run({ inLiveBook: true, ageMs: 95_000 }, { requireFreshBookMs: 30_000 });
    ok('RIFIUTATO', r.ok === false && r.sent === false);
    ok('  con il gate giusto', r.gate === 'stale-book', String(r.gate));
    ok('  e dice quanti secondi', /95s/.test(r.reason || ''), (r.reason || '').slice(0, 96));
    ok('  e nomina la soglia promessa', /30s/.test(r.reason || ''));
  }

  console.log('\n── il book live e fresco: il gate LASCIA PASSARE');
  {
    const r = await run({ inLiveBook: true, ageMs: 3_000 }, { requireFreshBookMs: 30_000 });
    // Passa questo gate e viene fermato da uno successivo: il punto e che il motivo NON e piu
    // stale-book. Un gate che rifiuta anche un book fresco sarebbe inutilizzabile.
    ok('NON e piu stale-book', r.gate !== 'stale-book', `fermato da: ${r.gate || 'nessun gate'}`);
    ok('  e nulla e stato inviato al venue', r.sent === false);
  }

  console.log('\n── chi non promette niente non viene bloccato');
  {
    const r = await run({ inLiveBook: false }, {});
    ok('nessun requireFreshBookMs ⇒ nessun blocco di freschezza', r.gate !== 'stale-book', `fermato da: ${r.gate || 'nessun gate'}`);
    ok('  e nulla e stato inviato al venue', r.sent === false);
  }

  console.log('\n── la soglia dichiarata e quella che vale');
  {
    const stretta = await run({ inLiveBook: true, ageMs: 45_000 }, { requireFreshBookMs: 30_000 });
    ok('45s contro una promessa di 30s ⇒ rifiuto', stretta.gate === 'stale-book', String(stretta.gate));
    const larga = await run({ inLiveBook: true, ageMs: 45_000 }, { requireFreshBookMs: 60_000 });
    ok('45s contro una promessa di 60s ⇒ passa il gate', larga.gate !== 'stale-book', `fermato da: ${larga.gate || 'nessun gate'}`);
  }

  console.log(`\nstale-book gate: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
