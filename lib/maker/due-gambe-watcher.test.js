#!/usr/bin/env node
'use strict';
// IL WATCHER SA CHE UN MERCATO ADESSO HA DUE GAMBE.
//
// Il riallocatore automatico piazza due ordini per mercato: un BUY sul libro YES e un BUY sul libro NO.
// Quegli ordini finiscono sotto agent40-manual-reprice, che li rinnova prima della scadenza GTD e li
// riprezza quando escono dalla banda. Le domande a cui questo file risponde sono le quattro che
// contano quando le gambe sono due invece di una:
//
//   · ogni gamba viene attribuita al SUO libro, e la banda viene giudicata nello spazio di quel libro
//     (un ordine NO a q E' un ordine YES a 1 − q: giudicarlo contro il mid YES lo direbbe fuori banda
//     di 88 centesimi quando invece e' esattamente dov'e' giusto che sia);
//   · la scadenza GTD e il rinnovo proattivo valgono per ENTRAMBE, indipendentemente;
//   · una gamba il cui token non corrisponde a nessuno dei due libri non viene toccata, mai indovinata;
//   · il dead-man's switch — la scadenza che il VENUE fa rispettare — e' sulla singola gamba, quindi
//     copre le due allo stesso modo anche se questo processo muore.
//
// Niente rete e niente venue: si provano `selectOwnedOrders` e `decideReprice`, che sono puri.

const { selectOwnedOrders, decideReprice } = require('./auto-reprice');
const { planQuotes } = require('./mm-quote-math');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MID = 0.055;              // un mercato lontano da 50¢: e' li' che l'errore sarebbe grosso
const MKT = '0x' + 'a1'.repeat(32);
const TOK_YES = '111';
const TOK_NO = '222';

const regole = (over = {}) => ({
  readable: true, marketId: MKT, mid: MID, tick: 0.001, maxSpreadCents: 5.5, minSize: 20,
  midSource: 'live-book', midAgeSec: 3, tokenId: TOK_YES, tokenIdNo: TOK_NO,
  books: { yes: { scoringMid: MID }, no: { scoringMid: +(1 - MID).toFixed(6) } },
  ...over,
});

const cfg = {
  requireLiveBook: true, maxMidAgeSec: 30, refreshMarginSeconds: 180, minIntervalMs: 0,
  maxPerHour: 100, hysteresisTicks: 1, confirmSamples: 1, restingGtdSeconds: 1380,
};

// I due prezzi che plan-to-orders piazzerebbe davvero su questo mercato.
const q = planQuotes({ mid: MID, offsetCents: 1, tick: 0.001, bandRadiusCents: 2.75 });

const ordineVenue = (tokenId, price, over = {}) => ({
  orderId: 'ord-' + tokenId, marketId: MKT, tokenId, price, size: 199, sizeRemaining: 199,
  side: 'BUY', source: 'manual-ui', status: 'LIVE', secondsToExpiry: 900, orderType: 'GTD', ...over,
});

console.log('\n══ LE DUE GAMBE SONO ATTRIBUITE AL LORO LIBRO, DAL TOKEN');
{
  const owned = selectOwnedOrders(
    [ordineVenue(TOK_YES, q.yes.price), ordineVenue(TOK_NO, q.no.price)],
    { marketId: MKT, rules: regole() },
  );
  ok('entrambe le gambe sono riconosciute', owned.length === 2, String(owned.length));
  ok('  quella col token YES e sul libro yes', owned.find((o) => o.tokenId === TOK_YES).book === 'yes');
  ok('  quella col token NO e sul libro no', owned.find((o) => o.tokenId === TOK_NO).book === 'no');
  ok('  e nessuna delle due porta un libro indovinato', owned.every((o) => o.book === 'yes' || o.book === 'no'));
}

console.log('\n══ UNA GAMBA CON UN TOKEN SCONOSCIUTO NON VIENE TOCCATA');
{
  const owned = selectOwnedOrders([ordineVenue('999', 0.5)], { marketId: MKT, rules: regole() });
  ok('l ordine non attribuibile e escluso, non assegnato a caso', owned.length === 0);
}

console.log('\n══ OGNI GAMBA E GIUDICATA NELLO SPAZIO DEL SUO LIBRO');
{
  // La prova che conta: il lato NO riposa a 0.934. Contro il mid YES (0.055) disterebbe 87.9¢, cioe'
  // fuori banda di trenta volte il raggio; contro il SUO mid (0.945) dista esattamente 1¢, dentro.
  const owned = selectOwnedOrders(
    [ordineVenue(TOK_YES, q.yes.price), ordineVenue(TOK_NO, q.no.price)],
    { marketId: MKT, rules: regole() },
  );
  const r = regole();
  for (const o of owned) {
    const d = decideReprice({ order: o, rules: r, config: cfg, now: 1_700_000_000_000, lastRepriceAt: null, repricesThisHour: 0 },
      { resolveOffset: () => ({ targetOffsetCents: 1, minMoveCents: 0.5, source: 'test' }) });
    ok(`la gamba ${o.book.toUpperCase()} e giudicata DENTRO banda e non viene toccata`,
      d.action === 'hold', `${d.action} · ${d.gate} · ${String(d.reason).slice(0, 90)}`);
    ok(`  con il mid del SUO libro (${o.book === 'no' ? '1 − mid' : 'mid'})`,
      Math.abs(d.scoringMid - (o.book === 'no' ? 1 - MID : MID)) < 1e-6, String(d.scoringMid));
    ok(`  e una distanza di ~1¢, non di ~88¢`, Math.abs(d.distanceC - 1) < 0.2, `${d.distanceC}¢`);
  }
}

console.log('\n══ IL RINNOVO PROATTIVO SCATTA SU ENTRAMBE, INDIPENDENTEMENTE');
{
  const r = regole();
  // Le due gambe hanno vite residue DIVERSE — è il caso reale: sono state piazzate a pochi secondi di
  // distanza e ognuna porta la sua scadenza. Quella corta si rinnova, l'altra no, e nessuna delle due
  // decisione dipende dall'altra.
  const owned = selectOwnedOrders(
    [ordineVenue(TOK_YES, q.yes.price, { secondsToExpiry: 120 }), ordineVenue(TOK_NO, q.no.price, { secondsToExpiry: 900 })],
    { marketId: MKT, rules: r },
  );
  const dYes = decideReprice({ order: owned.find((o) => o.book === 'yes'), rules: r, config: cfg, now: 1_700_000_000_000, lastRepriceAt: null, repricesThisHour: 0 },
    { resolveOffset: () => ({ targetOffsetCents: 1, minMoveCents: 0.5, source: 'test' }) });
  const dNo = decideReprice({ order: owned.find((o) => o.book === 'no'), rules: r, config: cfg, now: 1_700_000_000_000, lastRepriceAt: null, repricesThisHour: 0 },
    { resolveOffset: () => ({ targetOffsetCents: 1, minMoveCents: 0.5, source: 'test' }) });
  ok('la gamba con 120s di vita viene rinnovata', dYes.action === 'reprice' && dYes.gate === 'expiry-refresh',
    `${dYes.action} · ${dYes.gate}`);
  ok('  allo STESSO prezzo: il rinnovo azzera l orologio, non insegue il mercato', dYes.targetPrice === q.yes.price,
    `${dYes.targetPrice} contro ${q.yes.price}`);
  ok('la gamba con 900s di vita NON viene toccata', dNo.action === 'hold', `${dNo.action} · ${dNo.gate}`);
  ok('  quindi le due gambe non si trascinano a vicenda', dYes.action !== dNo.action);
}

console.log('\n══ LA SCADENZA GTD E SULLA SINGOLA GAMBA: IL DEAD-MAN COPRE ENTRAMBE');
{
  const owned = selectOwnedOrders(
    [ordineVenue(TOK_YES, q.yes.price, { secondsToExpiry: 800, orderType: 'GTD' }),
      ordineVenue(TOK_NO, q.no.price, { secondsToExpiry: 810, orderType: 'GTD' })],
    { marketId: MKT, rules: regole() },
  );
  ok('entrambe portano una scadenza venue-enforced', owned.every((o) => o.orderType === 'GTD' && o.secondsToExpiry > 0),
    JSON.stringify(owned.map((o) => [o.book, o.orderType, o.secondsToExpiry])));
  ok('  quindi se il processo muore il venue le ritira tutte e due, non una',
    owned.filter((o) => Number.isFinite(o.secondsToExpiry)).length === 2);
  // La finestra di asimmetria che RESTA: le due scadenze non coincidono al secondo, quindi fra la morte
  // di una e quella dell'altra c'e' un intervallo pari alla loro differenza di piazzamento. E' misurato,
  // dichiarato, e piccolo — non e' zero, e fingere che lo sia sarebbe la cosa sbagliata da scrivere qui.
  const delta = Math.abs(owned[0].secondsToExpiry - owned[1].secondsToExpiry);
  ok(`  la finestra di asimmetria a processo morto e la differenza fra le due scadenze (${delta}s)`, delta === 10);
}

console.log('\n══ UNA GAMBA SU UN MID NON LEGGIBILE NON SI MUOVE');
{
  const owned = selectOwnedOrders([ordineVenue(TOK_NO, q.no.price)], { marketId: MKT, rules: regole() });
  const senzaNo = regole({ books: { yes: { scoringMid: MID }, no: {} } });
  const d = decideReprice({ order: owned[0], rules: senzaNo, config: cfg, now: 1_700_000_000_000, lastRepriceAt: null, repricesThisHour: 0 }, {});
  ok('mid del libro NO assente ⇒ skip, non un prezzo indovinato',
    d.action === 'skip' && d.gate === 'band-unreadable', `${d.action} · ${d.gate}`);
}

console.log(`\ndue gambe sotto il watcher: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
