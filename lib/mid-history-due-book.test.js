'use strict';
// lib/mid-history-due-book.test.js — `mid-history` REGISTRA ENTRAMBI I BOOK, NON SOLO IL «YES».
//
// ═══ IL GUASTO CHE QUESTO TEST IMPEDISCE ════════════════════════════════════════════════════════════
// Il lato NO e' un CLOB indipendente, non lo specchio del lato YES, e il bot ci quota sopra una gamba.
// `reconcileSubscriptions` lo sottoscrive da sempre e lo store lo tiene aggiornato — era **lo
// scrittore** a buttarlo via, perche' guardava `meta.tokenId` e nient'altro.
//
// Il conto e' arrivato il 19 agosto 2026, misurando perche' R4 (erosione della profondita' davanti)
// non fosse mai scattata: il fill del 18 agosto era avvenuto sulla gamba **NO**, e di quel book non
// esiste una riga su disco. La conclusione «la profondita' non e' crollata» era provata sul **lato
// sbagliato**, e non e' rifacibile: il dato passava dal processo ogni pochi secondi e nessuno lo
// salvava. E' la forma peggiore di «calcolato e mai letto», perche' non lascia nemmeno un buco visibile
// — il giornale sembra completo.
//
// ═══ COSA SI DIFENDE ════════════════════════════════════════════════════════════════════════════════
//   ① i due book finiscono ENTRAMBI nella riga, e sono INDIPENDENTI (due book diversi ⇒ due
//      fotografie diverse: se qualcuno rimettesse `meta.tokenId` al posto del NO, il test cade);
//   ② i campi di primo livello restano ESATTAMENTE quelli di prima — cinque moduli li leggono cosi';
//   ③ «non c'e' un secondo book» e «c'e' ma non l'ho letto» restano DUE risposte diverse.
//
// ⚠ Si guida lo scrittore VERO (`sampleMidHistory` di agent34), non una copia: provare la decisione e
//   non il cablaggio e' esattamente come tre difese di questo repo sono rimaste inerti col verde.

const assert = require('assert');
const A = require('../agents/agent34-clob-ws');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

const ORA = 1_787_100_000_000;
const TOK_YES = 'tok-yes';
const TOK_NO = 'tok-no';

// Due book DELIBERATAMENTE diversi: se lo scrittore fotografasse due volte lo stesso asset, le due
// fotografie sarebbero identiche e il blocco ① cadrebbe.
const BOOK = {
  [TOK_YES]: { bids: [{ price: '0.23', size: '240' }, { price: '0.22', size: '20' }],
    asks: [{ price: '0.28', size: '20' }] },
  [TOK_NO]: { bids: [{ price: '0.63', size: '95' }],
    asks: [{ price: '0.77', size: '310' }, { price: '0.78', size: '40' }] },
};

const storeFinto = {
  getBook: (a) => BOOK[a] || null,
  freshness: (a) => (BOOK[a] ? { ageMs: 1000 } : { ageMs: null }),
};

function esegui(meta) {
  const righe = [];
  const desired = new Map([[meta.conditionId, meta]]);
  A.sampleMidHistory({ store: storeFinto, desired, now: ORA, stream: { write: (b) => righe.push(b) } });
  const testo = righe.join('');
  return testo.trim() ? testo.trim().split('\n').map((r) => JSON.parse(r)) : [];
}

const META = {
  conditionId: '0xmercato', tokenId: TOK_YES, tokenIdNo: TOK_NO,
  minSize: 20, maxSpread: 4.5, tick: 0.01,
};

// ══ ① I DUE BOOK CI SONO, E SONO INDIPENDENTI ═══════════════════════════════════════════════════
{
  const [r] = esegui(META);
  ok(!!r, '① lo scrittore ha prodotto una riga');
  ok(r.no && typeof r.no === 'object', '① ⚑ la riga porta il blocco `no`', JSON.stringify(r.no || null));
  ok(r.tokenIdNo === TOK_NO, '① …e dichiara di quale token e', String(r.tokenIdNo));

  // ⚑ LA PROVA CHE CONTA: i due book non sono la stessa fotografia.
  ok(r.bestBid === 0.23, '① il book YES e quello YES', String(r.bestBid));
  ok(r.no.bestBid === 0.63, '① ⚑ il book NO e quello NO, non una seconda copia del YES', String(r.no.bestBid));
  ok(r.bestAsk === 0.28 && r.no.bestAsk === 0.77, '① e gli ask sono quelli dei rispettivi book',
    `yes ${r.bestAsk} · no ${r.no.bestAsk}`);
  ok(r.plainMid !== r.no.plainMid, '① ⚑ i due mid sono diversi: due CLOB indipendenti, non uno specchio',
    `yes ${r.plainMid} · no ${r.no.plainMid}`);

  // La profondita' per livello — quella che serve a `book-erosion.zoneDepth` — c'e' su entrambi.
  ok(Array.isArray(r.levels), '① il YES porta i livelli');
  ok(Array.isArray(r.no.levels), '① ⚑ e il NO pure: senza questi, l erosione sulla gamba NO resta non misurabile');
}

// ══ ② LA FORMA VECCHIA E' INTATTA — cinque moduli la leggono cosi' ══════════════════════════════
{
  const [r] = esegui(META);
  // `lib/mid-history-coverage`, `lib/reward-layered-history`, `lib/rewards/velocita-mercato`,
  // `lib/maker/offset-config`, `lib/rewards/allocator`.
  for (const campo of ['ts', 'marketId', 'tokenIdYes', 'adjMid', 'plainMid', 'bestBid', 'bestAsk',
    'bidDepthInBand', 'askDepthInBand', 'bandLow', 'bandHigh', 'tick', 'levels', 'src']) {
    ok(Object.prototype.hasOwnProperty.call(r, campo), `② il campo di primo livello «${campo}» c e ancora`);
  }
  ok(r.tokenIdYes === TOK_YES, '② ⚑ e i campi di primo livello descrivono ancora il book YES');
  ok(r.ts === new Date(ORA).toISOString(), '② l orario e quello del campionamento');
}

// ══ ③ «NON C'E'» E «NON L'HO LETTO» RESTANO DUE RISPOSTE DIVERSE ═══════════════════════════════
{
  // Nessun token NO dichiarato ⇒ `no: null`. Non un oggetto di zeri.
  const [senza] = esegui({ ...META, tokenIdNo: null });
  ok(senza.no === null, '③ ⚑ nessun token NO ⇒ `no: null`: «questo mercato non ha un secondo book»',
    JSON.stringify(senza.no));
  ok(senza.tokenIdNo === null, '③   e `tokenIdNo` e null, non undefined');

  // Token NO dichiarato ma book assente dallo store ⇒ l'oggetto c'e', coi campi a null.
  const [muto] = esegui({ ...META, tokenIdNo: 'tok-mai-visto' });
  ok(muto.no && typeof muto.no === 'object', '③ ⚑ token dichiarato ma book assente ⇒ l oggetto C E');
  ok(muto.no.bestBid === null && muto.no.adjMid === null,
    '③   coi campi a null: «il book esiste ma non l ho letto» — mai uno zero');
  ok(muto.no.src === 'stale', '③   e `src` lo dichiara', String(muto.no.src));

  // ⚑ La distinzione e' il punto: i due casi non collassano l'uno sull'altro.
  ok(senza.no !== muto.no && (senza.no === null) !== (muto.no === null),
    '③ ⚑ i due casi restano distinguibili da chi legge il giornale');
}

// ══ ④ UN LATO SOLO NON CONTAMINA L'ALTRO ════════════════════════════════════════════════════════
{
  // Se il book YES sparisse, il NO deve restare leggibile — e viceversa. E' la proprieta' che rende
  // la misura ripetibile anche quando meta' del feed singhiozza.
  const [r] = esegui({ ...META, tokenId: 'tok-mai-visto' });
  ok(r.bestBid === null, '④ YES illeggibile ⇒ i campi YES sono null');
  ok(r.no && r.no.bestBid === 0.63, '④ ⚑ …e il NO resta leggibile: i due lati non si trascinano a vicenda');
}

console.log(`mid-history, due book: ${passati}/${passati} verdi, 0 rossi`);
