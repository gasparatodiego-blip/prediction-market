'use strict';
// lib/rewards/coerenza-tetto-derivato.test.js — IL TETTO DERIVATO REGGE ANCHE A VALLE.
//
// Un tetto che cambia forma tocca cinque superfici, e ognuna aveva un numero tarato su una costante:
// l'allocatore, il minimo per un ordine sensato, la scala di profondità, il registro dei residui e la
// soglia `f_min`. Questo banco verifica che nessuna delle cinque sia rimasta indietro.
//
// Il difetto che ha motivato il banco è reale e trovato dalla suite: `MIN_ALLOCAZIONE_USD = 34` contro
// un tetto di $32,67 rendeva il mini-ciclo IMPOSSIBILE — lo spazio di un mercato non supera mai il suo
// tetto, quindi nessun mercato aveva «spazio sufficiente» e il giro si fermava a ogni scatto.
//
// Run: node lib/rewards/coerenza-tetto-derivato.test.js

const fs = require('fs');
const path = require('path');
const C = require('./concentration');
const SDC = require('./size-da-capitale');
const TRIG = require('../maker/trigger-capitale-fermo');
const { scalaProfondita } = require('./profondita-minima');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const CAP_RIF = C.CAPITALE_RIFERIMENTO_USD;

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · IL MINIMO PER UN ORDINE SENSATO NON PUÒ SUPERARE IL TETTO');
{
  // È l'invariante che il difetto ha violato. Vale per OGNI capitale, non solo per quello di oggi:
  // se un giorno il tetto scendesse ancora, il minimo deve scendere con lui.
  for (const cap of [50, 200, 400, CAP_RIF, 1000, 2000, 5000]) {
    ok(`  capitale $${cap}: minimo ≤ tetto`, TRIG.MIN_ALLOCAZIONE_USD <= C.capPerMarketUsd(cap),
      `min $${TRIG.MIN_ALLOCAZIONE_USD} contro tetto $${C.capPerMarketUsd(cap)}`);
  }
  ok('ed è il pavimento premiante, non un numero scelto',
    TRIG.MIN_ALLOCAZIONE_USD === C.pavimentoPremiante(C.MIN_PREMIANTE_TIPICO));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · LA SCALA DI PROFONDITÀ NON SCENDE MAI SOTTO IL PAVIMENTO PREMIANTE');
{
  // La regola richiesta: se ridurre la size la porterebbe sotto il minimo del venue, il mercato NON si
  // quota affatto. `scalaProfondita` deve ESCLUDERE, mai consegnare un livello sotto il minimo.
  const minVenue = 20;
  // La firma vera: `depthShares`, `maxQuota`, e i livelli devono essere marcati `finanziato`.
  // I livelli partono TUTTI sopra il minimo del venue: cosi' l'unico modo di finire sotto sarebbe che
  // la scala li ci porti — che e' esattamente il vincolo 4 del modulo («mai forzare la size al minimo
  // oltre la quota sicura»). Livelli gia' sotto il minimo esistono nella griglia vera ma li marca il
  // chiamante con `sottoMinimoVenue`, e non sono ciò che questo banco verifica.
  const livelli = [];
  for (let u = 1; u <= 40; u++) livelli.push({ units: u, capitalUsd: u * 25, shares: (u * 25) / 0.98, finanziato: true });
  for (const prof of [5, 20, 60, 200, 1000]) {
    const r = scalaProfondita({ livelli, depthShares: prof, minSizeShares: minVenue, maxQuota: 0.6 });
    // `tenuti` e' un array di booleani PARALLELO a `livelli`: si guardano i livelli tenuti.
    const tenutiIdx = (r && Array.isArray(r.tenuti)) ? r.tenuti : [];
    const tenuti = livelli.filter((_, i) => tenutiIdx[i] === true);
    const sottoMinimo = (r && String(r.stato).startsWith('escluso')) ? []
      : tenuti.filter((l) => l.finanziato && Number.isFinite(l.shares) && l.shares < minVenue);
    ok(`  profondità ${prof} share: nessun livello tenuto sotto il minimo del venue`, sottoMinimo.length === 0,
      `stato ${r && r.stato} · ${tenuti.length} livelli tenuti`);
  }
  // Book quasi deserto ma MISURATO ⇒ escluso. E profondita' NON misurata ⇒ `ignota`, che e' la regola
  // cardinale del modulo: assenza di prova non e' prova, quindi non si esclude e non si riduce.
  const deserto = scalaProfondita({ livelli, depthShares: 0.5, minSizeShares: minVenue, maxQuota: 0.6 });
  ok('  book misurato quasi deserto ⇒ ESCLUSO, non ridotto sotto il minimo',
    deserto && String(deserto.stato).startsWith('escluso'), deserto && deserto.stato);
  const ignota = scalaProfondita({ livelli, depthShares: null, minSizeShares: minVenue, maxQuota: 0.6 });
  ok('  profondita NON misurata ⇒ `ignota`: ne ridotto ne escluso', ignota && ignota.stato === 'ignota');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · f_min: la soglia del residuo si muove col tetto, e la si dichiara');
{
  const fMin = (tetto, minSize) => (minSize * SDC.COSTO_COPPIA_TIPICO) / tetto;
  const oggi = fMin(C.capPerMarketUsd(CAP_RIF), 20);
  ok(`al tetto di oggi ($${C.capPerMarketUsd(CAP_RIF)}) f_min vale ${(oggi * 100).toFixed(0)}%`,
    Math.abs(oggi - C.F_MIN_OBIETTIVO) < 0.02, `${(oggi * 100).toFixed(1)}%`);
  ok('  ed è per costruzione l\'obiettivo da cui il tetto nasce', Math.abs(oggi - C.F_MIN_OBIETTIVO) < 0.02);
  // Il verso: più capitale per mercato ⇒ f_min più basso ⇒ residui più raramente bloccati.
  ok('  un tetto più alto abbassa f_min', fMin(C.capPerMarketUsd(5000), 20) < oggi,
    `${(fMin(C.capPerMarketUsd(5000), 20) * 100).toFixed(0)}% a $5.000`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · il registro dei residui non conosce costanti: la soglia è per MERCATO');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'maker', 'accumulo-residui.js'), 'utf8');
  ok('`accumulo-residui` riceve `minSize` e non lo ridichiara',
    /minSize/.test(src) && !/minSize\s*=\s*\d+/.test(src));
  ok('  e il registro non importa il tetto per mercato', !/concentration/.test(src),
    'la soglia del residuo è del venue, non nostra: sono due domande diverse');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · i due percorsi che calcolano un piano leggono il tetto DAL CAPITALE');
{
  const rc = fs.readFileSync(path.join(__dirname, '..', 'maker', 'realloc-cycle.js'), 'utf8');
  ok('il ciclo da 6h deriva il tetto dal capitale letto', /const tetto = capPerMarketUsd\(capitale\)/.test(rc));
  const a41 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  ok('il mini-ciclo pure', /capPerMarketUsd\(capitaleTotale\)/.test(a41));
  ok('  e nessuno dei due usa la costante di compatibilità per DECIDERE',
    !/maxPerMarketUsd:\s*MARKET_CAP_FIXED_USD/.test(rc) && !/maxPerMarketUsd:\s*MARKET_CAP_FIXED_USD/.test(a41));
}

console.log(`\n===== coerenza-tetto-derivato: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
