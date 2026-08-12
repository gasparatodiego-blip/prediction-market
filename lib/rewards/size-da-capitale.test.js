'use strict';
// lib/rewards/size-da-capitale.test.js — UNA SOLA FORMULA CAPITALE→SHARE, E I MID ESTREMI LO PROVANO.
//
// Il difetto: `plan-to-orders` usava `Q = C/(p_yes+p_no)` (corretta) mentre `minSizeVerdict` e
// `net.js` usavano `(C/2)/mid`, vera solo a mid 0,50. A mid 0,055 la seconda dava NOVE VOLTE le share
// vere, quindi un mercato risultava qualificato quando il capitale non compra il minimo premiante — e
// sotto `min_incentive_size` il reward non è più basso, è ZERO.
//
// Run: node lib/rewards/size-da-capitale.test.js

const fs = require('fs');
const path = require('path');
const SDC = require('./size-da-capitale');
const { minSizeVerdict, estimateAtCapital } = require('../reward-operator-estimate');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · LA PROPRIETÀ: le due chiamate danno lo STESSO numero, anche lontano da mid 0,50');
{
  // `plan-to-orders` calcola Q = C/(p_yes+p_no). Qui si replica quella formula a mano e si pretende
  // che coincida con ciò che il verdetto di size minima usa — che è il punto di tutto il lavoro.
  const casi = [
    { mid: 0.055, pYes: 0.05, pNo: 0.93 },
    { mid: 0.16, pYes: 0.155, pNo: 0.825 },
    { mid: 0.50, pYes: 0.49, pNo: 0.49 },
    { mid: 0.744, pYes: 0.74, pNo: 0.24 },
    { mid: 0.95, pYes: 0.945, pNo: 0.035 },
  ];
  for (const c of casi) {
    const pairCost = c.pYes + c.pNo;
    const capitale = 65;
    const attesa = capitale / pairCost;                                  // la formula di plan-to-orders
    const daModulo = SDC.sharePerLato({ capitaleUsd: capitale, pairCostUsd: pairCost }).shares;
    const daVerdetto = minSizeVerdict({ capitalUsd: capitale, mid: c.mid, minSize: 1, pairCostUsd: pairCost }).sizePerSideShares;
    ok(`mid ${c.mid}: piazzamento e verdetto coincidono`, vicino(daModulo, attesa) && vicino(daVerdetto, attesa),
      `${attesa.toFixed(2)} share`);
  }
  // E la controprova: la formula VECCHIA divergeva, e di quanto.
  const vecchia = (c, mid) => (c / 2) / Math.max(0.01, Math.min(0.99, mid));
  const nuova = SDC.sharePerLato({ capitaleUsd: 65, pairCostUsd: 0.98 }).shares;
  ok('CONTROPROVA: a mid 0,055 la formula vecchia dava ~9× le share vere',
    vecchia(65, 0.055) / nuova > 8 && vecchia(65, 0.055) / nuova < 10,
    `${vecchia(65, 0.055).toFixed(0)} contro ${nuova.toFixed(0)}`);
  ok('  e a mid 0,50 le due coincidevano — per questo il difetto era invisibile',
    Math.abs(vecchia(65, 0.5) - nuova) / nuova < 0.05);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · il capitale per qualificare NON dipende più dal mid');
{
  const a = SDC.capitalePerQualificare({ minSize: 20, pairCostUsd: 0.98 });
  ok('minSize 20 ⇒ $19,60, qualunque sia il mid', vicino(a, 19.6, 1e-6), `$${a}`);
  for (const mid of [0.05, 0.3, 0.5, 0.7, 0.95]) {
    const v = minSizeVerdict({ capitalUsd: 100, mid, minSize: 20, pairCostUsd: 0.98 });
    ok(`  mid ${mid} ⇒ servono sempre $${v.capitalToQualifyUsd}`, vicino(v.capitalToQualifyUsd, 19.6, 1e-6));
  }
  ok('minSize illeggibile ⇒ null, non un numero inventato',
    SDC.capitalePerQualificare({ minSize: null }) === null && SDC.qualifica({ capitaleUsd: 50, minSize: 0 }).qualifica === null);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · il ripiego è DICHIARATO, e non è mai la formula vecchia');
{
  const r = SDC.sharePerLato({ capitaleUsd: 65 });
  ok('senza costo della coppia si usa il tipico 0,98', r.modello === 'ripiego-tipico' && vicino(r.costoCoppia, 0.98));
  ok('  e lo dichiara nel motivo', /non leggibile/.test(r.motivo || ''));
  ok('  ma NON torna a (C/2)/mid', Math.abs(r.shares - 65 / 0.98) < 1e-9);
  ok('capitale non leggibile ⇒ shares null, mai zero', SDC.sharePerLato({ capitaleUsd: null }).shares === null);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · un solo punto di conversione nel repo');
{
  const est = fs.readFileSync(path.join(__dirname, '..', 'reward-operator-estimate.js'), 'utf8');
  ok('`minSizeVerdict` non divide più per il mid', !/\(capitalUsd \/ 2\) \/ clampPrice\(mid\)/.test(est));
  ok('  e importa la formula condivisa', /require\('\.\/rewards\/size-da-capitale'\)/.test(est));
  const net = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'rewards-replay', 'lib', 'net.js'), 'utf8');
  ok('`net.js` non ha più il ramo `(capitalTotal / 2) / mid`', !/\(capitalTotal \/ 2\) \/ Math\.max/.test(net));
  ok('  e usa la formula condivisa', /size-da-capitale/.test(net));
}

console.log(`\n===== size-da-capitale: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
