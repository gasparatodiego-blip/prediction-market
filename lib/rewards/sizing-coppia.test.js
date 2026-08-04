#!/usr/bin/env node
'use strict';
// IL COSTO DELLA COPPIA — LA CORREZIONE CHE CAMBIA LA CLASSIFICA, NON SOLO I TOTALI.
//
// `shareForCapital` calcolava `size = (capitale/2)/mid`: assume che il lato ask costi `mid` per share
// come il bid. È vero solo se il lato ask è una VENDITA di share già possedute. Quotando due lati
// partendo da collaterale si compra YES a (mid−d) e NO a (1−mid−d), e la coppia costa `1 − 2d`
// indipendentemente dal mid.
//
// Il rapporto fra le due formule è `2·mid/(1−2d)`: 1,00 a mid 0,49 e 0,11 a mid 0,055. Con la formula
// vecchia un mercato a 5¢ sembra comprare NOVE VOLTE le share che il capitale compra, quindi sembra
// rendere nove volte tanto, quindi il knapsack — che massimizza il netto — ci va. La distorsione non è
// nel numero mostrato: è nella SCELTA dei mercati.
//
// Questo file prova le tre cose che contano: che la formula nuova sia giusta, che quella vecchia resti
// disponibile e invariata (il backtest modella il lato ask come inventario, e per lui è corretta), e
// che il tetto per mercato regga con la formula nuova.

const { shareForCapital, capitalToQualify } = require('../../scripts/rewards-ceiling/lib/curve');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Il costo di una coppia a 1¢ di offset: 1 − 2×0,01.
const PAIR = 0.98;

console.log('\n══ SENZA IL COSTO DELLA COPPIA, L ARITMETICA E ESATTAMENTE QUELLA DI PRIMA');
{
  // Il backtest e la pipeline del ceiling non devono muoversi di un centesimo.
  for (const mid of [0.055, 0.20, 0.50, 0.90]) {
    const atteso = (200 / 2) / mid;          // la vecchia formula, scritta a mano
    const dep = shareForCapital(0, mid, 200, 0);
    // share/(share+0) = 1 quando non c'e concorrenza: si verifica la SIZE tramite il minimo.
    ok(`mid ${mid}: sotto il minimo esattamente alla vecchia size`,
      shareForCapital(0, mid, 200, atteso + 0.001) === 0 && shareForCapital(0, mid, 200, atteso - 0.001) > 0,
      `size vecchia ${atteso.toFixed(2)}`);
    ok(`  e con concorrenza da' la quota della vecchia size`,
      vicino(shareForCapital(atteso, mid, 200, 0), 0.5, 1e-9), String(dep));
  }
}

console.log('\n══ CON IL COSTO DELLA COPPIA, LA SIZE E CAPITALE / (1 − 2d) — E NON DIPENDE DAL MID');
{
  const atteso = 200 / PAIR;
  for (const mid of [0.055, 0.20, 0.50, 0.90]) {
    ok(`mid ${mid}: la size e ${atteso.toFixed(2)}, la stessa a ogni mid`,
      shareForCapital(atteso, mid, 200, 0, PAIR) !== null
      && vicino(shareForCapital(atteso, mid, 200, 0, PAIR), 0.5, 1e-9));
  }
  ok('  ed e indipendente dal mid per costruzione (comprare YES a p e NO a 1−p costa 1 a coppia)',
    vicino(shareForCapital(atteso, 0.055, 200, 0, PAIR), shareForCapital(atteso, 0.90, 200, 0, PAIR), 1e-12));
}

console.log('\n══ IL RAPPORTO FRA LE DUE FORMULE E 2·mid/(1−2d) — LA MISURA DELLA DISTORSIONE');
{
  const sizeVecchia = (mid) => (200 / 2) / mid;
  const sizeNuova = 200 / PAIR;
  // 2·mid/(1−2d): a mid 0,49 con d=1¢ fa esattamente 1,00 — li' il modello vecchio era corretto.
  for (const [mid, atteso] of [[0.49, 1.0], [0.43, 0.8776], [0.205, 0.4184], [0.097, 0.198], [0.055, 0.1122]]) {
    const rapporto = sizeNuova / sizeVecchia(mid);
    ok(`mid ${mid}: il capitale compra il ${(rapporto * 100).toFixed(1)}% delle share che il modello vecchio prometteva`,
      vicino(rapporto, atteso, 1e-3), `atteso ${atteso}`);
  }
  ok('a mid 0,50 le due formule coincidono quasi esattamente (li il modello vecchio era giusto)',
    Math.abs(sizeNuova / sizeVecchia(0.50) - 1) < 0.03);
  ok('  e piu il mercato e economico, piu il modello vecchio sovrastimava',
    sizeNuova / sizeVecchia(0.055) < sizeNuova / sizeVecchia(0.20)
    && sizeNuova / sizeVecchia(0.20) < sizeNuova / sizeVecchia(0.49));
}

console.log('\n══ LA SOGLIA DELLA SIZE MINIMA SI MUOVE INSIEME ALLA FORMULA');
{
  // Se `capitalToQualify` restasse sulla vecchia regola, direbbe all operatore un capitale che non
  // basta: soglia e rifiuto racconterebbero due storie diverse sullo stesso mercato.
  const minSize = 200;
  ok('senza costo della coppia: 2 × mid × minSize (invariato)',
    vicino(capitalToQualify(0.055, minSize), 2 * 0.055 * minSize));
  ok('con costo della coppia: minSize × costo della coppia',
    vicino(capitalToQualify(0.055, minSize, PAIR), minSize * PAIR));
  // E il capitale che la soglia indica deve DAVVERO portare la size al minimo.
  const serve = capitalToQualify(0.055, minSize, PAIR);
  ok('  e quel capitale porta la size esattamente al minimo, non sotto',
    shareForCapital(0, 0.055, serve, minSize, PAIR) > 0
    && shareForCapital(0, 0.055, serve - 0.01, minSize, PAIR) === 0,
    `servono $${serve.toFixed(2)}`);
  // Prova che la vecchia soglia sarebbe stata SBAGLIATA sotto la formula nuova: $22 non bastano.
  ok('  mentre la vecchia soglia ($22) sotto la formula nuova NON basta',
    shareForCapital(0, 0.055, capitalToQualify(0.055, minSize), minSize, PAIR) === 0,
    `vecchia soglia $${capitalToQualify(0.055, minSize).toFixed(2)}`);
}

console.log('\n══ ARGOMENTI NON UTILIZZABILI: NESSUN VALORE DI COMODO');
{
  ok('costo della coppia null ⇒ formula storica', vicino(shareForCapital(0, 0.5, 100, 0, null), shareForCapital(0, 0.5, 100, 0)));
  ok('costo della coppia zero ⇒ formula storica (mai una divisione per zero)',
    vicino(shareForCapital(0, 0.5, 100, 0, 0), shareForCapital(0, 0.5, 100, 0)));
  ok('costo della coppia negativo ⇒ formula storica', vicino(shareForCapital(0, 0.5, 100, 0, -1), shareForCapital(0, 0.5, 100, 0)));
  ok('costo della coppia NaN ⇒ formula storica', vicino(shareForCapital(0, 0.5, 100, 0, NaN), shareForCapital(0, 0.5, 100, 0)));
  ok('mid non leggibile ⇒ null anche col costo della coppia', shareForCapital(0, null, 100, 0, PAIR) === null);
  // `null >= 0` e' vero in JS, quindi un capitale null passa il guard e vale zero: nessuna share,
  // che e' semanticamente giusto («niente capitale, niente size») anche se il guard e' largo.
  // Comportamento PREESISTENTE e identico con e senza costo della coppia: qui si registra, non si cambia.
  ok('capitale null ⇒ zero share, e identico con e senza costo della coppia',
    shareForCapital(0, 0.5, null, 0, PAIR) === shareForCapital(0, 0.5, null, 0));
  ok('capitale undefined ⇒ null (non misurabile)', shareForCapital(0, 0.5, undefined, 0, PAIR) === null);
}

console.log('\n══ IL TETTO PER MERCATO REGGE CON LA FORMULA NUOVA');
{
  // Il tetto vive sul CAPITALE (allocateBudget costruisce la griglia fino a capPerMarket), e la formula
  // nuova cambia solo quante share quel capitale compra. Quindi il tetto non puo' essere sforato dalla
  // correzione — e questa e' la prova aritmetica: il nozionale delle due gambe E il capitale.
  const capitale = 180;
  const shares = capitale / PAIR;
  const pYes = 0.43 - 0.01, pNo = (1 - 0.43) - 0.01;
  const nozionale = shares * pYes + shares * pNo;
  ok('la somma delle due gambe e esattamente il capitale della riga',
    vicino(nozionale, capitale, 1e-9), `$${nozionale.toFixed(6)} contro $${capitale}`);
  ok('  e vale a qualunque mid, perche p_yes + p_no = 1 − 2d', (() => {
    for (const mid of [0.055, 0.2, 0.5, 0.8, 0.95]) {
      const n = (capitale / PAIR) * ((mid - 0.01) + ((1 - mid) - 0.01));
      if (!vicino(n, capitale, 1e-9)) return false;
    }
    return true;
  })());
}

console.log(`\ncosto della coppia: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
