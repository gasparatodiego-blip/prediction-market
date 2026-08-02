#!/usr/bin/env node
'use strict';
// FUORI BANDA: AVVISO, NON DIVIETO.
//
// Un prezzo fuori dalla banda premiante non viola nessuna regola del venue — l'exchange lo accetta e
// l'ordine riposa. Semplicemente non matura reward. Questo test tiene ferma quella distinzione nei due
// punti dove viveva confusa: la funzione condivisa che separa i motivi bloccanti da quelli dichiarati, e
// il verdetto che il pannello dipinge sopra il campo del prezzo.
//
// NIENTE FILE, NIENTE VENUE, NESSUN ORDINE: entrambe le funzioni sono pure.

const fs = require('fs');
const path = require('path');
const V = require('./venue-rules');
const B = require('./book-view');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// Banda ±2.25¢ attorno a 50¢, tick 1¢, size minima 50.
const RULES = { tick: 0.01, scoringMid: 0.50, maxSpreadCents: 4.5, minSize: 50 };
const codes = (v) => v.reasons.map((r) => r.code).sort().join(',');

console.log('\n── il default resta severo: nessuno eredita la deroga senza chiederla');
{
  const strict = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.30, size: 100 }));
  ok('30¢ contro mid 50¢ e fuori banda', strict.outOfBand === true);
  ok('  e senza deroga RIFIUTA, come prima', strict.valid === false);
  ok('  col motivo ancora fra i bloccanti', codes(strict) === 'OUT_OF_BAND');
  ok('  e nessun avviso declassato', strict.advisories.length === 0);
}

console.log('\n── con la deroga: passa, e il motivo non sparisce');
{
  const v = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.30, size: 100 }), { allowOutOfBand: true });
  ok('30¢ ora e PIAZZABILE', v.valid === true);
  ok('  nessun motivo bloccante', v.reasons.length === 0);
  ok('  ma OUT_OF_BAND e conservato come avviso', v.advisories.length === 1 && v.advisories[0].code === 'OUT_OF_BAND');
  ok('  con il dettaglio, non solo il codice', /exceeds the reward band/.test(v.advisories[0].detail || ''));
  ok('  e outOfBand resta true: il fatto non viene negato', v.outOfBand === true);
}

console.log('\n── IL TICK NON E COPERTO DALLA DEROGA. E una regola vera del venue.');
{
  // 0.305 non e multiplo di 1¢: l exchange lo rifiuterebbe comunque, quindi rifiutarlo qui non e
  // paternalismo, e dire la verita prima invece che dopo.
  const v = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.305, size: 100 }), { allowOutOfBand: true });
  ok('fuori griglia del tick ⇒ RIFIUTATO anche con la deroga', v.valid === false);
  ok('  il tick resta fra i bloccanti', v.reasons.some((r) => r.code === 'OFF_TICK'));
  ok('  e il fuori-banda che lo accompagna scende ad avviso', v.advisories.some((r) => r.code === 'OUT_OF_BAND'));
  ok('  quindi il rifiuto NON nomina la banda', !/OUT_OF_BAND/.test(codes(v)), codes(v));
}

console.log('\n── gli altri codici restano bloccanti uno per uno');
{
  const size = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.49, size: 10 }), { allowOutOfBand: true });
  ok('sotto min_incentive_size ⇒ rifiutato', size.valid === false && size.reasons.some((r) => r.code === 'BELOW_MIN_SIZE'));
  const range = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.999, size: 100 }), { allowOutOfBand: true });
  ok('fuori dai limiti di prezzo del venue ⇒ rifiutato', range.valid === false && range.reasons.some((r) => r.code === 'PRICE_OUT_OF_RANGE'));
  const unread = V.splitVerdict(V.validateQuote({ tick: null }, { side: 'BUY', price: 0.49, size: 100 }), { allowOutOfBand: true });
  ok('regole illeggibili ⇒ rifiutato (fail closed intatto)', unread.valid === false && unread.reasons.some((r) => r.code === 'RULES_UNREADABLE'));
}

console.log('\n── una quota buona resta buona, e non guadagna avvisi');
{
  const v = V.splitVerdict(V.validateQuote(RULES, { side: 'BUY', price: 0.49, size: 100 }), { allowOutOfBand: true });
  ok('49¢ dentro banda ⇒ valida', v.valid === true);
  ok('  senza avvisi inventati', v.advisories.length === 0 && v.outOfBand === false);
}

console.log('\n── «nessun motivo bloccante» e «nessun motivo letto» hanno la stessa forma: una lista vuota');
{
  // E sono l opposto l uno dell altro. Senza un controllo esplicito, un verdetto assente uscirebbe
  // valido proprio quando la deroga e accesa — cioe il fail-open si aprirebbe solo sul percorso nuovo.
  for (const bad of [null, undefined, {}, { valid: true }, { valid: true, reasons: 'niente' }]) {
    const strict = V.splitVerdict(bad);
    const loose = V.splitVerdict(bad, { allowOutOfBand: true });
    ok(`  verdetto ${JSON.stringify(bad)} ⇒ rifiutato in entrambi i modi`,
      strict.valid === false && loose.valid === false);
  }
  ok('  e il motivo dice che non e stato letto, non che e fuori banda',
    V.splitVerdict(null, { allowOutOfBand: true }).reasons[0].code === 'RULES_UNREADABLE');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL VERDETTO SULLO SCHERMO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── il pannello: giallo per «non matura», rosso solo per «non e quello che credi»');
{
  // Fuori banda e basta: resta sul book come maker, non incrocia niente.
  const oob = B.priceVerdict({ price: 0.30, bestBid: 0.29, bestAsk: 0.31, scoringMid: 0.50, bandRadiusCents: 2.25, side: 'BUY' });
  ok('fuori banda ⇒ livello «warn», non «bad»', oob.level === 'warn', oob.level);
  ok('  il messaggio resta e nomina il costo', /NON matura reward/.test(oob.messages.join(' ')));
  ok('  e dice espressamente che si puo piazzare', /avviso, non un blocco/.test(oob.messages.join(' ')),
    oob.messages.join(' ').slice(-60));
  ok('  senza fingere che incroci', oob.crosses === false);

  // Incrocio: l ordine si eseguirebbe subito invece di riposare. Questo resta rosso.
  const cross = B.priceVerdict({ price: 0.51, bestBid: 0.49, bestAsk: 0.51, scoringMid: 0.50, bandRadiusCents: 2.25, side: 'BUY' });
  ok('incrocio ⇒ resta «bad»', cross.level === 'bad', cross.level);

  // Tutti e due: vince il rosso, perche il fatto piu grave e che l ordine non riposerebbe affatto.
  const both = B.priceVerdict({ price: 0.70, bestBid: 0.60, bestAsk: 0.65, scoringMid: 0.50, bandRadiusCents: 2.25, side: 'BUY' });
  ok('incrocio + fuori banda ⇒ «bad»', both.level === 'bad', both.level);
  ok('  e dice entrambe le cose, non una sola', both.messages.length === 2, `${both.messages.length} messaggi`);

  const good = B.priceVerdict({ price: 0.49, bestBid: 0.48, bestAsk: 0.52, scoringMid: 0.50, bandRadiusCents: 2.25, side: 'BUY' });
  ok('dentro banda e senza incrocio ⇒ «ok»', good.level === 'ok', good.level);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL CABLAGGIO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Queste asserzioni leggono il SORGENTE: la catena vera (route → placeManualOrder → adapter) tocca
// audit durevoli e costruisce un adapter di venue, quindi eseguirla qui scriverebbe righe finte nel
// registro di produzione. Quello che si verifica e piu' modesto e dichiarato: che la deroga sia
// CABLATA in tutti i punti che la richiedono. Il comportamento vero e' coperto dall E2E sul pannello.
console.log('\n── il cablaggio, punto per punto (lettura del sorgente)');
{
  const rd = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../../app/api/maker/manual/order/route.ts'), 'utf8');
  ok('la route accetta acknowledgeOutOfBand', /acknowledgeOutOfBand: z\.boolean\(\)\.optional\(\)/.test(route));
  ok('  e lo traduce in allowOutOfBand per il piazzamento', /allowOutOfBand: acknowledgeOutOfBand === true/.test(route));
  const mo = rd('manual-order.js');
  ok('manual-order usa la funzione condivisa', /splitVerdict\(validateQuote\(venueRules/.test(mo));
  ok('  e porta la deroga fino all adapter', /allowOutOfBand,/.test(mo));
  ok('  registrando l avviso nell audit', /bandAdvisory/.test(mo));
  const ad = fs.readFileSync(path.join(__dirname, '../venues/polymarket-clob-maker/adapter.js'), 'utf8');
  ok('l adapter usa la STESSA funzione, non un filtro suo', /splitVerdict\(split, \{ allowOutOfBand: s\.allowOutOfBand === true \}\)/.test(ad));
  ok('  e nessuno dei tre file filtra OUT_OF_BAND a mano',
    !/code !== 'OUT_OF_BAND'/.test(mo + ad + rd('mm-tracking.js')));
  const panel = fs.readFileSync(path.join(__dirname, '../../app/components/OrderPanel.tsx'), 'utf8');
  ok('il pannello dichiara di aver mostrato il costo', /acknowledgeOutOfBand: true/.test(panel));
}

console.log(`\nfuori banda come avviso: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
