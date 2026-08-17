'use strict';
// lib/maker/presa-di-profitto-scatta.test.js — LA PRESA DI PROFITTO SCATTA, RAMO PER RAMO.
//
// ═══ PERCHE' QUESTO TEST ESISTE ══════════════════════════════════════════════════════════════════
// L'operatore ha chiesto test «che esercitano lo SCATTO di ogni ramo, non la condizione». E' la
// lezione di §5-bis p.138: la` scala di urgenza aveva la condizione giusta e non arrivava mai al
// prezzo, e sono costate cinque ore di posizione aperta. Un test che verifica «la condizione e' vera»
// sarebbe stato VERDE per tutte e cinque.
// Quindi qui si passa SEMPRE da `decideClose` — la funzione vera, con la forma vera di `rules`,
// `depth` e `restingOrders` — e si asserisce sull'AZIONE e sul PREZZO che ne escono.
//
// ═══ E COSA SI DIFENDE OLTRE ALLO SCATTO ═════════════════════════════════════════════════════════
//   · che NON scatti quando completare la coppia rende di piu' (le due strade si escludono);
//   · che NON scatti sui dati veri del 16 agosto 2026, dove la misura dice che non c'era guadagno
//     incassabile in nessuno dei 283 campioni: una regola che inventasse un guadagno li' sarebbe
//     peggiore dell'assenza di regola;
//   · che sia DISGIUNTA dalla scala di urgenza, per costruzione e non per un `if`;
//   · che senza `depth` il comportamento sia ESATTAMENTE quello di prima.

const assert = require('assert');
const { decideClose } = require('./auto-close');
const { presaDiProfitto, MARGINE_CENTS } = require('./presa-di-profitto');
const U = require('./urgenza-scoperto');

let p = 0;
const ok = (nome, cond, extra = '') => { assert.ok(cond, `${nome} ${extra}`); p += 1; console.log(`  ✓ ${nome}`); };

const TICK = 0.01;
const liv = (price, size) => ({ price, size });
// `rules` nella forma vera che `decideClose` legge.
const mkRules = (midNo) => ({
  readable: true, tick: TICK, maxSpreadCents: 4.5, minSize: 50,
  books: { yes: { scoringMid: 1 - midNo, bestBid: 1 - midNo - 0.005 }, no: { scoringMid: midNo, bestBid: midNo - 0.005 } },
});
// `depth` nella forma vera che `resolveMarketDepth` restituisce: due book, due lati.
const mkDepth = ({ noBids = [], noAsks = [], yesBids = [], yesAsks = [] } = {}) => ({
  readable: true, no: { bids: noBids, asks: noAsks }, yes: { bids: yesBids, asks: yesAsks },
});

console.log('\n════ la presa di profitto scatta ════');

// ── ① RAMO «COPPIA BATTUTA»: bid 60¢ + ask 45¢ = 105¢ > 101¢ ⇒ incassare rende di piu' ──────────
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.59, bestAsk: 0.61 },
    depth: mkDepth({ noBids: [liv(0.60, 200)], yesAsks: [liv(0.45, 200)] }),
  });
  ok('① coppia battuta: SCATTA', d.action === 'close-at-market', `(action=${d.action})`);
  ok('  col trigger che la distingue dagli altri due', d.trigger === 'presa-di-profitto' && d.viaPresaDiProfitto === 'coppia-battuta');
  ok('  al BID, non al mid né all\'ask', Math.abs(d.price - 0.60) < 1e-9, `(price=${d.price})`);
  ok('  per l\'INTERA size', Math.abs(d.size - 50) < 1e-9, `(size=${d.size})`);
  ok('  e dichiara i due ricavi confrontati, o il criterio non è verificabile a posteriori',
    Math.abs(d.presaDiProfitto.ricavoIncassoUsd - 30) < 1e-6
    && Math.abs(d.presaDiProfitto.ricavoCoppiaUsd - 27.5) < 1e-6);
  ok('  e NON è peggiorativa: è un guadagno', d.peggiorativa === false && d.profitCents > 0);
}

// ── ② RAMO «COPPIA BLOCCATA»: la coppia costa 110¢ (oltre il tetto) e il bid paga sopra il carico ─
// E' il caso REALE di FL-27: «l ask di YES e' sopra il tetto di 81.0¢», quindi completare non era
// una strada e restava solo la scala d'uscita, che scende.
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.54, bestAsk: 0.56 },
    depth: mkDepth({ noBids: [liv(0.55, 200)], yesAsks: [liv(0.60, 200)] }),
  });
  ok('② coppia bloccata dal tetto: SCATTA', d.action === 'close-at-market', `(action=${d.action})`);
  ok('  con la via dichiarata', d.viaPresaDiProfitto === 'coppia-bloccata');
  ok('  al bid, sopra il carico', Math.abs(d.price - 0.55) < 1e-9 && d.price > 0.50);
  ok('  e dichiara che la coppia sforava il tetto', d.presaDiProfitto.coppiaCents > d.presaDiProfitto.tettoCoppiaCents);
}

// ── ③ LA COPPIA VINCE ⇒ NON SCATTA, e il ciclo prosegue sulla strada di prima ────────────────────
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.52), book: 'no',
    venue: { bestBid: 0.51, bestAsk: 0.53 },
    depth: mkDepth({ noBids: [liv(0.52, 200)], yesAsks: [liv(0.45, 200)] }),  // 52+45 = 97¢ < 101¢
  });
  ok('③ la coppia rende di più: NON scatta', d.trigger !== 'presa-di-profitto', `(trigger=${d.trigger})`);
  ok('  e il ciclo prosegue sulla strada ordinaria', d.action !== 'close-at-market' || d.trigger !== 'presa-di-profitto');
}

// ── ④ IL MARGINE MORDE: esattamente 100¢ non basta, servono 100¢ + margine ──────────────────────
{
  const sotto = presaDiProfitto({ carico: 0.50, size: 50,
    bidsMioLato: [liv(0.55, 200)], asksAltroLato: [liv(0.45, 200)] });   // 55+45 = 100¢ esatti
  ok('④ bid+ask = 100¢ esatti: NON scatta, la differenza è rumore', sotto.scatta === false);
  const sopra = presaDiProfitto({ carico: 0.50, size: 50,
    bidsMioLato: [liv(0.56, 200)], asksAltroLato: [liv(0.46, 200)] });   // 102¢ > 101¢
  ok('  bid+ask = 102¢: scatta', sopra.scatta === true);
  ok('  e il margine richiesto è quello dichiarato dal modulo', sotto.margineCents === MARGINE_CENTS);
}

// ── ⑤ IL PREZZO È IL BID CAMMINATO, NON IL BEST BID ─────────────────────────────────────────────
// Vendere 100 share contro un best bid da 20 significa prendere anche i livelli sotto. Prezzare sul
// solo primo livello dichiarerebbe un ricavo che non esiste.
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 100, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.69, bestAsk: 0.71 },
    depth: mkDepth({ noBids: [liv(0.70, 20), liv(0.60, 80)], yesAsks: [liv(0.45, 200)] }),
  });
  const atteso = (20 * 0.70 + 80 * 0.60) / 100;   // 0,62
  ok('⑤ SCATTA al prezzo camminato', d.action === 'close-at-market' && Math.abs(d.price - atteso) < 1e-9,
    `(price=${d.price}, atteso=${atteso})`);
  ok('  che è PEGGIORE del best bid: il best bid da solo mentirebbe', d.price < 0.70);
}

// ── ⑥ TUTTA LA SIZE O NIENTE: il libro non copre ⇒ non si vende una parte ───────────────────────
// Un residuo sotto il minimo del venue è capitale senza via d'uscita (§5.2 p.1, $26,30 già murati).
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 100, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.69, bestAsk: 0.71 },
    depth: mkDepth({ noBids: [liv(0.70, 20)], yesAsks: [liv(0.45, 200)] }),   // copre 20 su 100
  });
  ok('⑥ libro insufficiente: NON scatta, nessun residuo murato', d.trigger !== 'presa-di-profitto',
    `(trigger=${d.trigger})`);
}

// ── ⑦ I NOSTRI ORDINI ESCONO DALLA SCALA: non si vende contro se stessi ─────────────────────────
{
  const nostroBuy = { orderId: '0xmio', side: 'BUY', price: 0.70, size: 200, tokenId: 'tokN' };
  const conNostri = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [nostroBuy], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.69, bestAsk: 0.71 },
    // Il livello a 70¢ è INTERAMENTE nostro: tolto, resta solo quello a 60¢.
    depth: mkDepth({ noBids: [liv(0.70, 200), liv(0.60, 200)], yesAsks: [liv(0.45, 200)] }),
  });
  ok('⑦ il nostro BUY è tolto dalla scala', conNostri.action === 'close-at-market'
    && Math.abs(conNostri.price - 0.60) < 1e-9, `(price=${conNostri.price})`);
  ok('  e finisce fra gli id da cancellare PRIMA di vendere (gate anti-auto-incrocio riusato)',
    Array.isArray(conNostri.cancelOrderIds) && conNostri.cancelOrderIds.includes('0xmio'));
  ok('  con il guard dichiarato nell\'audit', conNostri.selfTradeGuard
    && conNostri.selfTradeGuard.attivato === true && conNostri.selfTradeGuard.trigger === 'presa-di-profitto');
}

// ── ⑧ UN'USCITA GIÀ A RIPOSO NON BLOCCA L'INCASSO ───────────────────────────────────────────────
// È la forma di difetto di §5-bis p.138: là il `return` di `already-covered` impediva di ABBASSARE,
// qui impedirebbe di INCASSARE. La presa di profitto è valutata PRIMA di quel ramo.
{
  const d = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [{ orderId: '0xuscita', side: 'SELL', price: 0.80, size: 50, tokenId: 'tokN', createdMs: Date.now() }],
    rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.59, bestAsk: 0.61 },
    depth: mkDepth({ noBids: [liv(0.60, 200)], yesAsks: [liv(0.45, 200)] }),
  });
  ok('⑧ con un\'uscita a riposo a 80¢: SCATTA lo stesso', d.action === 'close-at-market'
    && d.trigger === 'presa-di-profitto', `(action=${d.action}, trigger=${d.trigger})`);
  ok('  e l\'uscita vecchia va cancellata, o si venderebbe due volte',
    d.cancelOrderIds.includes('0xuscita'));
}

// ── ⑨ FAIL-CLOSED: senza `depth` il comportamento è ESATTAMENTE quello di prima ─────────────────
{
  const senza = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.59, bestAsk: 0.61 },
  });
  ok('⑨ dep non cablata ⇒ non scatta', senza.trigger !== 'presa-di-profitto', `(trigger=${senza.trigger})`);
  const askCieco = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { bestBid: 0.59, bestAsk: 0.61 },
    depth: mkDepth({ noBids: [liv(0.60, 200)], yesAsks: null }),
  });
  ok('  ask dell\'altro lato illeggibile ⇒ non si incassa al buio', askCieco.trigger !== 'presa-di-profitto');
  ok('  e `Number(null)` non diventa un prezzo',
    presaDiProfitto({ carico: 0.5, size: 10, bidsMioLato: [liv(null, 10)], asksAltroLato: [liv(0.4, 10)] }).scatta === false);
}

// ── ⑩ MAI SU UN MERCATO CHIUSO: la guardia resta davanti ────────────────────────────────────────
{
  const chiuso = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { closed: true, bestBid: 0.59, bestAsk: 0.61 },
    depth: mkDepth({ noBids: [liv(0.60, 200)], yesAsks: [liv(0.45, 200)] }),
  });
  ok('⑩ mercato chiuso: NON scatta, si riscatta e non si vende',
    chiuso.action === 'skip' && chiuso.gate === 'market-closed', `(action=${chiuso.action})`);
  const nonAccetta = decideClose({
    position: { tokenId: 'tokN', size: 50, avgPrice: 0.50 },
    restingOrders: [], rules: mkRules(0.55), book: 'no',
    venue: { acceptingOrders: false, bestBid: 0.59, bestAsk: 0.61 },
    depth: mkDepth({ noBids: [liv(0.60, 200)], yesAsks: [liv(0.45, 200)] }),
  });
  ok('  e nemmeno se il venue non accetta ordini', nonAccetta.gate === 'market-not-accepting');
}

// ── ⑪ DISGIUNTA DALLA SCALA DI URGENZA, PER COSTRUZIONE ─────────────────────────────────────────
// La scala concede di scendere FINO AL CARICO e sotto; la presa di profitto pretende di stare SOPRA
// il carico più il margine. Non esiste un prezzo su cui entrambe possano parlare.
{
  let incroci = 0, provati = 0;
  for (const carico of [0.05, 0.20, 0.50, 0.80, 0.95]) {
    for (let bid = 0.01; bid < 1; bid += 0.01) {
      const tp = presaDiProfitto({ carico, size: 10,
        bidsMioLato: [liv(+bid.toFixed(4), 100)], asksAltroLato: [liv(0.99, 100)] });
      if (!tp.scatta) continue;
      provati++;
      // Se la presa di profitto scatta, il prezzo è sopra il carico: la scala di urgenza non può
      // proporre nulla lì, perché il suo pavimento è al massimo il carico.
      for (const min of [0, 35, 80, 300]) {
        const u = U.livelloUrgenza({ scopertoDaMin: min });
        const pav = U.pavimentoConcesso({ carico, tick: TICK, concessioneTick: u.concessioneTick });
        if (Number.isFinite(pav.pavimento) && pav.pavimento > carico + 1e-12) incroci++;
      }
    }
  }
  ok(`⑪ su ${provati} scatti, la scala non propone MAI un pavimento sopra il carico`, incroci === 0,
    `(incroci=${incroci})`);
  ok('  e ogni scatto è sopra il carico più il margine, per definizione',
    presaDiProfitto({ carico: 0.5, size: 10, bidsMioLato: [liv(0.505, 100)], asksAltroLato: [liv(0.99, 100)] }).scatta === false);
}

// ── ⑫ SUI DATI VERI DEL 16 AGOSTO 2026 NON SCATTA — ed è il punto ───────────────────────────────
// Libro reale di FL-02 alle 16:45:07Z (data/mid-history-2026-08-16.jsonl): best bid 44¢, unico livello
// qualificante 44¢ × 360. Carico 54¢, 57,1 share. Il pannello mostrava $57,10 e la misura dice che
// non c'era un solo istante in guadagno su 130 campioni. Una regola che scattasse qui inventerebbe
// un guadagno che il libro non offriva.
{
  const d = decideClose({
    position: { tokenId: 'tokY', size: 57.1, avgPrice: 0.54 },
    restingOrders: [], rules: mkRules(0.52), book: 'yes',
    venue: { bestBid: 0.44, bestAsk: 0.52 },
    depth: mkDepth({ yesBids: [liv(0.44, 360)], noAsks: [liv(0.56, 200)] }),
  });
  ok('⑫ FL-02 sul libro vero del 16/08: NON scatta', d.trigger !== 'presa-di-profitto',
    `(trigger=${d.trigger})`);
  const tp = presaDiProfitto({ carico: 0.54, size: 57.1,
    bidsMioLato: [liv(0.44, 360)], asksAltroLato: [liv(0.56, 200)] });
  ok('  e il ricavo misurato è quello del referto: $25,12 contro un costo di $30,83',
    Math.abs(tp.ricavoIncassoUsd - 25.124) < 0.01, `(ricavo=${tp.ricavoIncassoUsd})`);
  ok('  cioè bid+ask = 100¢ esatti, sotto la soglia: la coppia non è battuta',
    Math.abs(0.44 + 0.56 - 1) < 1e-9 && tp.scatta === false);
}

console.log(`\n${p} asserzioni verdi\n`);
