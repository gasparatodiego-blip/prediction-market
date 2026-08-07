#!/usr/bin/env node
'use strict';
// UN ORDINE NOSTRO NON È UN CONCORRENTE DI SE STESSO.
//
// ═══ IL GUASTO ══════════════════════════════════════════════════════════════════════════════════════
// La regola «mai primi sul libro» mette il nostro ordine un tick dietro il miglior concorrente. Per
// rispondere a «chi è il miglior concorrente» bisogna prima TOGLIERE dal libro la nostra presenza —
// altrimenti, dal secondo ordine in poi, il concorrente da battere siamo noi.
//
// Il motore di decisione (auto-reprice) lo faceva già: calcola `nostriSulLato` e lo passa sia alla
// decisione sia al piazzamento. Tutti gli altri percorsi che dichiarano `inCoda: true` — il pannello
// manuale, le due gambe del piano, bulk-allocate, l'uscita maker — passavano una lista VUOTA.
//
// Con la lista vuota il conto è questo: il primo ordine si accoda al concorrente vero, il secondo si
// accoda AL PRIMO, il terzo al secondo. Un tick per ordine, nella direzione sbagliata, fino al bordo
// della banda che paga — e ogni singolo ordine, preso da solo, sembra corretto.
//
// ═══ LA CORREZIONE ══════════════════════════════════════════════════════════════════════════════════
// Se il chiamante non li passa, si LEGGONO dal venue e si tengono solo quelli del lato che si sta
// quotando, riconosciuto per token id e non per etichetta. Se la lettura fallisce si prosegue con la
// lista vuota — la regola «mai primi» è una politica di prezzo, non un gate di sicurezza, e un suo
// dato mancante non deve poter impedire un ordine che l'operatore ha chiesto — ma il referto lo dice.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { placeManualOrder } = require('./manual-order');
const { prezzoInCoda } = require('./prezzo-in-coda');
const MKT = '0x' + '7c'.repeat(32);
const ROOT = path.resolve(__dirname, '..', '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocomp-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: Date.now() } } }));

  // Il libro: il concorrente vero è a 77¢; a 79¢ e 78¢ ci siamo NOI.
  const libro = {
    yes: { bids: [{ price: 0.79, size: 20 }, { price: 0.78, size: 20 }, { price: 0.77, size: 60 }],
      asks: [{ price: 0.85, size: 40 }] },
    no: { bids: [], asks: [] },
  };
  const nostriAlVenue = [
    { orderId: 'A', tokenId: 'tok-yes', price: 0.79, size: 20, sizeRemaining: 20 },
    { orderId: 'B', tokenId: 'tok-yes', price: 0.78, size: 20, sizeRemaining: 20 },
    { orderId: 'C', tokenId: 'tok-no', price: 0.20, size: 50, sizeRemaining: 50 },   // altro lato
  ];

  const mondo = (extra = {}) => ({
    norm: { markets: [{
      marketId: MKT, title: 'M', midpoint: 0.78, tickSize: 0.01, maxSpread: 4.5, minSize: 20,
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', negRisk: false, updatedAt: new Date().toISOString(),
    }] },
    books: { markets: { [MKT]: {
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', mid: 0.78, minSize: 20, maxSpread: 4.5, ageMs: 1_000,
      yes: { live: true, ageMs: 1_000, bestBid: 0.79, bestAsk: 0.85, adjustedMid: 0.78, levels: libro.yes },
      no: { live: true, ageMs: 1_000, bestBid: 0.15, bestAsk: 0.22, adjustedMid: 0.185, levels: libro.no },
    } } },
    manualDeps: { stateFile },
    resolveDepth: () => libro,
    env: { MANUAL_ORDER_PLACEMENT: 'dry-run' },
    ...extra,
  });

  console.log('\n══ 1 · IL CONTO, PRIMA E DOPO — sullo stesso percorso di piazzamento');
  {
    // Il confronto si fa facendo girare il piazzamento vero due volte, non chiamando la funzione di
    // prezzo con regole finte: è il percorso completo quello che era rotto, e le regole vere (banda,
    // tick, scoringMid) le costruisce lui dal book iniettato.
    const comeUnaVolta = await placeManualOrder(
      { marketId: MKT, book: 'yes', side: 'BUY', price: 0.78, size: 20, inCoda: true, ownOrders: [] },
      mondo());
    const adesso = await placeManualOrder(
      { marketId: MKT, book: 'yes', side: 'BUY', price: 0.78, size: 20, inCoda: true },
      mondo({ resolveOwnOrders: async () => ({ ok: true, orders: nostriAlVenue }) }));

    ok('con la lista vuota il «concorrente» è il nostro stesso ordine a 79¢',
      comeUnaVolta.inCoda.bestOther === 0.79, `bestOther ${comeUnaVolta.inCoda.bestOther}`);
    ok('leggendoli, il concorrente vero è a 77¢',
      adesso.inCoda.bestOther === 0.77, `bestOther ${adesso.inCoda.bestOther}`);
    ok('  e i due prezzi proposti sono diversi: è la misura del difetto',
      comeUnaVolta.price !== adesso.price,
      `${(comeUnaVolta.price * 100).toFixed(0)}¢ contro ${(adesso.price * 100).toFixed(0)}¢`);
    // Due nostri ordini davanti ⇒ due tick di scarto, ed è proprio la forma del difetto: la distanza
    // cresce di un tick per ogni ordine che abbiamo già lì, nella direzione sbagliata.
    ok('  e lo scarto è di un tick PER OGNI nostro ordine davanti',
      +(comeUnaVolta.price - adesso.price).toFixed(4) === 0.02,
      `2 nostri ordini ⇒ 2 tick (${((comeUnaVolta.price - adesso.price) * 100).toFixed(0)}¢)`);
  }

  console.log('\n══ 2 · IL PANNELLO LI LEGGE DA SOLO, SE NESSUNO GLIELI PASSA');
  {
    let chiesto = null;
    const r = await placeManualOrder(
      { marketId: MKT, book: 'yes', side: 'BUY', price: 0.78, size: 20, inCoda: true },
      mondo({ resolveOwnOrders: async (id) => { chiesto = id; return { ok: true, orders: nostriAlVenue }; } }));
    ok('ha chiesto i nostri ordini al venue', chiesto === MKT, String(chiesto));
    ok('ne ha tenuti due (il lato yes), non tre', r.inCoda && r.inCoda.ownOrders.conteggio === 2,
      JSON.stringify(r.inCoda && r.inCoda.ownOrders));
    ok('  e il terzo era sull\'altro lato, riconosciuto per token id',
      r.inCoda.ownOrders.origine.includes('letti dal venue'), r.inCoda.ownOrders.origine);
    ok('il concorrente considerato è quello VERO (77¢)', r.inCoda.bestOther === 0.77, `bestOther ${r.inCoda.bestOther}`);
    ok('  e NON il nostro 79¢', r.inCoda.bestOther !== 0.79);
  }

  console.log('\n══ 3 · CHI LI PASSA CONTINUA A DECIDERE LUI');
  {
    let chiamato = false;
    const r = await placeManualOrder(
      { marketId: MKT, book: 'yes', side: 'BUY', price: 0.78, size: 20, inCoda: true,
        ownOrders: [{ orderId: 'A', price: 0.79, size: 20 }, { orderId: 'B', price: 0.78, size: 20 }] },
      mondo({ resolveOwnOrders: async () => { chiamato = true; return { ok: true, orders: [] }; } }));
    ok('con ownOrders esplicito NON si interroga il venue', chiamato === false,
      'il watcher di riprezzo li ha già, e una lettura in più sarebbe una chiamata sprecata');
    ok('  e il referto lo dichiara', r.inCoda.ownOrders.origine === 'passati dal chiamante', r.inCoda.ownOrders.origine);
    ok('  con lo stesso concorrente vero', r.inCoda.bestOther === 0.77);
  }

  console.log('\n══ 4 · UNA LETTURA CHE FALLISCE NON BLOCCA IL PIAZZAMENTO — ma si vede');
  {
    const r = await placeManualOrder(
      { marketId: MKT, book: 'yes', side: 'BUY', price: 0.78, size: 20, inCoda: true },
      mondo({ resolveOwnOrders: async () => { throw new Error('venue irraggiungibile'); } }));
    ok('il piazzamento prosegue', r.gate !== 'own-orders-unreadable', `gate: ${r.gate || 'nessuno'}`);
    ok('  la coda è calcolata senza sottrarli', r.inCoda.ownOrders.conteggio === 0);
    ok('  e il referto dice perché', /NON letti.*venue irraggiungibile/.test(r.inCoda.ownOrders.origine),
      r.inCoda.ownOrders.origine);
    ok('  (è una politica di prezzo, non un gate di sicurezza)', r.sent === false, 'dry-run, niente al venue');
  }

  console.log('\n══ 5 · IL MOTORE DI DECISIONE RESTA COLLEGATO — su ENTRAMBI i rami');
  {
    // L'asserzione di prima cercava la forma testuale `ownOrders: owned.filter(...)` scritta dentro la
    // chiamata. Il codice nel frattempo l'ha estratta in `nostriSulLato` — stesso insieme, calcolato
    // una volta sola e passato a decisione E piazzamento, che è proprio la proprietà che serve.
    // Si verifica quella, invece della sua vecchia grafia.
    const ar = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'auto-reprice.js'), 'utf8');
    ok('l\'insieme è calcolato una volta sola, per lato',
      /const nostriSulLato = owned\.filter\(\(x\) => x\.book === order\.book\);/.test(ar));
    const usi = (ar.match(/ownOrders: nostriSulLato/g) || []).length;
    ok('  ed è passato sia alla decisione sia al piazzamento', usi >= 2, `${usi} usi`);
    ok('  e la profondità è iniettata nella decisione', /resolveDepth: deps\.resolveDepth/.test(ar));
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nauto-competizione: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
