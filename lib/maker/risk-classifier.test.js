#!/usr/bin/env node
'use strict';
// SAFE O RISK — E LE SOGLIE NON SONO SCRITTE QUI DENTRO DUE VOLTE.
//
// Questo file verifica tre cose, in quest'ordine di importanza:
//   1. che le soglie usate dal classificatore siano ESATTAMENTE quelle dei moduli che le possedevano
//      già (order-ttl, horizon, plan-to-orders) — non un numero riscritto che gli somiglia;
//   2. che ciascuna delle tre regole scatti da sola, e che le combinazioni si sommino invece di
//      mascherarsi;
//   3. che «non lo so» non finisca nel bucket Safe, che è il modo in cui del capitale non giudicato
//      passa per capitale che sta maturando.

const {
  classifyRisk, bucketizza, filtraPerProfilo, etichettaScadenza,
  VENUE_FLOOR_MINUTES, SAFE_FLOOR_MINUTES, STALE_SECONDS,
  FLAG_FUORI_BANDA, FLAG_STALE, FLAG_SOTTO_PAVIMENTO, FLAG_PRIMO_SUL_BOOK,
} = require('./risk-classifier');
const { VENUE_GTD_MIN_FUTURE_SEC } = require('./order-ttl');
const { MIN_HORIZON_DAYS } = require('../rewards/horizon');
const { STALE_S } = require('../rewards/plan-to-orders');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ORA = Date.parse('2026-08-06T12:00:00Z');
const opts = { nowMs: ORA };

/** Un ordine a riposo senza NIENTE che non vada: in banda, lontano dalla scadenza, dato fresco. */
const sano = (over = {}) => ({
  marketId: '0x' + 'ab'.repeat(32),
  price: 0.50, bandLo: 0.48, bandHi: 0.52,
  hoursToResolution: 24 * 30,
  dataAgeSec: 12,
  restingNotionalUsd: 100,
  ...over,
});

console.log('\n══ LE SOGLIE VENGONO DA DOVE DICONO DI VENIRE');
{
  ok('il pavimento del venue è VENUE_GTD_MIN_FUTURE_SEC, in minuti',
    VENUE_FLOOR_MINUTES === VENUE_GTD_MIN_FUTURE_SEC / 60 && VENUE_FLOOR_MINUTES === 3,
    `${VENUE_FLOOR_MINUTES} min`);
  ok('la soglia Safe è MIN_HORIZON_DAYS, in minuti',
    SAFE_FLOOR_MINUTES === MIN_HORIZON_DAYS * 24 * 60 && SAFE_FLOOR_MINUTES === 2880,
    `${SAFE_FLOOR_MINUTES} min`);
  ok('la soglia di staleness è STALE_S di plan-to-orders',
    STALE_SECONDS === STALE_S && STALE_SECONDS === 300,
    `${STALE_SECONDS} s`);
}

console.log('\n══ IL CASO SAFE');
{
  const r = classifyRisk(sano(), opts);
  ok('nessun flag', r.isRisk === false && r.flags.length === 0);
  ok('  e nessuna incognita', r.unknowns.length === 0, JSON.stringify(r.unknowns));
  ok('  ed è piazzabile', r.tradable === true);
}

console.log('\n══ FUORI BANDA');
{
  const sopra = classifyRisk(sano({ price: 0.55 }), opts);
  ok('prezzo oltre bandHi ⇒ risk', sopra.isRisk === true && sopra.flags.includes(FLAG_FUORI_BANDA));
  const sotto = classifyRisk(sano({ price: 0.40 }), opts);
  ok('prezzo sotto bandLo ⇒ risk', sotto.isRisk === true && sotto.flags.includes(FLAG_FUORI_BANDA));
  const bordo = classifyRisk(sano({ price: 0.52 }), opts);
  ok('esattamente sul bordo ⇒ dentro (non si scarta per un epsilon)', bordo.isRisk === false);

  // Il verdetto già pronto di operator-board vince sul ricalcolo: è quello che l'operatore vede.
  const pronto = classifyRisk({ ...sano(), outOfBand: true }, opts);
  ok('outOfBand:true del board è rispettato anche se prezzo e banda direbbero il contrario',
    pronto.flags.includes(FLAG_FUORI_BANDA));
  const prontoNo = classifyRisk({ ...sano({ price: 0.99 }), inBand: true }, opts);
  ok('inBand:true del board è rispettato allo stesso modo', !prontoNo.flags.includes(FLAG_FUORI_BANDA));

  const ignoto = classifyRisk({ ...sano(), price: null, bandLo: null, bandHi: null }, opts);
  ok('banda non misurabile NON è un flag di rischio', !ignoto.flags.includes(FLAG_FUORI_BANDA));
  ok('  ma è dichiarata come incognita', ignoto.unknowns.some((u) => u.includes('banda')));
  ok('  e outOfBand resta null, mai false', ignoto.outOfBand === null);
}

console.log('\n══ SCADENZA VICINA');
{
  const r = classifyRisk(sano({ hoursToResolution: 8 / 60 }), opts);
  ok('8 minuti alla chiusura ⇒ risk', r.isRisk === true);
  ok('  e il flag porta il numero VERO', r.flags.includes('scade fra 8 min'), r.flags.join(' · '));

  const appenaSotto = classifyRisk(sano({ hoursToResolution: MIN_HORIZON_DAYS * 24 - 0.5 }), opts);
  ok('mezz\'ora sotto la soglia Safe ⇒ risk', appenaSotto.isRisk === true);
  const appenaSopra = classifyRisk(sano({ hoursToResolution: MIN_HORIZON_DAYS * 24 + 0.5 }), opts);
  ok('mezz\'ora sopra la soglia Safe ⇒ safe', appenaSopra.isRisk === false);

  const morente = classifyRisk(sano({ hoursToResolution: 2 / 60 }), opts);
  ok('sotto il pavimento del venue ⇒ flag dedicato, non «scade fra»',
    morente.flags.includes(FLAG_SOTTO_PAVIMENTO) && !morente.flags.some((f) => f.startsWith('scade fra')));
  ok('  e NON è piazzabile: il venue lo rifiuterebbe', morente.tradable === false);
  ok('  ma resta comunque risk (non può stare nel bucket Safe)', morente.isRisk === true);

  const chiuso = classifyRisk(sano({ hoursToResolution: -3 }), opts);
  ok('già chiuso ⇒ non piazzabile e risk', chiuso.tradable === false && chiuso.isRisk === true);

  const senzaData = classifyRisk(sano({ hoursToResolution: null }), opts);
  ok('scadenza illeggibile NON è un flag', !senzaData.flags.some((f) => f.startsWith('scade')));
  ok('  ma è dichiarata come incognita', senzaData.unknowns.some((u) => u.includes('scadenza')));

  // endDate ISO, la forma che usa horizon.js
  const daIso = classifyRisk(
    { ...sano({ hoursToResolution: null }), endDate: new Date(ORA + 20 * 60000).toISOString() }, opts);
  ok('la scadenza si legge anche da endDate ISO', daIso.flags.includes('scade fra 20 min'), daIso.flags.join(' · '));
}

console.log('\n══ L\'ETICHETTA CAMBIA UNITÀ MA NON MENTE');
{
  ok('8 minuti', etichettaScadenza(8) === 'scade fra 8 min');
  ok('89 minuti restano minuti', etichettaScadenza(89) === 'scade fra 89 min');
  ok('4 ore', etichettaScadenza(240) === 'scade fra 4.0 h');
  ok('2 giorni', etichettaScadenza(2880) === 'scade fra 2.0 g');
}

console.log('\n══ DATI STALE');
{
  const fresco = classifyRisk(sano({ dataAgeSec: STALE_S }), opts);
  ok('esattamente sulla soglia ⇒ ancora fresco', !fresco.flags.includes(FLAG_STALE));
  const vecchio = classifyRisk(sano({ dataAgeSec: STALE_S + 1 }), opts);
  ok('un secondo oltre ⇒ stale', vecchio.isRisk === true && vecchio.flags.includes(FLAG_STALE));

  const daMid = classifyRisk({ ...sano({ dataAgeSec: null }), midAgeSec: 600 }, opts);
  ok('midAgeSec del board è una sorgente valida', daMid.flags.includes(FLAG_STALE));
  const daTs = classifyRisk({ ...sano({ dataAgeSec: null }), newestTsMs: ORA - 400_000 }, opts);
  ok('newestTsMs del piano è una sorgente valida', daTs.flags.includes(FLAG_STALE));

  const muto = classifyRisk({ ...sano({ dataAgeSec: null }) }, opts);
  ok('età non leggibile NON è un flag', !muto.flags.includes(FLAG_STALE));
  ok('  ma è dichiarata come incognita', muto.unknowns.some((u) => u.includes('età')));
}

console.log('\n══ PRIMO SUL BOOK — SOLO SE QUALCUNO L\'HA DECISO');
{
  const senza = classifyRisk(sano(), opts);
  ok('senza il dato, nessun flag (non si indovina)', !senza.flags.includes(FLAG_PRIMO_SUL_BOOK));
  const con = classifyRisk(sano({ onTop: true }), opts);
  ok('con onTop deciso da top-of-book.js, il flag compare', con.flags.includes(FLAG_PRIMO_SUL_BOOK));
  const falso = classifyRisk(sano({ onTop: false }), opts);
  ok('onTop:false non aggiunge niente', falso.isRisk === false);
}

console.log('\n══ COMBINAZIONI: I FLAG SI SOMMANO, NON SI MASCHERANO');
{
  const due = classifyRisk(sano({ price: 0.60, dataAgeSec: 900 }), opts);
  ok('fuori banda + stale ⇒ due flag',
    due.flags.includes(FLAG_FUORI_BANDA) && due.flags.includes(FLAG_STALE) && due.flags.length === 2,
    due.flags.join(' · '));

  const tre = classifyRisk(sano({ price: 0.60, dataAgeSec: 900, hoursToResolution: 0.5 }), opts);
  ok('fuori banda + stale + scadenza ⇒ tre flag', tre.flags.length === 3, tre.flags.join(' · '));
  ok('  e l\'ordine dei flag è stabile (banda, scadenza, stale)',
    tre.flags[0] === FLAG_FUORI_BANDA && tre.flags[1].startsWith('scade fra') && tre.flags[2] === FLAG_STALE);

  const quattro = classifyRisk(sano({ price: 0.60, dataAgeSec: 900, hoursToResolution: 0.5, onTop: true }), opts);
  ok('con onTop ⇒ quattro flag', quattro.flags.length === 4, quattro.flags.join(' · '));
}

console.log('\n══ I BUCKET E I LORO DOLLARI');
{
  const ordini = [
    sano({ restingNotionalUsd: 100 }),                                  // safe
    sano({ restingNotionalUsd: 50, price: 0.60 }),                      // risk (fuori banda)
    sano({ restingNotionalUsd: 25, hoursToResolution: 1 }),             // risk (scadenza)
    sano({ restingNotionalUsd: 40, price: null, bandLo: null, bandHi: null, dataAgeSec: null, hoursToResolution: null }), // non giudicabile
  ];
  const b = bucketizza(ordini, opts);
  ok('un ordine per bucket', b.safe.length === 1 && b.risk.length === 2 && b.nonGiudicabili.length === 1);
  ok('Safe = $100', b.safeUsd === 100, `$${b.safeUsd}`);
  ok('Risk = $75', b.riskUsd === 75, `$${b.riskUsd}`);
  ok('non giudicabile = $40, e NON è dentro Safe', b.nonGiudicabileUsd === 40 && b.safeUsd === 100);
  ok('l\'impegnato totale è la somma dei tre', b.impegnatoUsd === 215, `$${b.impegnatoUsd}`);
  ok('ogni riga porta con sé il verdetto', b.risk[0].rischio.flags.includes(FLAG_FUORI_BANDA));

  // Il caso vero: gli ordini di /api/maker/board non portano scadenza né età del dato. Le portano i
  // mercati. Senza la fusione, OGNI ordine finirebbe «non giudicabile».
  const mid = '0x' + 'cd'.repeat(32);
  const contesto = new Map([[mid, { hoursToResolution: 0.2, midAgeSec: 30 }]]);
  const soloOrdine = [{ marketId: mid, price: 0.50, bandLo: 0.48, bandHi: 0.52, restingNotionalUsd: 10 }];
  const senzaCtx = bucketizza(soloOrdine, opts);
  ok('senza contesto di mercato l\'ordine non è giudicabile', senzaCtx.nonGiudicabili.length === 1);
  const conCtx = bucketizza(soloOrdine, { ...opts, contesto });
  ok('col contesto di mercato la scadenza entra nel giudizio',
    conCtx.risk.length === 1 && conCtx.risk[0].rischio.flags.some((f) => f.startsWith('scade fra')),
    conCtx.risk[0] && conCtx.risk[0].rischio.flags.join(' · '));
  ok('  e i campi dell\'ordine vincono su quelli del contesto',
    conCtx.risk[0].rischio.outOfBand === false);

  ok('lista vuota ⇒ tutti zero', (() => { const z = bucketizza([], opts); return z.safeUsd === 0 && z.riskUsd === 0 && z.impegnatoUsd === 0; })());
}

console.log('\n══ IL PRE-FILTRO PER PROFILO');
{
  const SAFE = { safeFloorMinutes: SAFE_FLOOR_MINUTES, allowOutOfBand: false, allowStaleData: false };
  const RISK = { safeFloorMinutes: VENUE_FLOOR_MINUTES, allowOutOfBand: true, allowStaleData: true };

  const candidati = [
    sano({ marketId: 'a' }),                                        // pulito
    sano({ marketId: 'b', price: 0.60 }),                           // fuori banda
    sano({ marketId: 'c', dataAgeSec: 900 }),                       // stale
    sano({ marketId: 'd', hoursToResolution: 8 / 60 }),             // scade fra 8 min
    sano({ marketId: 'e', hoursToResolution: 1 / 60 }),             // sotto il pavimento del venue
  ];

  const s = filtraPerProfilo(candidati, SAFE, opts);
  ok('Safe ammette solo il pulito', s.ammessi.length === 1 && s.ammessi[0].marketId === 'a',
    s.ammessi.map((x) => x.marketId).join(','));
  ok('  e scarta gli altri quattro con un motivo ciascuno',
    s.scartati.length === 4 && s.scartati.every((x) => typeof x.motivo === 'string' && x.motivo));

  const r = filtraPerProfilo(candidati, RISK, opts);
  ok('Risk ammette pulito, fuori banda, stale e «scade fra 8 min»',
    r.ammessi.length === 4 && r.ammessi.map((x) => x.marketId).join(',') === 'a,b,c,d',
    r.ammessi.map((x) => x.marketId).join(','));
  ok('  ma NON quello sotto il pavimento del venue: quello non è rischio, è un rifiuto',
    r.scartati.length === 1 && r.scartati[0].marketId === 'e' && r.scartati[0].motivo === FLAG_SOTTO_PAVIMENTO);
  ok('  e gli ammessi portano i loro flag, così la card può mostrarli',
    r.ammessi.find((x) => x.marketId === 'd').rischio.flags.includes('scade fra 8 min'));
  ok('  «scade fra 8 min» sotto il profilo Risk resta un FLAG anche se è ammesso',
    r.ammessi.find((x) => x.marketId === 'd').rischio.isRisk === true);
}

console.log(`\nclassificazione rischio: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
