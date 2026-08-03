#!/usr/bin/env node
'use strict';
// LE RIGHE ESEGUIBILI SONO LE STESSE CHE VEDE L'OPERATORE — E DEVONO RESTARLO.
//
// Questo modulo esiste perché il riallocatore periodico non ha un browser che gli costruisca le righe.
// Il rischio è ovvio: due copie della stessa regola, in due linguaggi, che divergono in silenzio. Il
// piano calcolato dallo scheduler manderebbe al venue righe che il pannello avrebbe escluso, e nessuno
// se ne accorgerebbe finché non arriva l'estratto conto.
//
// Perciò metà di questo file non prova il comportamento: LEGGE IL SORGENTE DEL PANNELLO e verifica che i
// predicati siano ancora quelli. Se qualcuno cambia il filtro in RewardsAllocatePanel.tsx e non cambia
// plan-to-orders.js, questi test si rompono e obbligano ad allineare le due copie.

const fs = require('fs');
const path = require('path');
const { planToOrders, rowAt, STALE_S } = require('./plan-to-orders');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const PANNELLO = path.join(__dirname, '..', '..', 'app', 'components', 'RewardsAllocatePanel.tsx');
const ORA = Date.parse('2026-08-03T12:00:00Z');

/** Una riga di piano sana: in banda, fresca, con size. */
function riga(over = {}) {
  return {
    marketId: '0x' + 'a1'.repeat(32), name: 'Mercato sano',
    mid: 0.5, tick: 0.01, newestTsMs: ORA - 30_000,
    maxSpreadCents: 4, computedDefaultOffsetTicks: 1,
    sizePerSideShares: 123.456, grossInBandPerDay: 10, belowVenueMinSize: false,
    fillsByTick: [{ tick: 1, bid: 0.49, ask: 0.51 }, { tick: 2, bid: 0.48, ask: 0.52 }],
    ...over,
  };
}

console.log('\n══ IL PANNELLO E QUESTO MODULO DICONO LA STESSA COSA');
{
  const src = fs.readFileSync(PANNELLO, 'utf8');

  const m = src.match(/const STALE_S\s*=\s*(\d+)/);
  ok('la soglia di stantio e la stessa del pannello', m && Number(m[1]) === STALE_S, `pannello ${m && m[1]}, modulo ${STALE_S}`);

  // Il filtro del pannello, riga per riga. Se cambia, questa asserzione cade.
  const filtro = src.includes("x.usable && x.c.inBand !== false && x.c.bid != null && x.r.sizePerSideShares != null");
  ok('il filtro di bulkRows e ancora usable + inBand + bid + size', filtro);

  // I quattro campi che il pannello manda a bulk-allocate, e nient'altro.
  for (const campo of ['marketId', 'title', "book: 'yes' as const", 'price', 'size']) {
    ok(`  il pannello manda ancora «${campo.split(':')[0]}»`, src.includes(campo));
  }
  ok('  e arrotonda la size a un decimale come qui',
    src.includes('Math.round((x.r.sizePerSideShares as number) * 10) / 10'));

  // La definizione di «illeggibile» e di «stantio» nel pannello.
  ok('«illeggibile» nel pannello e ancora mid/tick/newestTsMs assenti',
    src.includes('r.mid == null || r.tick == null || r.newestTsMs == null'));
  ok('«stantio» nel pannello e ancora eta > STALE_S',
    src.includes('const stale = !unreadable && ageS != null && ageS > STALE_S'));
}

console.log('\n══ UNA RIGA SANA DIVENTA UN ORDINE');
{
  const r = planToOrders({ rows: [riga()] }, { nowMs: ORA });
  ok('una riga sola, eseguibile', r.rows.length === 1 && r.scartate.length === 0);
  ok('  al bid del tick di difetto', r.rows[0].price === 0.49);
  ok('  con la size arrotondata a un decimale', r.rows[0].size === 123.5, String(r.rows[0].size));
  ok('  sempre sul libro yes', r.rows[0].book === 'yes');
  ok('  e il capitale impegnato e prezzo x size', r.totals.capitaleUsd === +(0.49 * 123.5).toFixed(2), String(r.totals.capitaleUsd));
}

console.log('\n══ LE QUATTRO ESCLUSIONI, E NESSUNA E SILENZIOSA');
{
  const casi = [
    ['illeggibile', riga({ mid: null })],
    ['illeggibile', riga({ tick: null })],
    ['illeggibile', riga({ newestTsMs: null })],
    ['stantio', riga({ newestTsMs: ORA - (STALE_S + 1) * 1000 })],
    ['fuori-banda', riga({ maxSpreadCents: 1 })],                       // raggio 0.5c, offset 1c
    ['senza-bid', riga({ fillsByTick: [] })],
    ['senza-size', riga({ sizePerSideShares: null })],
  ];
  for (const [motivo, rg] of casi) {
    const r = planToOrders({ rows: [rg] }, { nowMs: ORA });
    ok(`«${motivo}» esclude la riga`, r.rows.length === 0 && r.scartate.length === 1 && r.scartate[0].motivo === motivo,
      r.scartate[0] ? r.scartate[0].motivo : 'nessuno scarto');
    ok('  e la nomina con mercato e dettaglio', !!(r.scartate[0] && r.scartate[0].marketId && r.scartate[0].dettaglio));
  }
}

console.log('\n══ UN PIANO MISTO DICE QUANTI NE HA LASCIATI FUORI');
{
  const r = planToOrders({
    rows: [riga(), riga({ marketId: '0x' + 'b2'.repeat(32), mid: null }), riga({ marketId: '0x' + 'c3'.repeat(32), sizePerSideShares: null })],
  }, { nowMs: ORA });
  ok('tre candidati, uno eseguibile, due scartati',
    r.totals.candidate === 3 && r.totals.eseguibili === 1 && r.totals.scartate === 2,
    JSON.stringify(r.totals));
  ok('un piano da 3 che ne esegue 1 non si presenta come un piano da 1', r.scartate.length === 2);
}

console.log('\n══ IL LIMITE DI ETA NON SI APPROSSIMA A FAVORE');
{
  const alPelo = planToOrders({ rows: [riga({ newestTsMs: ORA - STALE_S * 1000 })] }, { nowMs: ORA });
  ok('esattamente alla soglia la riga vive ancora', alPelo.rows.length === 1);
  const oltre = planToOrders({ rows: [riga({ newestTsMs: ORA - (STALE_S * 1000 + 1) })] }, { nowMs: ORA });
  ok('un millisecondo oltre, no', oltre.rows.length === 0);
}

console.log('\n══ rowAt AZZERA IL LORDO DOVE IL VENUE LO AZZERA');
{
  ok('sotto la size minima del venue il lordo e zero, non «non so»',
    rowAt(riga({ belowVenueMinSize: true }), 1).gross === 0);
  ok('fuori banda idem', rowAt(riga({ maxSpreadCents: 1 }), 1).gross === 0);
  ok('senza banda pubblicata il lordo resta quello del piano e inBand resta ignoto',
    rowAt(riga({ maxSpreadCents: null }), 1).inBand === null);
}

console.log('\n══ UN PIANO VUOTO O ASSENTE NON ESPLODE E NON INVENTA');
{
  for (const [nome, p] of [['null', null], ['senza rows', {}], ['rows vuote', { rows: [] }]]) {
    const r = planToOrders(p, { nowMs: ORA });
    ok(`piano ${nome}: zero righe, zero scarti, zero capitale`,
      r.rows.length === 0 && r.scartate.length === 0 && r.totals.capitaleUsd === 0);
  }
}

console.log(`\npiano → ordini: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
