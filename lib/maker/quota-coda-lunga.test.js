#!/usr/bin/env node
'use strict';
// ⚠ IL FATTO — 21 agosto 2026, 05:00Z. Il board offriva **7 mercati ammissibili, TUTTI di coda lunga**
// (1.699-3.163 ore). Sei a `minSize 50`, pavimento premiante $61,25, contro una quota che al 12%
// valeva `4 × $61,25 × 0,12/0,88 = $33,41`: il cancello 2-ter li scartava tutti e sei, e il bot teneva
// **1 slot su 5**. A p=0,50 la quota vale $245,00 e passano tutti e sette.
//
// SI PROVA L'ARITMETICA, NON LA COSTANTE: le asserzioni calcolano la quota dal valore di p e
// confrontano col pavimento premiante vero. Cambiare il default non le rende verdi per caso.
const C = require('../rewards/concentration');
const H = require('../rewards/horizon');
const S = require('./selezione-mercati');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const ORA = 1787000000000;
const H24 = (ore) => new Date(ORA + ore * 3600000).toISOString();
const mkt = (id, minSize, ore) => ({ conditionId: id, question: 'q' + id, rewardsMinSize: minSize,
  endDate: H24(ore), category: 'sports', rewardsMaxSpread: 4.5, rewardsDailyRate: 10 });

// L'aritmetica del 2-ter, come la calcola il modulo: (slot − 1) × tetto × p/(1−p).
const quota = (p, slot) => (slot - 1) * C.MARKET_CAP_FIXED_USD * p / (1 - p);

function decidi(p, mercati) {
  return S.decidiSelezione({
    board: mercati, stato: null, posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 5,
    orizzonteMassimoOre: 150 * 24, conOrdiniVivi: { leggibile: true, ids: [] },
    codaLungaGiorni: H.LONG_TAIL_DAYS, codaLungaFrazione: p,
    tettoPerMercatoUsd: C.MARKET_CAP_FIXED_USD, pavimentoPremiante: C.pavimentoPremiante,
  });
}
const scartato = (d, id) => (d.scartatiPerCodaLungaSottoPavimento || []).some((x) => x.id === id);

console.log('\n══ 1 · L\'ARITMETICA DELLA QUOTA');
{
  t('a p=0,12 su 5 slot la quota vale $33,41', Math.abs(quota(0.12, 5) - 33.41) < 0.01, +quota(0.12, 5).toFixed(2));
  t('a p=0,50 su 5 slot la quota vale $245,00', Math.abs(quota(0.50, 5) - 245) < 0.01, +quota(0.50, 5).toFixed(2));
  t('  cioe\' ESATTAMENTE 4 × il tetto per mercato', Math.abs(quota(0.50, 5) - 4 * C.MARKET_CAP_FIXED_USD) < 1e-9);
  t('il pavimento di minSize 50 sta SOPRA la quota a 0,12', C.pavimentoPremiante(50) > quota(0.12, 5),
    { pavimento: C.pavimentoPremiante(50), quota: +quota(0.12, 5).toFixed(2) });
  t('  e SOTTO-o-uguale alla quota a 0,50', C.pavimentoPremiante(50) <= quota(0.50, 5));
  t('il pavimento di minSize 20 passa gia\' a 0,12', C.pavimentoPremiante(20) <= quota(0.12, 5));
}

console.log('\n══ 2 · IL CANCELLO 2-ter SEGUE L\'ARITMETICA, in entrambi i versi');
{
  const LUNGO = '0xlungo50';   // minSize 50, coda lunga (oltre 7 g)
  const board = [mkt(LUNGO, 50, 40 * 24)];
  t('a p=0,12 un minSize 50 di coda lunga viene SCARTATO', scartato(decidi(0.12, board), LUNGO));
  t('a p=0,50 lo stesso mercato PASSA', !scartato(decidi(0.50, board), LUNGO));
  // Il confine si muove col calcolo, non con una costante: si cerca la p a cui il verdetto cambia e si
  // verifica che coincida con quella per cui quota == pavimento.
  const pCritica = (() => { // pavimento = (slot-1)*tetto*p/(1-p)  ⇒  p = pav/(pav+(slot-1)*tetto)
    const pav = C.pavimentoPremiante(50), q = 4 * C.MARKET_CAP_FIXED_USD;
    return pav / (pav + q);
  })();
  t('  e il confine calcolato coincide col verdetto del modulo',
    scartato(decidi(pCritica - 0.01, board), LUNGO) && !scartato(decidi(pCritica + 0.01, board), LUNGO),
    { pCritica: +pCritica.toFixed(4) });
}
{
  // Un minSize 20 non dipende da questa manopola: passa a entrambe.
  const BASSO = '0xbasso20';
  const board = [mkt(BASSO, 20, 40 * 24)];
  t('un minSize 20 di coda lunga passa a 0,12 come a 0,50',
    !scartato(decidi(0.12, board), BASSO) && !scartato(decidi(0.50, board), BASSO));
}
{
  // La fascia corta non e' toccata dalla quota, a nessuna p.
  const CORTO = '0xcorto50';
  const board = [mkt(CORTO, 50, 40)];   // 40 ore, sotto i 7 giorni
  t('un mercato di FASCIA CORTA non passa mai da questo cancello',
    !scartato(decidi(0.12, board), CORTO) && !scartato(decidi(0.50, board), CORTO));
}

console.log('\n══ 3 · IL LETTORE DELL\'ENV — fail-closed verso la frazione MISURATA');
{
  t('env assente ⇒ frazione misurata 12%', H.leggiQuotaCodaLunga({}) === H.LONG_TAIL_CAP_FRAC_MISURATA);
  t('env valido ⇒ si applica', H.leggiQuotaCodaLunga({ MAKER_QUOTA_CODA_LUNGA: '0.5' }) === 0.5);
  for (const brutto of ['tantissimo', '', '0.99', '0.01', '-1', 'NaN']) {
    t(`env «${brutto}» ⇒ NON allarga la quota, torna al 12%`,
      H.leggiQuotaCodaLunga({ MAKER_QUOTA_CODA_LUNGA: brutto }) === H.LONG_TAIL_CAP_FRAC_MISURATA);
  }
  t('i limiti sono dichiarati e sensati', H.QUOTA_CODA_MIN === 0.05 && H.QUOTA_CODA_MAX === 0.75);
  t('la quota resta nel dominio in cui budgetCodaLungaUsd ha senso',
    H.LONG_TAIL_CAP_FRAC > 0 && H.LONG_TAIL_CAP_FRAC < 1);
}

console.log('\n══ 4 · UNA SOLA SORGENTE, E IL CABLAGGIO');
{
  const fs = require('fs'), path = require('path');
  const R = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const nudo = (s) => s.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  const hz = nudo(R('lib/rewards/horizon.js'));
  t('il 12% e\' scritto UNA volta sola, come frazione MISURATA',
    (hz.match(/=\s*0\.12\s*;/g) || []).length === 1);
  t('  e `LONG_TAIL_CAP_FRAC` deriva dal lettore, non da un letterale',
    /const LONG_TAIL_CAP_FRAC = leggiQuotaCodaLunga\(\);/.test(hz));
  const al = nudo(R('lib/rewards/allocator.js'));
  t('l\'allocatore IMPORTA la quota, non la ridichiara', /LONG_TAIL_CAP_FRAC/.test(al) && !/=\s*0\.12/.test(al));
  const ag = nudo(R('agents/agent41-realloc-scheduler.js'));
  t('agent41 la INIETTA nella selezione, non la ricopia',
    /require\('\.\.\/lib\/rewards\/horizon'\)\.LONG_TAIL_CAP_FRAC/.test(ag) && /codaLungaFrazione,/.test(ag));
  const eco = nudo(R('agents/ecosystem.config.js'));
  t('la manopola e\' dichiarata nell\'ecosystem ⇒ leggibile da /proc',
    /MAKER_QUOTA_CODA_LUNGA: '0\.5'/.test(eco));
  t('  e sta su UN processo solo', (eco.match(/MAKER_QUOTA_CODA_LUNGA/g) || []).length === 1);
}

console.log('\n══ 5 · L\'INVARIANTE DI RISCHIO NON SI MUOVE');
{
  const cap = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'data', 'safety-risk-limits.json'), 'utf8')).global.maxOpenNotionalUsd;
  t('esposizione massima a 5 mercati resta sotto il cap',
    C.esposizioneMassimaRaggiungibileUsd(5) <= cap,
    { esposizione: C.esposizioneMassimaRaggiungibileUsd(5), cap });
  t('  e il tetto per mercato non dipende dalla quota', C.MARKET_CAP_FIXED_USD === 61.25);
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);
