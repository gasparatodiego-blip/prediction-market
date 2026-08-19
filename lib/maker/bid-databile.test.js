'use strict';
// lib/maker/bid-databile.test.js — NON SI VENDE CONTRO UN BID CHE NON SI PUO' DATARE.
//
// ═══ PERCHE' QUESTO FILE ESISTE ═════════════════════════════════════════════════════════════════════
// La regola e' del commit `c919981` (18 agosto 2026, sera) e nasce da un fatto: `auto-close` non
// produce prezzi propri — il prezzo d'uscita **e'** il bid del libro camminato per la nostra size.
// Il repricer rifiuta di muovere un ordine su un mid vecchio; il piazzatore rifiuta di aprirne uno.
// La funzione che decide di **VENDERE** era l'unica delle tre a non guardare l'orologio, e la sera del
// 18 agosto il libro di un mercato e' rimasto fermo per minuti mentre gli altri 124 erano freschi.
//
// ⚠ QUANDO LA REGOLA E' ENTRATA, SETTE TEST SONO DIVENTATI ROSSI. Non per un difetto: le loro fixture
//   non portavano l'eta' del book, quindi ricevevano `skip/book-non-databile` e non arrivavano piu' al
//   codice che esistevano per provare. La cura non era ammorbidire il gate ne' togliere l'asserzione:
//   era **alimentare** quelle fixture con un book databile e **difendere il gate** — che e' quello che
//   fa questo file, in un posto solo, invece di ricopiare le stesse quattro asserzioni sette volte.
//
// ═══ LE QUATTRO PROPRIETA' ══════════════════════════════════════════════════════════════════════════
//   ① eta' non numerica  ⇒ `skip/book-non-databile`   («il feed non dice quando ha parlato»)
//   ② fonte non live     ⇒ `skip/book-non-live`       («il prezzo e' di seconda mano»)
//   ③ eta' oltre il limite di regime ⇒ `skip/book-vecchio`
//   ④ ECCEZIONE R6: un residuo sotto il minimo del venue si chiude COMUNQUE — il capitale bloccato
//      costa piu' della perdita immediata (§5-bis p.187), ed e' una scelta di rischio esplicita.
//
// ⚠ E IL GATE NON DEVE TOCCARE IL MERGE: `decideClose` non decide il Livello 0 (lo fa `decidiLivello`),
//   quindi una coppia completa si fonde anche a libro fermo. E' la proprieta' di R8, e si verifica
//   qui **per assenza**: il gate non deve comparire sul percorso del merge.

const assert = require('assert');
const { decideClose, runAutoCloseCycle } = require('./auto-close');
const { decidiLivello } = require('./strategia-merge');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

const TOK_Y = 'tokY';
const TOK_N = 'tokN';
const MID = 0.42;

// La fixture SANA: book live, datato, fresco. Tutto il resto la modifica di un campo solo.
const regole = (over = {}) => ({
  readable: true, tick: 0.01, minSize: 20, maxSpreadCents: 4.5,
  tokenId: TOK_Y, tokenIdNo: TOK_N,
  midSource: 'live-book', midAgeSec: 3,
  books: { yes: { scoringMid: MID, bestBid: MID - 0.01, bestAsk: MID + 0.01 },
    no: { scoringMid: 1 - MID, bestBid: 1 - MID - 0.01, bestAsk: 1 - MID + 0.01 } },
  ...over,
});

// Una posizione SOPRA il minimo del venue (20): l'eccezione R6 non si applica, quindi il gate morde.
const posizione = (size = 60) => ({ tokenId: TOK_Y, size, avgPrice: 0.40 });
const decidi = (over = {}, pos = posizione()) => decideClose({
  position: pos, restingOrders: [], rules: regole(over), book: 'yes',
  venue: { bestBid: MID - 0.01, bestAsk: MID + 0.01, midPrice: MID },
});

// ══ ① ETA' NON NUMERICA ⇒ NON DATABILE ═══════════════════════════════════════════════════════════
// ⚠ `Number(null) === 0`: la SETTIMA occorrenza di questa classe nel repo e' nata proprio su questa
//   riga — un'eta' assente convertita valeva zero, cioe' «freschissimo», e il gate lasciava passare
//   esattamente il caso che esiste per fermare. Si guarda il TIPO, non si converte. Per questo
//   l'elenco qui sotto contiene i valori che `Number()` porterebbe a un numero valido.
{
  for (const eta of [undefined, null, '3', '0', NaN, Infinity, -Infinity, {}, [], true, false, '']) {
    const d = decidi({ midAgeSec: eta });
    ok(d.action === 'skip' && d.gate === 'book-non-databile',
      `① eta ${JSON.stringify(eta)} non e un numero finito ⇒ skip/book-non-databile`, `(${d.action}/${d.gate})`);
  }
  const d = decidi({ midAgeSec: undefined });
  ok(d.causa === 'prezzo-non-databile', '① ⚑ e la causa e nominata, non solo il gate', String(d.causa));
  ok(typeof d.reason === 'string' && d.reason.includes('non si vende'),
    '① il motivo dice cosa si e rifiutato di fare');
}

// ══ ② FONTE NON LIVE ⇒ CAUSA DISTINTA ════════════════════════════════════════════════════════════
// Le due cause restano separate come nel piazzatore: «di seconda mano» e «non databile» si riparano
// in modi diversi, e collassarle in un solo gate perderebbe la diagnosi.
{
  for (const fonte of ['catalogo-di-ripiego', 'gamma', 'rest', 'ultimo-noto']) {
    const d = decidi({ midSource: fonte });
    ok(d.action === 'skip' && d.gate === 'book-non-live',
      `② fonte «${fonte}» ⇒ skip/book-non-live`, `(${d.gate})`);
  }
  ok(decidi({ midSource: 'catalogo-di-ripiego' }).causa === 'fonte-non-live',
    '② ⚑ causa «fonte-non-live», distinta da «prezzo-non-databile»');
  // ⚠ La fonte si valuta PRIMA dell'eta': un prezzo di seconda mano non diventa buono perche' e' datato.
  const d = decidi({ midSource: 'gamma', midAgeSec: undefined });
  ok(d.gate === 'book-non-live',
    '② ⚑ fonte non live + eta assente ⇒ vince la fonte, la diagnosi piu specifica', `(${d.gate})`);
  // Fonte assente NON e' fonte sbagliata: il campo e' opzionale, e si passa al controllo dell'eta'.
  ok(decidi({ midSource: undefined }).gate !== 'book-non-live',
    '② `midSource` assente non e una fonte non-live: si passa al controllo dell eta');
}

// ══ ③ ETA' OLTRE IL LIMITE DI REGIME ⇒ BOOK VECCHIO ══════════════════════════════════════════════
{
  const d = decidi({ midAgeSec: 100_000 });
  ok(d.action === 'skip' && d.gate === 'book-vecchio',
    '③ eta enorme ⇒ skip/book-vecchio', `(${d.gate})`);
  ok(d.causa === 'prezzo-vecchio', '③ ⚑ causa «prezzo-vecchio»: il feed HA parlato, il dato e invecchiato');
  ok(Number.isFinite(d.midAgeSec) && d.midAgeSec === 100_000,
    '③ e l eta misurata finisce nel verdetto, non solo il rifiuto', String(d.midAgeSec));
  // ⚑ Un'eta' di ZERO e' un numero valido, non un'assenza: e' il book appena letto.
  ok(decidi({ midAgeSec: 0 }).gate !== 'book-non-databile',
    '③ ⚑ eta 0 e un book FRESCHISSIMO, non un book senza eta');
}

// ══ ④ L'ECCEZIONE R6 — IL RESIDUO SOTTO IL MINIMO SI CHIUDE COMUNQUE ═════════════════════════════
// Un residuo sotto `min_incentive_size` non e' ne' ripiazzabile ne' completabile: la sua unica
// alternativa e' aspettare la risoluzione. Fra «vendere a un prezzo forse vecchio» e «restare fermi
// per giorni» l'operatore ha scelto il primo. Se questa eccezione sparisse, il gate murerebbe capitale.
{
  const sotto = posizione(6);   // 6 share contro un minimo di 20
  for (const over of [{ midAgeSec: undefined }, { midAgeSec: 100_000 }, { midSource: 'gamma' }]) {
    const d = decidi(over, sotto);
    ok(d.gate !== 'book-non-databile' && d.gate !== 'book-vecchio' && d.gate !== 'book-non-live',
      `④ ⚑ residuo sotto il minimo: ${JSON.stringify(over)} NON lo ferma`, `(${d.action}/${d.gate || '-'})`);
  }
  // ⚠ E il minimo e' quello del VENUE, per mercato: senza `minSize` leggibile l'eccezione non si
  //   applica — non si inventa una soglia per aggirare un gate.
  const d = decidi({ midAgeSec: undefined, minSize: null }, posizione(6));
  ok(d.gate === 'book-non-databile',
    '④ ⚑ `minSize` non leggibile ⇒ nessuna eccezione: il gate resta', `(${d.gate})`);
}

// ══ ⑤ IL CONTROLLO — senza, i rifiuti qui sopra non proverebbero niente ══════════════════════════
{
  const d = decidi();
  ok(d.gate !== 'book-non-databile' && d.gate !== 'book-vecchio' && d.gate !== 'book-non-live',
    '⑤ ⚑ CONTROLLO: book live, datato e fresco ⇒ nessuno dei tre gate morde', `(${d.action}/${d.gate || '-'})`);
}

// ══ ⑥ IL GATE NON TOCCA IL MERGE (R8), e si verifica PER ASSENZA ═════════════════════════════════
// `decidiLivello` decide il Livello 0 e non passa da `decideClose`: una coppia completa si fonde anche
// a libro fermo. Se un domani qualcuno spostasse il gate piu' in su, questa asserzione cadrebbe.
{
  // ⚠ La firma e' `{ book, sizePosseduta, prezzoCarico, sizeAltroLato, … }` — letta dal sorgente, non
  //   ricordata: scrivendo questo test l'ho sbagliata una volta e il verdetto usciva `azione: 'niente'`,
  //   cioe' un rosso che sembrava un difetto della produzione e invece era mio.
  //   ⚑ E notare che `decidiLivello` non riceve `rules` AFFATTO: e' proprio questo che prova la
  //     proprieta' — il Livello 0 non ha modo di guardare l'eta' del book, quindi non puo' esserne
  //     fermato. Se un domani qualcuno gli passasse le regole per applicarci il gate, la coppia
  //     completa smetterebbe di fondersi a libro fermo e questa asserzione cadrebbe.
  const v = decidiLivello({ book: 'yes', sizePosseduta: 50, sizeAltroLato: 50, prezzoCarico: 0.40 });
  ok(v && v.azione === 'merge',
    '⑥ ⚑ coppia completa: si FONDE anche con un book non databile — R8 non e stata persa', JSON.stringify(v && v.azione));
}

// ══ ⑦ E IL GATE ARRIVA FINO AL CICLO, non solo alla decisione ════════════════════════════════════
// Il cablaggio: `runAutoCloseCycle` con un book non databile non deve mandare NESSUN ordine.
(async () => {
  const inviati = [];
  const cicloCon = async (over) => {
    inviati.length = 0;
    return runAutoCloseCycle({
      marketIds: ['0xm'],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true, reason: null }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({ ...regole(over), marketId: '0xm' }),
      listOrders: async () => ({ ok: true, orders: [] }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_Y, size: 60, avgPrice: 0.40 }] }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      placeOrder: async (o) => { inviati.push(o); return { ok: true, sent: true, orderId: 'x' }; },
      audit: () => {},
    });
  };

  const cieco = await cicloCon({ midAgeSec: undefined });
  ok(inviati.length === 0,
    '⑦ ⚑ ciclo con book non databile: ZERO ordini mandati al venue', `${inviati.length} inviati`);
  ok((cieco.actions || []).every((a) => a.action !== 'close'),
    '⑦   e nessuna azione di chiusura nel referto',
    JSON.stringify((cieco.actions || []).map((a) => a.action)));

  const sano = await cicloCon({});
  ok((sano.actions || []).length > 0,
    '⑦ ⚑ CONTROLLO: con un book databile il ciclo agisce',
    JSON.stringify((sano.actions || []).map((a) => a.action)));

  console.log(`bid databile: ${passati}/${passati} verdi, 0 rossi`);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
