#!/usr/bin/env node
'use strict';
// UN PREZZO SI DECIDE CONTRO IL LIBRO CHE C'È ADESSO, NON CONTRO UNA MEDIANA DI QUARANTOTT'ORE.
//
// ═══ I DUE DIFETTI, UNA SOLA ORIGINE ═════════════════════════════════════════════════════════════════
// 5 agosto 2026, coda di piazzamento, «Will the number of Republican Senate members who retire in 2026
// be exactly 7?». La coda proponeva:
//
//     1ª gamba · BUY YES 28,8 share @ 0,82 · «1,50¢ dal mid»
//
// e il pannello ordine, sullo stesso mercato, mostrava BID 78¢ · ASK 82¢ · mid di scoring 79,5¢.
//
//   A · INCROCIO. 0,82 È l'ask. Un BUY all'ask non riposa: si esegue subito da taker. Per i liquidity
//       rewards serve un ordine che RESTA nel libro, quindi quel prezzo non produce reward — produce
//       un trade direzionale.
//   B · MID SBAGLIATO. Con banda ±2,25¢ sul mid di scoring 79,5¢ il range premiante è 77,25–81,75¢.
//       0,82 ne è fuori di 0,25¢. Il «1,50¢ dal mid» della coda era misurato da un mid diverso.
//
// UNA SOLA CAUSA. `gambeDiUnaRiga` quotava su `r.mid`, che è `median(adjMid)` sullo storico — 0,835
// contro un mid di scoring vivo di 0,795. Quattro centesimi di scarto: 0,835 − 2¢ = 0,82, cioè l'ask.
// E `planQuotes` non ha mai visto il tocco: giudicava `inBand` confrontando l'OFFSET col raggio, mai il
// PREZZO col libro. Con un mid di riferimento sbagliato quel controllo passa sempre.
//
// La mediana è giusta per SCORARE (un punteggio sull'ultimo tick sarebbe rumore) e sbagliata per
// PREZZARE. Sono due usi diversi dello stesso numero, ed è la confusione fra i due il difetto.
//
// ═══ COSA NON ERA A RISCHIO ══════════════════════════════════════════════════════════════════════════
// Il capitale. `placeManualOrder` rifiuta con gate `would-cross` un BUY al di sopra dell'ask: l'ordine
// sarebbe stato respinto al piazzamento. Era la PROPOSTA a essere sbagliata, non l'esecuzione — ma una
// proposta che l'ultimo guardiano deve respingere è una proposta che non doveva esistere.

const fs = require('fs');
const path = require('path');
const { gambeDiUnaRiga } = require('./plan-to-orders');
const { priceVerdict } = require('../maker/book-view');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const c = (v) => +(v * 100).toFixed(2);

/** Una riga di piano, con la mediana dello storico e il riferimento vivo separati — come nella realtà. */
const riga = ({ midStorico, scoringMid, bestBid, bestAsk, tick = 0.01, banda = 4.5, minSize = 20, capitale = 28 }) => ({
  marketId: '0x' + 'ab'.repeat(32), name: 'mercato di prova',
  mid: midStorico, tick, maxSpreadCents: banda, minSizeShares: minSize, capital: capitale,
  rif: { scoringMid, bestBid, bestAsk },
});

console.log('\n══ 1 · IL CASO VERO: mediana 0,835 · mid di scoring 0,795 · ask 0,82');
{
  const r = riga({ midStorico: 0.835, scoringMid: 0.795, bestBid: 0.78, bestAsk: 0.82 });

  // Come si comportava PRIMA: senza riferimento vivo si quota sulla mediana e nessuno guarda il libro.
  const primaR = { ...r, rif: null };
  const prima = gambeDiUnaRiga(primaR, 2);
  ok('PRIMA (solo mediana, nessun libro): proponeva un prezzo', prima.rows != null);
  ok('  e quel prezzo era 0.82 — esattamente l ask', prima.rows && prima.rows[0].price === 0.82,
    prima.rows ? String(prima.rows[0].price) : prima.scarto.motivo);
  ok('  cioè incrociava il libro', prima.rows
    && priceVerdict({ price: prima.rows[0].price, bestBid: 0.78, bestAsk: 0.82, scoringMid: 0.795, bandRadiusCents: 2.25, side: 'BUY' }).crosses === true);
  ok('  ed era fuori banda sul mid di scoring vivo',
    prima.rows && Math.abs(prima.rows[0].price - 0.795) * 100 > 2.25,
    prima.rows ? `${(Math.abs(prima.rows[0].price - 0.795) * 100).toFixed(2)}¢` : '');

  // ADESSO: col riferimento vivo, l'INVARIANTE. Non si asserisce «a 2 tick viene escluso» — quello
  // dipende da dove cade l'arrotondamento sul tick, ed è knife-edge: con lo 0,795 esatto il prezzo
  // snappa a 0,78 (dentro), con lo 0,7949999999999999 vero snappa a 0,77 (fuori). Una fixture che
  // cambia esito per un errore di virgola mobile prova la virgola mobile, non la regola.
  // Ciò che deve valere SEMPRE, a qualunque offset: se un prezzo viene proposto, non incrocia il
  // libro ED è dentro banda sul mid di scoring vivo. Altrimenti il mercato è escluso con un motivo.
  const VERO = 0.7949999999999999;           // il valore misurato in produzione, non arrotondato
  const rVero = riga({ midStorico: 0.835, scoringMid: VERO, bestBid: 0.78, bestAsk: 0.82 });
  let proposti = 0, esclusi = 0;
  for (const off of [1, 2, 3, 4]) {
    const g = gambeDiUnaRiga(rVero, off);
    if (g.rows == null) { esclusi += 1; continue; }
    proposti += 1;
    const p0 = g.rows[0].price;
    ok(`offset ${off}t proposto: NON incrocia l ask`, p0 < 0.82, `${p0} < 0.82`);
    ok(`  ed è dentro banda sul mid di scoring vivo`, Math.abs(p0 - VERO) * 100 <= 2.25 + 1e-9,
      `${(Math.abs(p0 - VERO) * 100).toFixed(2)}¢ ≤ 2.25¢`);
  }
  ok('almeno un offset resta proponibile', proposti > 0, `${proposti} proposti, ${esclusi} esclusi`);
  ok('  e almeno uno viene escluso: la regola morde davvero', esclusi > 0, `${esclusi} esclusi`);

  // A 1 tick invece è piazzabile, e lo è DAVVERO: maker e in banda.
  const uno = gambeDiUnaRiga(r, 1);
  ok('a 1 tick il mercato è proponibile', uno.rows != null, uno.scarto ? uno.scarto.motivo : '');
  const y = uno.rows[0];
  // Non si inchioda il numero: 0,795 esatto snappa a 0,79, il 0,7949999999999999 vero a 0,78 — e
  // sono ENTRAMBI corretti. Si asserisce la proprietà: sotto l'ask, e a un tick di distanza dal mid.
  ok('  BUY YES sotto l ask di 0.82', y.price < 0.82, String(y.price));
  ok('  e a un tick dal mid di scoring', Math.abs(Math.abs(y.price - 0.795) - 0.01) < 0.006,
    `${(Math.abs(y.price - 0.795) * 100).toFixed(2)}¢`);
  ok('  NON incrocia', priceVerdict({ price: y.price, bestBid: 0.78, bestAsk: 0.82, scoringMid: 0.795, bandRadiusCents: 2.25, side: 'BUY' }).crosses === false);
  ok('  ed è dentro banda sul mid di SCORING', Math.abs(y.price - 0.795) * 100 <= 2.25,
    `${(Math.abs(y.price - 0.795) * 100).toFixed(2)}¢ ≤ 2.25¢`);
  ok('IL PREZZO VIENE DAL MID VIVO, NON DALLA MEDIANA', y.price !== 0.83 && y.price !== 0.82,
    'con la mediana 0.835 a 1 tick sarebbe stato 0.83');
}

console.log('\n══ 2 · UN PREZZO CHE COINCIDE CON L ASK NON VIENE MAI PROPOSTO (punto 6, primo test)');
{
  // Mid di scoring vicinissimo all'ask: il prezzo teorico a 1 tick cade proprio sull'ask.
  const r = riga({ midStorico: 0.60, scoringMid: 0.60, bestBid: 0.55, bestAsk: 0.59, banda: 8 });
  const g = gambeDiUnaRiga(r, 1);   // 0.60 − 0.01 = 0.59 = l'ask
  ok('il prezzo teorico cadrebbe sull ask (0.59)', true);
  ok('  il mercato NON viene proposto', g.rows === null, g.rows ? String(g.rows[0].price) : '');
  ok('  e il motivo è l incrocio', g.scarto.motivo === 'incrocia-il-libro', g.scarto.motivo);
  ok('  detto con i due prezzi, non genericamente',
    /59\.00¢/.test(g.scarto.dettaglio) && /taker/.test(g.scarto.dettaglio));

  // Un tick più in là non incrocia più: la regola non blocca tutto, blocca ciò che incrocia.
  const g2 = gambeDiUnaRiga(r, 2);  // 0.58 < 0.59
  ok('a 2 tick (0.58, sotto l ask) il mercato torna proponibile', g2.rows != null, g2.scarto ? g2.scarto.motivo : '');
  ok('  e il prezzo resta sotto l ask', g2.rows[0].price < 0.59, String(g2.rows[0].price));
}

console.log('\n══ 3 · IL MID DI SCORING DECIDE LA BANDA, NON QUELLO GREZZO (punto 6, secondo test)');
{
  // Stesso libro, due mid diversi: uno mette il prezzo dentro banda, l'altro fuori. Serve a provare
  // che è il mid di SCORING a comandare, non la mediana né il midpoint grezzo.
  const dentro = gambeDiUnaRiga(riga({ midStorico: 0.50, scoringMid: 0.50, bestBid: 0.44, bestAsk: 0.56, banda: 4.5 }), 2);
  ok('mid di scoring 0.50, prezzo 0.48 → dentro banda (2¢ ≤ 2.25¢)', dentro.rows != null && dentro.rows[0].price === 0.48,
    dentro.scarto ? dentro.scarto.motivo : String(dentro.rows[0].price));

  // Ora lo stesso prezzo teorico, ma il mid di scoring è più lontano: la banda lo esclude.
  const fuori = gambeDiUnaRiga(riga({ midStorico: 0.50, scoringMid: 0.53, bestBid: 0.44, bestAsk: 0.58, banda: 4.5 }), 2);
  ok('mid di scoring 0.53 → il prezzo si sposta con lui', fuori.rows == null || fuori.rows[0].price === 0.51,
    fuori.scarto ? fuori.scarto.motivo : String(fuori.rows[0].price));
  ok('  cioè il calcolo SEGUE il mid di scoring, non resta fermo sulla mediana',
    fuori.rows == null || fuori.rows[0].price !== dentro.rows[0].price);

  // E la prova diretta: con mediana e scoring divergenti, il prezzo è quello dello scoring.
  const div = gambeDiUnaRiga(riga({ midStorico: 0.70, scoringMid: 0.50, bestBid: 0.44, bestAsk: 0.56, banda: 4.5 }), 2);
  ok('mediana 0.70 ma scoring 0.50 → prezzo 0.48, non 0.68', div.rows != null && div.rows[0].price === 0.48,
    div.scarto ? div.scarto.motivo : String(div.rows[0].price));
}

console.log('\n══ 4 · SENZA RIFERIMENTO VIVO IL COMPORTAMENTO RESTA QUELLO DI PRIMA');
{
  // Non si rompe chi non ha il board: il riferimento è additivo. Ma allora nessuno controlla il libro,
  // ed è giusto che sia dichiarato qui invece che scoperto in produzione.
  const senza = gambeDiUnaRiga({ ...riga({ midStorico: 0.50, scoringMid: 0.50, bestBid: 0.44, bestAsk: 0.56 }), rif: null }, 2);
  ok('senza `rif` il mercato viene comunque quotato (sulla mediana)', senza.rows != null);
  ok('  e il controllo sul libro NON viene fatto — è il limite, dichiarato', senza.rows[0].price === 0.48);
}

console.log('\n══ 5 · IL CABLAGGIO, E I TRE PERCORSI CHE NE DIPENDONO (punto 5)');
{
  const pto = leggi('lib', 'rewards', 'plan-to-orders.js');
  ok('si quota sul mid vivo quando c è', /const midQuotazione = midVivo != null \? midVivo : r\.mid/.test(pto));
  ok('  e il verdetto è quello CONDIVISO col pannello ordine', /require\('\.\.\/maker\/book-view'\)/.test(pto)
    && /priceVerdict\(\{/.test(pto));
  ok('  con l ask del libro NO ricavato per specchio', /1 - vivo\.bestBid/.test(pto));
  ok('esistono i due motivi di scarto nuovi',
    /'incrocia-il-libro'/.test(pto) && /'fuori-banda-sul-libro-vivo'/.test(pto));

  const alloc = leggi('lib', 'rewards', 'allocator.js');
  ok('il board porta mid di scoring e tocco fino alla riga', /touchByMarket\.set\(m\.conditionId/.test(alloc)
    && /rif: touchByMarket/.test(alloc));
  ok('  usando sides.yes.mid quando c è', /m\.sides && m\.sides\.yes && m\.sides\.yes\.mid/.test(alloc));

  // I TRE PERCORSI: tutti passano da qui, quindi il difetto li toccava tutti e il fix li copre tutti.
  const panel = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('la CODA usa gambeDiUnaRiga', /const g = gambeDiUnaRiga\(r, offsetTicks/.test(panel));
  ok('«Conferma ed esegui» usa gambeDiUnaRiga', /gambeDiUnaRiga\(x\.r, offsets/.test(panel));
  ok('agent41 ci passa via planToOrders', /const g = gambeDiUnaRiga\(r, r\.computedDefaultOffsetTicks\)/.test(pto)
    && /planToOrders/.test(leggi('lib', 'maker', 'realloc-cycle.js')));
}

console.log('\n══ 6 · L ULTIMO GUARDIANO ERA COMUNQUE IN PIEDI');
{
  const mo = leggi('lib', 'maker', 'manual-order.js');
  ok('placeManualOrder rifiuta un BUY che incrocia', /refuse\('would-cross'/.test(mo));
  ok('  con la regola giusta per il lato BUY', /BUY   incrocia se  price >= bestAsk/.test(mo));
  ok('quindi il capitale non era a rischio: era la PROPOSTA a essere sbagliata', true);
}

console.log(`\nprezzo sul libro vivo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
