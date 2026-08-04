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
const { planToOrders, rowAt, troncaShare, STALE_S } = require('./plan-to-orders');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const PANNELLO = path.join(__dirname, '..', '..', 'app', 'components', 'RewardsAllocatePanel.tsx');
const ORA = Date.parse('2026-08-03T12:00:00Z');

/** Una riga di piano sana: in banda, fresca, con size e con il capitale che il piano le assegna. */
function riga(over = {}) {
  return {
    marketId: '0x' + 'a1'.repeat(32), name: 'Mercato sano',
    mid: 0.5, tick: 0.01, newestTsMs: ORA - 30_000,
    maxSpreadCents: 4, computedDefaultOffsetTicks: 1,
    capital: 100,
    sizePerSideShares: 123.456, grossInBandPerDay: 10, belowVenueMinSize: false,
    minSizeShares: null,
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

  // ── UNA SOLA COSTRUZIONE DELLE GAMBE, NON DUE COPIE ─────────────────────────────────────────
  // Prima il pannello costruiva le righe da se' e ne mandava UNA per mercato (`book: 'yes' as const`),
  // mentre questo modulo ne emetteva due: due percorsi, due comportamenti, un estratto conto solo.
  // Adesso il pannello IMPORTA `gambeDiUnaRiga` da qui. Queste asserzioni sono cio' che impedisce
  // alla divergenza di tornare in silenzio.
  ok('il pannello importa la costruzione delle gambe da questo modulo',
    src.includes("import { gambeDiUnaRiga } from '@/lib/rewards/plan-to-orders'"));
  ok('  e la chiama con l offset scelto dall operatore',
    src.includes('gambeDiUnaRiga(x.r, offsets[x.r.marketId] ?? x.r.computedDefaultOffsetTicks)'));
  ok('  il pannello NON costruisce piu una riga a mano con book yes',
    !src.includes("book: 'yes' as const"),
    'se questa asserzione cade, il pannello e tornato a un lato solo');
  ok('  ne arrotonda piu la size per conto suo',
    !src.includes('Math.round((x.r.sizePerSideShares as number) * 10) / 10'));
  ok('  e i rifiuti di gambeDiUnaRiga diventano esclusioni dichiarate, non ordini silenziosi',
    src.includes('if (g.scarto)') && src.includes('bulk.scartate'));

  // La definizione di «illeggibile» e di «stantio» nel pannello.
  ok('«illeggibile» nel pannello e ancora mid/tick/newestTsMs assenti',
    src.includes('r.mid == null || r.tick == null || r.newestTsMs == null'));
  ok('«stantio» nel pannello e ancora eta > STALE_S',
    src.includes('const stale = !unreadable && ageS != null && ageS > STALE_S'));
}

console.log('\n══ UNA RIGA SANA DIVENTA DUE ORDINI, UNO PER LATO');
{
  const r = planToOrders({ rows: [riga()] }, { nowMs: ORA });
  ok('un mercato, DUE righe', r.rows.length === 2 && r.scartate.length === 0, JSON.stringify(r.totals));
  ok('  la prima e un BUY sul libro YES', r.rows[0].book === 'yes' && r.rows[0].side === 'BUY');
  ok('  la seconda e un BUY sul libro NO', r.rows[1].book === 'no' && r.rows[1].side === 'BUY');
  ok('  nessuna delle due e una VENDITA (non serve inventario)', r.rows.every((x) => x.side === 'BUY'));
  ok('  YES a mid - offset', r.rows[0].price === 0.49, String(r.rows[0].price));
  ok('  NO a (1 - mid) - offset, che sul libro YES E un ask a mid + offset',
    r.rows[1].price === 0.49, String(r.rows[1].price));
  ok('  share UGUALI sui due lati', r.rows[0].size === r.rows[1].size, `${r.rows[0].size} vs ${r.rows[1].size}`);
  ok('  entrambe portano la stessa coppia', r.rows[0].coppia === r.rows[1].coppia && r.rows[0].coppia === riga().marketId);
  ok('  e la gamba e nominata', r.rows[0].gamba === 'yes' && r.rows[1].gamba === 'no');
  ok('«eseguibili» conta i MERCATI, «righe» le gambe', r.totals.eseguibili === 1 && r.totals.righe === 2, JSON.stringify(r.totals));
}

console.log('\n══ IL CAPITALE DELLA RIGA NON VIENE RADDOPPIATO: VIENE DIVISO');
{
  // E il caso che il tetto del 30% per mercato dipende: due gambe da $100 ciascuna sarebbero $200 su
  // una riga che ne ha $100, cioe il doppio del tetto.
  const r = planToOrders({ rows: [riga({ capital: 100 })] }, { nowMs: ORA });
  ok('la somma delle due gambe NON supera il capitale della riga',
    r.totals.capitaleUsd <= 100 + 1e-9, `$${r.totals.capitaleUsd} su $100`);
  ok('  e non e nemmeno la meta sprecata: ci va quasi tutto',
    r.totals.capitaleUsd > 99, `$${r.totals.capitaleUsd}`);
  ok('  Q = capitale / (p_yes + p_no)', r.rows[0].size === troncaShare(100 / (0.49 + 0.49)), String(r.rows[0].size));

  // La stessa cosa su un mercato LONTANO da 50c, dove l'errore sarebbe enorme: a mid 0.055 il lato NO
  // costa 0.935 per share, non 0.055, e sizePerSideShares del modello e 17x quello che il capitale compra.
  const basso = planToOrders({ rows: [riga({
    mid: 0.055, tick: 0.001, capital: 195, maxSpreadCents: 5.5, computedDefaultOffsetTicks: 10,
    sizePerSideShares: 1772.7, fillsByTick: [{ tick: 10, bid: 0.045, ask: 0.065 }],
  })] }, { nowMs: ORA });
  ok('mercato a 5,5c: due gambe, e il capitale resta dentro',
    basso.rows.length === 2 && basso.totals.capitaleUsd <= 195 + 1e-9, JSON.stringify(basso.totals));
  ok('  le share REALI sono una frazione di quelle che il piano prometteva',
    basso.coppie[0].shareReali < basso.coppie[0].sharePiano / 5,
    `reali ${basso.coppie[0].shareReali} contro piano ${basso.coppie[0].sharePiano} (rapporto ${basso.coppie[0].rapportoSize})`);
  ok('  e il rapporto e dichiarato nella coppia, non nascosto', basso.coppie[0].rapportoSize > 0 && basso.coppie[0].rapportoSize < 1);
}

console.log('\n══ UN LATO SOLO NON SI PIAZZA MAI');
{
  // Offset piu largo del mid: il lato YES finirebbe a prezzo negativo. Prima si sarebbe piazzato il
  // solo lato che restava; adesso non si piazza niente.
  const r = planToOrders({ rows: [riga({
    mid: 0.02, tick: 0.01, capital: 100, maxSpreadCents: 10, computedDefaultOffsetTicks: 3,
    fillsByTick: [{ tick: 3, bid: -0.01, ask: 0.05 }],
  })] }, { nowMs: ORA });
  ok('un lato non piazzabile scarta il MERCATO, non solo quel lato',
    r.rows.length === 0 && r.scartate.length === 1 && r.scartate[0].motivo === 'gamba-impossibile',
    r.scartate[0] ? r.scartate[0].motivo : 'nessuno scarto');
  ok('  e il motivo spiega perche un lato solo non basta',
    /un lato solo/.test(r.scartate[0].dettaglio), r.scartate[0].dettaglio);
}

console.log('\n══ SOTTO LA SIZE MINIMA PREMIANTE NON SI PIAZZA NIENTE');
{
  const r = planToOrders({ rows: [riga({ capital: 100, minSizeShares: 500 })] }, { nowMs: ORA });
  ok('share reali sotto il minimo del venue ⇒ mercato scartato',
    r.rows.length === 0 && r.scartate[0].motivo === 'sotto-size-minima', JSON.stringify(r.scartate));
  ok('  e il motivo dice che a due lati un lato sotto minimo azzera anche l altro',
    /azzera anche l'altro/.test(r.scartate[0].dettaglio));
  const ok2 = planToOrders({ rows: [riga({ capital: 100, minSizeShares: 50 })] }, { nowMs: ORA });
  ok('  sopra il minimo passa regolarmente', ok2.rows.length === 2);
}

console.log('\n══ SENZA CAPITALE NON SI INVENTA UNA SIZE');
{
  for (const [nome, cap] of [['null', null], ['zero', 0], ['negativo', -5]]) {
    const r = planToOrders({ rows: [riga({ capital: cap })] }, { nowMs: ORA });
    ok(`capitale ${nome} ⇒ scartato, non dimensionato a caso`,
      r.rows.length === 0 && r.scartate[0].motivo === 'senza-capitale');
  }
}

console.log('\n══ LE SHARE SI TRONCANO, NON SI ARROTONDANO PER ECCESSO');
{
  ok('troncaShare(12.99) = 12.9, non 13', troncaShare(12.99) === 12.9, String(troncaShare(12.99)));
  ok('troncaShare(0.04) = 0 (e non un ordine da zero share)', troncaShare(0.04) === 0);
  ok('troncaShare di un non numero = 0', troncaShare(null) === 0 && troncaShare(NaN) === 0);
  // Arrotondare per eccesso farebbe superare il capitale della riga, cioe il tetto per mercato.
  const r = planToOrders({ rows: [riga({ capital: 99.99 })] }, { nowMs: ORA });
  ok('  e il capitale impegnato non supera MAI quello della riga', r.totals.capitaleUsd <= 99.99 + 1e-9,
    `$${r.totals.capitaleUsd} su $99.99`);
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
  ok('tre candidati, un MERCATO eseguibile (due gambe), due scartati',
    r.totals.candidate === 3 && r.totals.eseguibili === 1 && r.totals.righe === 2 && r.totals.scartate === 2,
    JSON.stringify(r.totals));
  ok('un piano da 3 che ne esegue 1 non si presenta come un piano da 1', r.scartate.length === 2);
}

console.log('\n══ IL LIMITE DI ETA NON SI APPROSSIMA A FAVORE');
{
  const alPelo = planToOrders({ rows: [riga({ newestTsMs: ORA - STALE_S * 1000 })] }, { nowMs: ORA });
  ok('esattamente alla soglia la riga vive ancora', alPelo.rows.length === 2);
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
