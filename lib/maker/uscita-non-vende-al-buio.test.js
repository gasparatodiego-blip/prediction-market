'use strict';
// lib/maker/uscita-non-vende-al-buio.test.js
//
// LA REGOLA, decisione dell'operatore del 18 agosto 2026: non si vende contro un bid che non si puo'
// datare. Si resta al gradino corrente e si dichiara l'anomalia con la causa.
//
// L'UNICA ECCEZIONE E' LA REGOLA 6 — il residuo sotto `min_incentive_size`. Li' si chiude comunque,
// perche' il capitale bloccato costa piu' della perdita immediata: un residuo sotto il minimo non e'
// ne' ripiazzabile ne' completabile, e la sua unica alternativa e' aspettare la risoluzione.
//
// IL BUCO CHE CHIUDE. `auto-close` non produce prezzi propri — il prezzo e' il bid del libro camminato
// per la nostra size — ma non conteneva NESSUN controllo di freschezza, mentre il repricer rifiuta di
// muovere un ordine su un mid vecchio e il piazzatore rifiuta di aprirne uno. La funzione che decide di
// VENDERE era l'unica delle tre a non guardare l'orologio.

const assert = require('assert');
const { decideClose } = require('./auto-close');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };

const ORA = Date.parse('2026-08-18T21:00:00Z');
const VIT = { assetsWithEvents: 200, seededAssets: 282, totalAssets: 282, windowMs: 30000 };

// Un libro con un bid vero, cosi' che senza il gate la vendita sarebbe possibile.
const BOOK = {
  bids: [{ price: 0.70, size: 500 }, { price: 0.69, size: 500 }],
  asks: [{ price: 0.72, size: 500 }, { price: 0.73, size: 500 }],
};
// ⚠ `book` in `decideClose` e' il LATO ('yes'/'no'), non un oggetto: il libro vive in `rules.books`.
// L'ho sbagliato alla prima stesura e l'ha preso il test stesso, cadendo su `rules.books.yes`.
const regole = (extra = {}) => ({
  readable: true, tick: 0.01, maxSpreadCents: 4.5, minSize: 50,
  bestBid: 0.70, bestAsk: 0.72, feedVitality: VIT,
  midSource: 'live-book', midAgeSec: 5,
  books: {
    yes: { tokenId: 'TY', scoringMid: 0.71, bestBid: 0.70, bestAsk: 0.72, displayMid: 0.71, levels: BOOK },
    no: { tokenId: 'TN', scoringMid: 0.29, bestBid: 0.28, bestAsk: 0.30, displayMid: 0.29, levels: BOOK },
  },
  ...extra,
});
const chiudi = (extra = {}, posExtra = {}) => decideClose({
  position: { size: 100, avgPrice: 0.60, ...posExtra },
  restingOrders: [], rules: regole(extra), book: 'yes', now: ORA,
  venue: { closed: false, acceptingOrders: true },
});

// ══ ① CON UN LIBRO FRESCO IL GATE NON MORDE ═══════════════════════════════════════════════════════
{
  const r = chiudi();
  ok(!['book-vecchio', 'book-non-databile', 'book-non-live'].includes(r.gate),
    `① libro fresco ⇒ il gate non interviene (gate: ${r.gate})`);
}

// ══ ② LIBRO FERMO ⇒ NON SI VENDE, SI RESTA AL GRADINO ═════════════════════════════════════════════
{
  // 61 s con regime «vivo» (limite 60): oltre soglia.
  const r = chiudi({ midAgeSec: 61 });
  ok(r.action === 'skip', '② ⚑ book vecchio ⇒ NON si vende');
  ok(r.gate === 'book-vecchio', '②   col gate «book-vecchio»');
  ok(r.causa === 'prezzo-vecchio', '②   e la causa a verbale e «prezzo-vecchio»');
  ok(/gradino corrente/.test(r.reason), '②   e il motivo dice che si resta al gradino');
  ok(r.price === null, '②   nessun prezzo proposto');
}

// ══ ③ BID NON DATABILE ⇒ CAUSA DIVERSA, E LA DISTINZIONE E' IL PUNTO ══════════════════════════════
{
  const r = chiudi({ midAgeSec: null });
  ok(r.action === 'skip', '③ eta non leggibile ⇒ NON si vende');
  ok(r.gate === 'book-non-databile', '③   col gate «book-non-databile»');
  ok(r.causa === 'prezzo-non-databile',
    '③   ⚑ causa DISTINTA da «vecchio»: li il feed ha parlato, qui non dice quando');

  const fonte = chiudi({ midSource: 'manual-catalog' });
  ok(fonte.gate === 'book-non-live', '③ fonte di seconda mano ⇒ gate «book-non-live»');
  ok(fonte.causa === 'fonte-non-live', '③   con la sua causa');
}

// ══ ④ L'ECCEZIONE R6: IL RESIDUO SOTTO IL MINIMO SI CHIUDE COMUNQUE ═══════════════════════════════
{
  // 20 share contro un minimo del venue di 50: e' un residuo R6. Il libro e' fermo da 300 s, e si
  // chiude lo stesso — il capitale bloccato costa piu' della perdita immediata.
  const r = decideClose({
    position: { size: 20, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: 300 }), book: 'yes', now: ORA,
    venue: { closed: false, acceptingOrders: true },
  });
  ok(!['book-vecchio', 'book-non-databile', 'book-non-live'].includes(r.gate),
    `④ ⚑ residuo sotto il minimo ⇒ il gate NON blocca (gate: ${r.gate})`);

  // E vale anche quando il bid non e' databile del tutto.
  const cieco = decideClose({
    position: { size: 20, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: null }), book: 'yes', now: ORA,
    venue: { closed: false, acceptingOrders: true },
  });
  ok(!['book-vecchio', 'book-non-databile', 'book-non-live'].includes(cieco.gate),
    `④ ⚑ e nemmeno con un bid non databile (gate: ${cieco.gate})`);
}

// ══ ⑤ IL CONFINE E' IL MINIMO DEL VENUE, PROVATO DAI DUE LATI ═════════════════════════════════════
{
  const sotto = decideClose({
    position: { size: 49.9, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: 300, minSize: 50 }), book: 'yes', now: ORA,
    venue: { closed: false, acceptingOrders: true },
  });
  ok(sotto.gate !== 'book-vecchio', '⑤ 49,9 share con minimo 50 ⇒ e residuo R6, passa');

  const sopra = decideClose({
    position: { size: 50.1, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: 300, minSize: 50 }), book: 'yes', now: ORA,
    venue: { closed: false, acceptingOrders: true },
  });
  ok(sopra.gate === 'book-vecchio', '⑤ ⚑ 50,1 share NON e un residuo: il gate morde');

  // ⚑ Nessun numero cablato: si sposta il minimo del venue e si sposta il confine.
  const minAlto = decideClose({
    position: { size: 50.1, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: 300, minSize: 200 }), book: 'yes', now: ORA,
    venue: { closed: false, acceptingOrders: true },
  });
  ok(minAlto.gate !== 'book-vecchio',
    '⑤ ⚑ con minimo 200 le stesse 50,1 share tornano un residuo: il confine e il minimo, non un numero');
}

// ══ ⑥ UN MERCATO CHIUSO NON PASSA DAL GATE: si riscatta, non ha bisogno di un bid ═════════════════
{
  const r = decideClose({
    position: { size: 100, avgPrice: 0.60 },
    restingOrders: [], rules: regole({ midAgeSec: 999 }), book: 'yes', now: ORA,
    venue: { closed: true, acceptingOrders: false },
  });
  ok(r.gate === 'market-closed',
    '⑥ ⚑ mercato chiuso ⇒ risponde «market-closed», non «book-vecchio»: il gate sta DOPO quella guardia');
}

// ══ ⑦ LA SOGLIA E' IMPORTATA, NON RICOPIATA ═══════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./auto-close'), 'utf8');
  ok(/require\('\.\/auto-reprice'\)/.test(src), '⑦ `auto-close` IMPORTA `auto-reprice`');
  ok(/regimeFeed\(/.test(src), '⑦   e chiama `regimeFeed`, la stessa dei due gemelli');
}

console.log(`uscita non vende al buio: ${passati}/${passati} verdi, 0 rossi`);
