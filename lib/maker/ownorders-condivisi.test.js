'use strict';
// lib/maker/ownorders-condivisi.test.js — I NOSTRI ORDINI SI ESCLUDONO UNA VOLTA SOLA,
// E I DUE PERCORSI VEDONO LO STESSO «MIGLIOR CONCORRENTE».
//
// Il difetto: la SOTTRAZIONE dei nostri ordini dal book era già una funzione sola
// (`top-of-book.othersLadder`), ma la SELEZIONE — «quali righe sono nostre su questo lato» — era
// scritta a mano in due punti, uno per book e uno per tokenId. Due filtri sullo stesso concetto
// producono due book altrui diversi fra chi DECIDE il prezzo e chi lo PIAZZA.
//
// E il pannello non mandava niente, quindi il server aveva una sola fonte: una lettura di rete che,
// quando fallisce, lasciava la lista vuota — cioè i nostri ordini scambiati per concorrenza.

const fs = require('fs');
const path = require('path');
const NO = require('./nostri-ordini');
const { othersLadder, bestOtherBid } = require('./top-of-book');
const PC = require('./prezzo-in-coda');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('── 1 · IL TEST CHIESTO: DUE ORDINI PROPRI E UNO DI TERZI');
{
  // Il libro: 42¢ e 41¢ sono NOSTRI, 40¢ è di terzi. Il «miglior concorrente» deve essere 40¢.
  const TOK = 'tok-yes';
  const tick = 0.01;
  const bids = [
    { price: 0.42, size: 100 },   // nostro
    { price: 0.41, size: 50 },    // nostro
    { price: 0.40, size: 300 },   // di TERZI
  ];
  const nostriGrezzi = [
    { orderId: 'mio-1', tokenId: TOK, book: 'yes', side: 'BUY', price: 0.42, size: 100 },
    { orderId: 'mio-2', tokenId: TOK, book: 'yes', side: 'BUY', price: 0.41, size: 50 },
  ];

  // ── PERCORSO DI DECISIONE: seleziona per BOOK (è ciò che `auto-reprice` ha in mano) ────────────
  const perDecisione = NO.nostriSulLato({ orders: nostriGrezzi, book: 'yes' }).ordini;
  // ── PERCORSO DI PIAZZAMENTO: seleziona per TOKEN ID (è ciò che `manual-order` ha in mano) ──────
  const perPiazzamento = NO.nostriSulLato({ orders: nostriGrezzi, tokenId: TOK }).ordini;

  ok('le due selezioni prendono le stesse due righe',
    perDecisione.length === 2 && perPiazzamento.length === 2);
  ok('  e sono identiche riga per riga',
    JSON.stringify(perDecisione) === JSON.stringify(perPiazzamento));

  const boDecisione = bestOtherBid({ levels: bids, ownOrders: perDecisione, tick });
  const boPiazzamento = bestOtherBid({ levels: bids, ownOrders: perPiazzamento, tick });
  ok('IL MIGLIOR CONCORRENTE È L\'ORDINE DI TERZI — percorso di DECISIONE',
    boDecisione.readable === true && boDecisione.price === 0.40, String(boDecisione.price));
  ok('IL MIGLIOR CONCORRENTE È L\'ORDINE DI TERZI — percorso di PIAZZAMENTO',
    boPiazzamento.readable === true && boPiazzamento.price === 0.40, String(boPiazzamento.price));
  ok('  e i due percorsi danno lo STESSO numero', boDecisione.price === boPiazzamento.price);

  // La controprova: SENZA la sottrazione, il «concorrente» saremmo noi.
  const senza = bestOtherBid({ levels: bids, ownOrders: [], tick });
  ok('senza sottrarre i nostri, il «concorrente» sarebbe il NOSTRO 42¢ — il difetto',
    senza.price === 0.42, String(senza.price));
  ok('  cioè il sistema si accoderebbe a se stesso', senza.price !== boDecisione.price);

  // E la scala altrui vista dai due percorsi è la stessa scala, non solo la stessa testa.
  const lD = othersLadder({ levels: bids, ownOrders: perDecisione, tick });
  const lP = othersLadder({ levels: bids, ownOrders: perPiazzamento, tick });
  ok('anche la SCALA altrui è identica fra i due percorsi',
    JSON.stringify(lD.levels) === JSON.stringify(lP.levels), JSON.stringify(lD.levels));
  ok('  e contiene solo il livello di terzi, per la size di terzi',
    lD.levels.length === 1 && lD.levels[0].price === 0.40 && lD.levels[0].size === 300);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2 · UN LIVELLO CONDIVISO CON UN TERZO NON SPARISCE, SI RIDUCE');
{
  // 40¢ ha 300 share di cui 100 nostre: resta un concorrente da 200, non zero.
  const bids = [{ price: 0.40, size: 300 }];
  const nostri = NO.nostriSulLato({ orders: [{ orderId: 'm', tokenId: 'T', price: 0.40, size: 100 }], tokenId: 'T' }).ordini;
  const l = othersLadder({ levels: bids, ownOrders: nostri, tick: 0.01 });
  ok('il livello resta, con la sola parte altrui', l.levels.length === 1 && l.levels[0].size === 200);
  ok('  e il miglior concorrente è ancora 40¢', bestOtherBid({ levels: bids, ownOrders: nostri, tick: 0.01 }).price === 0.40);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3 · LA SELEZIONE È UNA SOLA FUNZIONE, E I DUE PERCORSI LA CHIAMANO');
{
  const srcAR = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  const srcMO = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('il percorso di DECISIONE importa la funzione condivisa', srcAR.includes("require('./nostri-ordini')"));
  // La stringa vecchia compare ancora in un COMMENTO, che spiega cosa c'era prima: si verifica che
  // non sia più un'assegnazione attiva, non che la parola sia sparita dal file.
  ok('  e non filtra più a mano per book',
    !/const nostriSulLato = owned\.filter/.test(srcAR)
    && /const nostriSulLato = nostriOrdiniSulLato\(/.test(srcAR));
  ok('il percorso di PIAZZAMENTO importa la STESSA funzione', srcMO.includes("require('./nostri-ordini')"));
  ok('  e non filtra più a mano per tokenId',
    !srcMO.includes("String(o.tokenId) === String(tokenDelLato))\n            .map("));
  ok('la SOTTRAZIONE resta dove è sempre stata, e non è stata duplicata',
    fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .filter((f) => /function othersLadder/.test(fs.readFileSync(path.join(__dirname, f), 'utf8'))).length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4 · IL SERVER NON SI FIDA DEL CLIENT, E NON NE FA A MENO');
{
  const srcMO = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('la lettura dal venue avviene SEMPRE, non solo quando il client tace',
    srcMO.includes('let dalServer = []') && !srcMO.includes('if (!nostri) {'));
  ok('  e le due liste si UNISCONO', srcMO.includes('NO.unisci(dalServer, dalClient)'));
  ok('  con il venue in precedenza sul client a parità di orderId',
    NO.unisci([{ orderId: 'a', price: 0.40, size: 10 }], [{ orderId: 'a', price: 0.99, size: 1 }]).ordini[0].price === 0.40);

  // Il client può AGGIUNGERE, non togliere.
  const soloServer = NO.unisci([{ orderId: 'a', price: 0.40, size: 10 }], []).ordini;
  const conClient = NO.unisci([{ orderId: 'a', price: 0.40, size: 10 }], [{ orderId: 'b', price: 0.41, size: 5 }]).ordini;
  ok('un client vuoto NON toglie righe al server', soloServer.length === 1);
  ok('un client che mente in DIFETTO non toglie niente', conClient.length === 2);
  const clientBugiardo = NO.unisci([{ orderId: 'a', price: 0.40, size: 10 }], [{ orderId: 'a', price: 0.01, size: 1 }]).ordini;
  ok('un client che mente sul PREZZO di un ordine noto non viene creduto',
    clientBugiardo.length === 1 && clientBugiardo[0].price === 0.40);

  // Il referto distingue le due provenienze: senza, «letto dal venue» e «dichiarato dal pannello»
  // sarebbero lo stesso numero.
  ok('il referto dichiara le due provenienze separatamente',
    srcMO.includes('dalVenue: dalServer.length') && srcMO.includes('dalPannello: u.aggiuntiDalClient'));
  ok('  e se il venue non si legge lo dice invece di tacere', srcMO.includes('venue NON letto'));

  // Il pannello manda davvero qualcosa, e lo schema della route lo accetta.
  const srcPanel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'components', 'OrderPanel.tsx'), 'utf8');
  const srcRoute = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'maker', 'manual', 'order', 'route.ts'), 'utf8');
  ok('il pannello legge i propri ordini e li manda', srcPanel.includes('ownOrders') && srcPanel.includes('/api/maker/manual/orders?marketId='));
  ok('  best-effort: una lettura fallita non blocca il piazzamento',
    /catch \{ \/\* il server rilegge comunque/.test(srcPanel));
  ok('lo schema della route accetta il campo (zod scarta ciò che non dichiara)',
    /ownOrders: z\.array/.test(srcRoute));
  ok('  con un tetto di righe, e il pannello rispetta lo stesso tetto',
    srcRoute.includes('.max(200)') && srcPanel.includes('.slice(0, 200)'));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 5 · LA VENDITA USA LO SPECCHIO, E LA SOTTRAZIONE RESTA UNA SOLA');
{
  // Su un SELL `prezzo-in-coda` specchia prezzi e nostri ordini per riusare l'aritmetica del bid:
  // la sottrazione deve continuare a funzionare dopo lo specchio.
  const rules = {
    tick: 0.01,
    books: {
      yes: { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.58, size: 100 }, { price: 0.60, size: 300 }], scoringMid: 0.50 },
      no: { bids: [], asks: [], scoringMid: 0.50 },
    },
  };
  const nostri = NO.nostriSulLato({ orders: [{ orderId: 'm', tokenId: 'T', price: 0.58, size: 100 }], tokenId: 'T' }).ordini;
  const q = PC.prezzoInCoda({ book: 'yes', side: 'SELL', rules,
    depth: { yes: rules.books.yes, no: rules.books.no }, ownOrders: nostri, offsetCents: 1 });
  ok('in vendita il nostro ask a 58¢ non conta come concorrente',
    q.bestOther == null || Math.abs(q.bestOther - 0.58) > 1e-9, `bestOther ${q.bestOther}`);
  ok('  e la funzione risponde senza esplodere', typeof q === 'object' && q !== null);
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);
