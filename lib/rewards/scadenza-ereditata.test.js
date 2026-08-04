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
  ok('il mercato entra nel piano', c && c.status === 'scelto', c ? c.status : 'assente');
  ok('  l orizzonte è misurato, non ignoto', c.horizon && c.horizon.state === 'ok', c.horizon && c.horizon.state);
  ok('  ~90 giorni alla risoluzione', Math.abs(c.horizon.days - 90) < 0.01, String(c.horizon.days));
  ok('  la provenienza è ereditata e si legge', c.horizon.source === 'event');
  ok('  il motivo della scelta lo DICE', /data dell'evento padre/.test(c.reason), c.reason);
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
  ok('data pubblicata sul mercato → stesso stato', cd.horizon.state === 'ok' && cd.horizon.source === 'market');
  ok('  e nessuna nota di ereditarietà nel motivo', !/evento padre/.test(cd.reason), cd.reason);
  ok('LA SCELTA NON CAMBIA fra data propria ed ereditata: cambia solo ciò che è scritto',
    cd.capital === c.capital && cd.status === c.status);
}

console.log('\n══ 4 · SENZA DATA DA NESSUNA PARTE: non è un rifiuto, ma non è più un silenzio');
{
  const piano = planAllocation({ ...base(), endDateByMarket: new Map(), endDateSourceByMarket: new Map() });
  const c = candidatoZ(piano);

  // La regola di sempre, invariata: `unknown` non rifiuta. Questa è la riga che protegge il
  // comportamento corretto dal fix stesso.
  ok('il mercato ENTRA comunque — l assenza di una data non è una data breve', c.status === 'scelto');
  ok('  e non compare fra gli scarti per orizzonte', (piano.horizonRejected || []).length === 0);

  // Ciò che prima non c'era.
  ok('lo stato dell orizzonte è «unknown», dichiarato', c.horizon && c.horizon.state === 'unknown');
  ok('  ed è marcato esplicitamente come incognita', c.horizonUnknown === true);
  ok('  la scadenza non è nota e il campo lo dice', c.horizon.endDateKnown === false);
  ok('  IL MOTIVO DELLA SCELTA LO DICHIARA a voce', /SCADENZA IGNOTA/.test(c.reason), c.reason);
  ok('  e dice pure che il controllo non è stato eseguito, non che è stato superato',
    /filtro orizzonte non applicabile/.test(c.reason));
  ok('il piano elenca il mercato fra quelli entrati senza orizzonte verificato',
    (piano.horizonUnknown || []).includes('Z'), JSON.stringify(piano.horizonUnknown));
  ok('  e l elenco esiste anche sull intero universo valutato',
    (piano.horizonUnknownAll || []).includes('Z'));
}

console.log('\n══ 5 · IL FILTRO ORIZZONTE CONTINUA A RIFIUTARE SOLO CIÒ CHE HA MISURATO');
{
  // Una scadenza vera e vicina: questo sì che è un rifiuto, e deve restare tale.
  const vicino = planAllocation({
    ...base(),
    endDateByMarket: new Map([['Z', iso(0.5)]]),
    endDateSourceByMarket: new Map([['Z', 'event']]),
  });
  const c = candidatoZ(vicino);
  ok('scade fra mezza giornata → scartato per orizzonte', c.status === 'scartato' && c.reasonCode === 'orizzonte', c.reason);
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
