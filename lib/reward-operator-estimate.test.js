#!/usr/bin/env node
'use strict';
// Selfcheck for lib/reward-operator-estimate — with the VENUE MINIMUM now applied.
// Plain node, no framework, matching the other lib/*.test.js files.
// Run: node lib/reward-operator-estimate.test.js

const assert = require('assert');
const E = require('./reward-operator-estimate');
// The allocator's copy of the same threshold. Imported HERE (a node-only test) purely to prove the two
// implementations agree — the estimator itself must stay browser-safe and cannot import from scripts/.
const { capitalToQualify } = require('../scripts/rewards-ceiling/lib/curve');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;

// Un mercato di riferimento: pot $50/g, mid 0.675, min_incentive_size 20 share.
// Soglia = 20 share × costo coppia = $19,60 (NON dipende dal mid, dal 12 agosto 2026)
const RS = { poolDay: 50, mid: 0.675, minSize: 20, refCapital: 1000, refShare: 0.02388 };

console.log('\n── 1 · LA SOGLIA: stessa formula dell allocatore, provata contro di essa ──');
{
  // Il guardiano contro la deriva. La formula e' duplicata di proposito (l estimatore deve restare
  // browser-safe e scripts/ non lo e'), quindi qui si dimostra che le due copie danno lo stesso numero.
  let mismatch = 0, checked = 0;
  for (const mid of [0.005, 0.01, 0.05, 0.12, 0.5, 0.675, 0.9, 0.99, 0.995]) {
    for (const ms of [1, 5, 20, 50, 100, 333]) {
      checked++;
      const a = E.capitalToQualifyUsd(mid, ms);
      const b = capitalToQualify(mid, ms);
      if (!near(a, b)) mismatch++;
    }
  }
  ok(`le due implementazioni della soglia coincidono su ${checked} combinazioni mid×minSize`, mismatch === 0);
  // ⚠ LE DUE ASSERZIONI QUI SOTTO SONO STATE RIBALTATE il 12 agosto 2026. Difendevano la formula
  // `2 × mid × minSize`, che era sbagliata: la soglia NON dipende dal mid, perche' le due gambe di una
  // coppia costano insieme ~$1 qualunque sia il prezzo. Ora si difende proprio l'indipendenza dal mid.
  ok('  soglia nota: 20 share × costo coppia 0,98 = $19,60', near(E.capitalToQualifyUsd(0.675, 20), 19.6, 1e-6));
  ok('  e NON dipende piu dal mid: 0,001 e 0,9 danno lo stesso numero',
    near(E.capitalToQualifyUsd(0.001, 100), E.capitalToQualifyUsd(0.9, 100), 1e-9));
  // Il mid non e' piu' un ingresso della soglia, quindi un mid assurdo non la rende irrispondibile:
  // e' il MINIMO che deve essere leggibile. L'asserzione segue la semantica nuova.
  ok('minSize non leggibile → null, mai una soglia inventata',
    E.capitalToQualifyUsd(0.5, 0) === null && E.capitalToQualifyUsd(0.5, null) === null);
  ok('  mentre un mid assurdo NON la rende irrispondibile: il mid non entra piu nel conto',
    near(E.capitalToQualifyUsd(0, 20), 19.6, 1e-6) && near(E.capitalToQualifyUsd(null, 20), 19.6, 1e-6));
}

console.log('\n── 2 · IL BUG CORRETTO: capitale sotto il minimo → ZERO, non una cifra positiva ──');
{
  const under = E.estimateAtCapital(RS, 10, 632);
  ok('a $10 su una soglia di $27 → estUsdPerDay ESATTAMENTE 0', under.estUsdPerDay === 0);
  ok('  e NON "unknown": e un fatto misurato, non un dato mancante', under.unknown === false);
  ok('  marcato belowVenueMinSize', under.belowVenueMinSize === true);
  // I due numeri si DERIVANO dalla formula unica: erano $27,00 e «7,4 share per lato», entrambi
  // prodotti dal modello `(C/2)/mid` che il 12 agosto 2026 e' stato tolto.
  const SDC_ = require('./rewards/size-da-capitale');
  ok('  con il capitale che lo sbloccherebbe',
    near(under.capitalToQualifyUsd, SDC_.capitalePerQualificare({ minSize: 20 }), 1e-6));
  ok('  e il motivo dice share/lato e minimo',
    new RegExp(`${SDC_.sharePerLato({ capitaleUsd: 10 }).shares.toFixed(1)} share per lato`).test(under.reason)
    && /minimo di 20/.test(under.reason));
  ok('  la quota e 0, non una frazione', under.share === 0);

  // Il caso reale trovato in ricerca: prima della correzione questo dava una cifra positiva.
  const wesley = E.estimateAtCapital({ poolDay: 50, mid: 0.675, minSize: 20, refCapital: 1000, refShare: 0.02388 }, 10, 632);
  ok('caso reale (Wesley Bell, $10 su soglia $27) → 0', wesley.estUsdPerDay === 0 && wesley.belowVenueMinSize === true);
}

console.log('\n── 3 · SOPRA LA SOGLIA: la stima resta quella di prima ──');
{
  const over = E.estimateAtCapital(RS, 100, 100000);
  const SOGLIA_ = require('./rewards/size-da-capitale').capitalePerQualificare({ minSize: 20 });
  ok(`a $100 su una soglia di $${SOGLIA_} → stima positiva`, over.estUsdPerDay > 0 && over.belowVenueMinSize === false);
  ok(`  esattamente al limite ($${SOGLIA_}) qualifica`, E.estimateAtCapital(RS, SOGLIA_, 100000).belowVenueMinSize === false);
  ok('  un centesimo sotto NON qualifica', E.estimateAtCapital(RS, SOGLIA_ - 0.01, 100000).belowVenueMinSize === true);

  // NON-REGRESSIONE: sopra la soglia il numero deve essere identico a quello che il modulo dava prima.
  // Riprodotto qui dall'algebra pubblicata: quota riscalata r·s/(r·s+(1−s)), poi × pot.
  const cap = 100, size = 1000, s = RS.refShare;
  const r = cap / size;
  const expected = RS.poolDay * ((r * s) / (r * s + (1 - s)));
  ok('  e il valore e invariato rispetto alla formula pubblicata', near(over.estUsdPerDay, expected, 1e-12));
}

console.log('\n── 4 · IL MINIMO SI MISURA SUL CAPITALE REALE, non su quello ridotto dalla profondita ──');
{
  // $100 di capitale, ma solo $5 di profondita' in banda. La soglia e' $27.
  // Il cap di profondita' modella la QUOTA; non riduce quanto l operatore appoggia sul book, quindi
  // non deve far scattare il minimo. Se lo facesse, ogni book sottile azzererebbe la stima per errore.
  const thin = E.estimateAtCapital(RS, 100, 5);
  ok('capitale $100 sopra soglia, profondita $5 → NON sotto il minimo', thin.belowVenueMinSize === false);
  ok('  ma la stima resta limitata dalla profondita', thin.depthLimited === true && thin.estUsdPerDay > 0);
}

console.log('\n── 5 · NON GIUDICABILE ≠ QUALIFICATO ──');
{
  const noMin = E.estimateAtCapital({ poolDay: 50, mid: 0.675, refCapital: 1000, refShare: 0.02388 }, 10, 632);
  ok('minSize assente → la stima passa invariata (come l allocatore)', noMin.estUsdPerDay > 0 && noMin.belowVenueMinSize === false);
  ok('  ma minSizeJudgeable e false: il chiamante puo dirlo', noMin.minSizeJudgeable === false);
  ok('  e il motivo lo dichiara', /giudicabile/.test(noMin.reason || ''));

  const noMid = E.estimateAtCapital({ poolDay: 50, minSize: 20, refCapital: 1000, refShare: 0.02388 }, 10, 632);
  ok('mid assente → stessa cosa, non un finto pass', noMid.minSizeJudgeable === false);

  const v = E.minSizeVerdict({ capitalUsd: 10, mid: null, minSize: 20 });
  ok('minSizeVerdict → qualifies null quando non e giudicabile', v.qualifies === null);
}

console.log('\n── 6 · I CASI LIMITE DI PRIMA restano come prima ──');
{
  const noCap = E.estimateAtCapital(RS, null, 632);
  ok('capitale non leggibile → unknown, mai sostituito dai $1.000 di riferimento', noCap.unknown === true && noCap.estUsdPerDay === null);
  const zero = E.estimateAtCapital(RS, 0, 632);
  ok('capitale zero → 0 con il motivo', zero.estUsdPerDay === 0 && /pari a zero/.test(zero.reason));
  const noScore = E.estimateAtCapital({ poolDay: null, refShare: null }, 100, 632);
  ok('book non scorabile → unknown, non zero', noScore.unknown === true && noScore.estUsdPerDay === null);
}

console.log('\n── 7 · LA STIMA DI RIFERIMENTO ($1.000) applica lo stesso minimo ──');
{
  // Un mercato la cui soglia supera i $1.000 di riferimento: 2 × 0.5 × 1200 = $1.200.
  const big = E.estimatedOperatorSharePerDay({ poolDay: 100, mid: 0.5, minSize: 1200, refCapital: 1000, refShare: 0.05 });
  ok('soglia $1.200 contro riferimento $1.000 → 0 anche sul board pubblico', big.estUsdPerDay === 0 && big.belowVenueMinSize === true);
  const okRef = E.estimatedOperatorSharePerDay({ poolDay: 100, mid: 0.5, minSize: 100, refCapital: 1000, refShare: 0.05 });
  ok('soglia $100 contro riferimento $1.000 → stima normale', okRef.estUsdPerDay > 0 && okRef.belowVenueMinSize === false);
  ok('  e il valore e quello di sempre (pot × refShare)', near(okRef.estUsdPerDay, 100 * 0.05));
}

console.log('\n── 8 · LE DUE SUPERFICI ADESSO CONCORDANO ──');
{
  // La regola dell allocatore, riprodotta. ⚠ NON PIU' `(capital/2)/clamp(mid)`: quella era la formula
  // sbagliata, tolta il 12 agosto 2026. Adesso entrambe le superfici passano da `size-da-capitale`, e
  // questo banco lo verifica riproducendo la formula UNICA — se un giorno una delle due tornasse a
  // dividere per il mid, il disaccordo ricomparirebbe qui.
  const SDC__ = require('./rewards/size-da-capitale');
  let disagree = 0, checked = 0;
  for (const mid of [0.03, 0.12, 0.5, 0.675, 0.95]) {
    for (const minSize of [5, 20, 50, 100]) {
      for (const cap of [1, 5, 10, 25, 50, 200, 1000]) {
        checked++;
        const allocatorZero = SDC__.sharePerLato({ capitaleUsd: cap }).shares < minSize;   // net.js
        const est = E.estimateAtCapital({ poolDay: 50, mid, minSize, refCapital: 1000, refShare: 0.02 }, cap, 1e9);
        const estimatorZero = est.estUsdPerDay === 0;                                 // questo modulo
        if (allocatorZero !== estimatorZero) disagree++;
      }
    }
  }
  ok(`allocatore e stima danno lo stesso verdetto su ${checked} combinazioni (prima divergevano)`, disagree === 0);
}

console.log('\nreward-operator-estimate: ' + n + ' passed, 0 failed');
