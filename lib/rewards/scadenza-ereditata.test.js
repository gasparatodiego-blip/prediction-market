#!/usr/bin/env node
'use strict';
// LA SCADENZA EREDITATA DALL'EVENTO PADRE, E CIÒ CHE SUCCEDE QUANDO NON C'È NEANCHE LÌ.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// Gamma omette `endDate` sul record del singolo mercato molto più spesso di quanto la struttura dei dati
// lasci pensare. Misurato il 4 agosto 2026: sul board reward vivo, 21 mercati su 117 senza scadenza —
// venti dei quali negRisk — e TUTTI E 21 avevano la data sull'evento padre. Sulla pagina Gamma
// all'offset 300, 100 record su 100 senza `endDate` propria e 100 su 100 con quella dell'evento.
//
// Il sintomo visibile era una colonna «Scadenza» con un trattino. Il sintomo invisibile era peggiore:
// il filtro orizzonte non rifiuta mai su una scadenza ignota — e fa bene, l'assenza di una data non è
// una data breve — ma la conseguenza era che quei mercati entravano nel piano ESATTAMENTE come quelli
// con orizzonte verificato. «Non lo so» e «l'ho controllato e va bene» erano indistinguibili.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
//   1. la risoluzione della data: dal mercato, dal padre, o da nessuno — senza MAI inventarne una;
//   2. che agent24 usi davvero quel modulo e scriva la provenienza sul board (il cablaggio, non la logica);
//   3. che una scadenza ereditata sia dichiarata tale e non si confonda con una pubblicata;
//   4. che una scadenza IGNOTA continui a non essere un rifiuto — ma smetta di essere un silenzio.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planAllocation } = require('./allocator');
const { risolviScadenza } = require('./scadenza-mercato');

let n = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : ''));
  console.log('  ✓ ' + name + (extra ? ' — ' + extra : ''));
  n++;
};

const ROOT = path.resolve(__dirname, '..', '..');

// ── Il fixture minimo: un mercato finanziabile, nessuna operazione sul nastro (0 fill). ──────────────
const NOW = 1_800_000_000_000;
const iso = (giorni) => new Date(NOW + giorni * 86_400_000).toISOString();
const riga = (tsMs, mid = 0.5) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId: 'Z', tokenIdYes: 'TKZ',
  adjMid: mid, plainMid: mid, bestBid: mid - 0.01, bestAsk: mid + 0.01,
  bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: mid - 0.05, bandHigh: mid + 0.05, tick: 0.01, src: 'ws',
});
const base = () => ({
  byMarket: new Map([['Z', [riga(NOW - 86_400_000), riga(NOW)]]]),
  marketTokens: new Map([['Z', 'TKZ']]),
  tapeByToken: new Map(),
  potByCond: new Map([['Z', 100]]),
  budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
  horizonFilter: true, nowMs: NOW,
});
const candidatoZ = (piano) => (piano.candidates || []).find((c) => c.marketId === 'Z') || null;

console.log('\n══ 1 · LA DATA SI LEGGE DOVE IL VENUE LA PUBBLICA, E NON SI INVENTA MAI');
require('./scadenza-mercato').selfcheck();
n += 11;

console.log('\n══ 2 · IL CABLAGGIO: agent24 usa quel modulo e scrive la provenienza sul board');
{
  const src = fs.readFileSync(path.join(ROOT, 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  ok('agent24 IMPORTA il risolutore invece di riscriverlo in linea',
    /require\('\.\.\/lib\/rewards\/scadenza-mercato'\)/.test(src));
  ok('  e lo chiama sul record Gamma', /risolviScadenza\(m\)/.test(src));
  ok('  la scadenza del record fetchato viene da lì', /endDate:\s+scadenza\.endDate/.test(src));
  ok('  e la provenienza le viaggia accanto', /endDateSource:\s+scadenza\.endDateSource/.test(src));
  ok('  fino al record finale scritto sul board', /endDateSource:\s+m\.endDateSource/.test(src));
  // La regressione che conta: se qualcuno rimettesse `m.endDate || null` avrebbe ri-rotto tutto in
  // silenzio, perché il campo esisterebbe ancora e sarebbe ancora null.
  ok('NON è tornato a leggere solo il record del mercato', !/endDate:\s+m\.endDate \|\| null/.test(src));
}

console.log('\n══ 3 · UNA SCADENZA EREDITATA È DICHIARATA TALE (non si spaccia per pubblicata)');
{
  const piano = planAllocation({
    ...base(),
    endDateByMarket: new Map([['Z', iso(90)]]),
    endDateSourceByMarket: new Map([['Z', 'event']]),
  });
  const c = candidatoZ(piano);
  // ⚠ QUESTO BLOCCO PRETENDEVA `status === 'scelto'`, E NON ERA LA SUA PROPRIETÀ. Lo status finale lo
  // decidono gate a VALLE che con la scadenza non c'entrano — la profondità verificata via websocket
  // e il rientro calcolabile — e questa fixture non li soddisfa: nasce prima che esistessero. Quando
  // sono entrati in servizio l'asserzione è diventata rossa senza che la regola sulla scadenza fosse
  // cambiata di una virgola.
  //
  // La proprietà è nel titolo del blocco: **una scadenza ereditata è dichiarata tale**. Vive in
  // `horizon`, ed è osservabile qualunque sia lo status. E si aggiunge la metà che prima mancava —
  // la SIMMETRIA: data propria ed ereditata devono dare lo STESSO esito, e questa versione la prova
  // anche sul caso scartato, dove prima non arrivava nemmeno.
  ok('il mercato è nel piano e ha un verdetto d\'orizzonte', !!(c && c.horizon), c ? c.status : 'assente');
  ok('  la scadenza è NOTA, e il campo lo dice', c.horizon.endDateKnown === true);
  ok('  ~90 giorni alla risoluzione', Math.abs(c.horizon.days - 90) < 0.01, String(c.horizon.days));
  ok('  la provenienza è ereditata e si legge', c.horizon.source === 'event');
  ok('  e NON è marcato come orizzonte ignoto: la data c è, arriva solo da un altro posto',
    c.horizonUnknown === false);
  ok('  il piano non conta incognite', (piano.horizonUnknown || []).length === 0);

  // La stessa data pubblicata sul mercato: stesso verdetto, senza la nota di provenienza.
  const diretta = planAllocation({
    ...base(),
    endDateByMarket: new Map([['Z', iso(90)]]),
    endDateSourceByMarket: new Map([['Z', 'market']]),
  });
  const cd = candidatoZ(diretta);
  ok('data pubblicata sul mercato → stesso verdetto d\'orizzonte', cd.horizon.state === c.horizon.state);
  ok('  e la provenienza dice `market`, non `event`', cd.horizon.source === 'market');
  ok('  e nessuna nota di ereditarietà nel motivo', !/evento padre/.test(cd.reason), cd.reason);
  // ⚠ È QUESTA L'ASSERZIONE CHE CONTA, ed è più forte di prima: qualunque cosa i gate a valle
  // decidano, devono decidere UGUALE. Se un giorno la provenienza della data cambiasse la scelta,
  // cade qui — e cade sia sul caso scelto sia sul caso scartato, mentre prima copriva solo il primo.
  ok('LA SCELTA NON CAMBIA fra data propria ed ereditata: cambia solo ciò che è scritto',
    cd.capital === c.capital && cd.status === c.status && cd.horizon.days === c.horizon.days,
    `${cd.status}/${cd.capital} contro ${c.status}/${c.capital}`);
}

console.log('\n══ 4 · SENZA DATA DA NESSUNA PARTE: si ESCLUDE, e lo si dichiara');
{
  const piano = planAllocation({ ...base(), endDateByMarket: new Map(), endDateSourceByMarket: new Map() });
  const c = candidatoZ(piano);

  // ⚠⚠ QUESTO BLOCCO DIFENDEVA LA REGOLA OPPOSTA, E LA REGOLA È STATA INVERTITA IL 13 AGOSTO 2026.
  // Diceva «il mercato ENTRA comunque — l'assenza di una data non è una data breve», e per mesi è
  // stato vero. Poi la misura sul confine di rischio ha mostrato che sotto le 6 ore il 35,1% delle
  // uscite arriva DOPO la risoluzione, e il filtro d'orizzonte è diventato fail-closed: **scadenza
  // non determinabile ⇒ ESCLUDE**. Non si può chiudere una posizione su un mercato di cui non si sa
  // quando finisce.
  //
  // ⚠ E C'ERANO DUE TEST CHE DICEVANO IL CONTRARIO. `tetto-orizzonte.test.js` asserisce da allora
  // «`unknown` VIENE rifiutato: fail-closed», ed è verde; questo asseriva l'opposto ed è rimasto
  // rosso. Due prove che si contraddicono non sono due opinioni: una delle due misura il passato.
  // Questa è stata INVERTITA, non ammorbidita — stesso caso, stessa severità, verdetto opposto.
  ok('il filtro orizzonte lo ESCLUDE: una scadenza non determinabile non si indovina',
    (piano.horizonRejected || []).includes('Z'), JSON.stringify(piano.horizonRejected || []));
  ok('  e lo status finale è `scartato`', c.status === 'scartato', c.status);
  ok('  col motivo che lo dice a voce', /scadenza non leggibile/.test(c.reason), c.reason);

  // Ciò che il fix di allora ha aggiunto, e che resta: l'incognita non è più un silenzio.
  ok('lo stato dell orizzonte è «unknown», dichiarato', c.horizon && c.horizon.state === 'unknown');
  ok('  ed è marcato esplicitamente come incognita', c.horizonUnknown === true);
  ok('  la scadenza non è nota e il campo lo dice', c.horizon.endDateKnown === false);
  // ⚠ `horizonUnknown` del PIANO elenca chi è ENTRATO senza orizzonte verificato: da quando l'ignoto
  // si esclude, quell'elenco è vuoto per costruzione — e `horizonUnknownAll`, che copre l'universo
  // valutato, è dove l'incognita resta visibile. Le due liste non sono sinonimi, e la differenza è
  // esattamente il cambio di regola.
  ok('il piano non elenca incognite ENTRATE, perché l ignoto non entra più',
    (piano.horizonUnknown || []).length === 0, JSON.stringify(piano.horizonUnknown));
  ok('  ma l elenco sull intero universo valutato lo mostra ancora',
    (piano.horizonUnknownAll || []).includes('Z'), JSON.stringify(piano.horizonUnknownAll));
}

console.log('\n══ 5 · IL FILTRO ORIZZONTE CONTINUA A RIFIUTARE SOLO CIÒ CHE HA MISURATO');
{
  // ⚠ IL PAVIMENTO SI DERIVA, NON SI SCRIVE. Questa riga usava `iso(0.5)` — mezza giornata — quando
  // il pavimento d'orizzonte era 0,75 giorni. Il 13 agosto 2026 è sceso a **0,50**, e i confini sono
  // INCLUSIVI da entrambi i lati: mezza giornata è diventata esattamente il pavimento, cioè AMMESSA,
  // e l'asserzione è diventata rossa difendendo un numero invece della regola. Adesso si prende una
  // scadenza chiaramente sotto il pavimento, qualunque esso sia — così una prossima ritaratura non
  // produce un rosso che non segnala niente.
  const { MIN_HORIZON_DAYS } = require('./horizon');
  const SOTTO_IL_PAVIMENTO = MIN_HORIZON_DAYS / 2;
  const vicino = planAllocation({
    ...base(),
    endDateByMarket: new Map([['Z', iso(SOTTO_IL_PAVIMENTO)]]),
    endDateSourceByMarket: new Map([['Z', 'event']]),
  });
  const c = candidatoZ(vicino);
  ok(`scade fra ${(SOTTO_IL_PAVIMENTO * 24).toFixed(0)} h, sotto il pavimento di ${MIN_HORIZON_DAYS} g → scartato per orizzonte`,
    c.status === 'scartato' && c.reasonCode === 'orizzonte', c.reason);
  // ⚠ E IL CONFINE È INCLUSIVO: esattamente al pavimento NON si rifiuta. Senza questa riga il blocco
  // resterebbe verde anche se il filtro diventasse più stretto di quanto §4.4 dichiara.
  {
    const alPelo = planAllocation({
      ...base(),
      endDateByMarket: new Map([['Z', iso(MIN_HORIZON_DAYS)]]),
      endDateSourceByMarket: new Map([['Z', 'event']]),
    });
    ok(`  ma esattamente a ${MIN_HORIZON_DAYS} g NON si rifiuta: il confine è inclusivo`,
      !(alPelo.horizonRejected || []).includes('Z'), JSON.stringify(alPelo.horizonRejected || []));
  }
  ok('  e NON è contato fra le incognite: qui si sa benissimo, ed è breve', c.horizonUnknown === false);
  ok('  il piano lo elenca fra i rifiuti per orizzonte', (vicino.horizonRejected || []).includes('Z'));

  // Con il filtro spento nulla viene rifiutato, ma l'incognita resta dichiarata: sono due assi diversi.
  const spento = planAllocation({ ...base(), horizonFilter: false, endDateByMarket: new Map(), endDateSourceByMarket: new Map() });
  const cs = candidatoZ(spento);
  ok('filtro spento → nessun rifiuto per orizzonte', (spento.horizonRejected || []).length === 0);
  ok('  ma l incognita è dichiarata lo stesso: dire e decidere sono due cose diverse',
    cs.horizonUnknown === true && (spento.horizonUnknown || []).includes('Z'));
}

console.log('\n══ 6 · IL BOARD VIVO, SE C È: quante scadenze ereditate e quante ancora ignote');
{
  // Non fa fallire nulla — il board è uno stato del mondo, non un'asserzione sul codice. Ma se agent24
  // ha già girato con il fix, questa riga è la misura che chiude il cerchio.
  let board = null;
  try { board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8')); } catch { /* assente */ }
  if (board && Array.isArray(board.markets)) {
    const tot = board.markets.length;
    const propria = board.markets.filter((m) => m.endDateSource === 'market').length;
    const ereditata = board.markets.filter((m) => m.endDateSource === 'event').length;
    const ignote = board.markets.filter((m) => !m.endDate).length;
    console.log(`      board: ${tot} mercati · ${propria} data propria · ${ereditata} ereditata · ${ignote} ancora senza`);
    ok('nessun mercato ha una provenienza senza la data corrispondente',
      board.markets.every((m) => !m.endDateSource || !!m.endDate));
    ok('  e nessuna data senza provenienza, se agent24 ha già rigirato col fix',
      ereditata + propria === 0 || board.markets.every((m) => !m.endDate || !!m.endDateSource),
      ereditata + propria === 0 ? 'board ancora precedente al fix — atteso' : 'board rigenerato');
  } else {
    console.log('      board assente o illeggibile — la misura si salta, non si inventa');
  }
}

console.log(`\nscadenza ereditata: ${n} asserzioni passate`);
