'use strict';
// lib/maker/distanza-obiettivo.test.js
//
// Il PALETTO NON NEGOZIABILE del test dell'operatore: **qualunque** valore della manopola, l'ordine
// resta dentro la banda premiante e non finisce mai davanti a nessuno. Qui si difendono le due
// proprietà, non il valore di default.

const assert = require('assert');
const D = require('./distanza-obiettivo');
const { planBehindBest } = require('./top-of-book');
const { raggioBandaCents } = require('../banda-premiante');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };

console.log('\n════ ① la manopola vive in UN punto e di default è spenta ════');
ok('il default è «nessun obiettivo»: la posizione non cambia oggi', D.FRAZIONE_DEFAULT === null);
ok('env non impostata ⇒ spenta', D.leggiFrazione({}) === null);
ok('env vuota o non numerica ⇒ spenta, non un valore inventato',
  D.leggiFrazione({ [D.ENV_FRAZIONE]: '' }) === null
  && D.leggiFrazione({ [D.ENV_FRAZIONE]: 'molto' }) === null
  && D.leggiFrazione({ [D.ENV_FRAZIONE]: '0' }) === null
  && D.leggiFrazione({ [D.ENV_FRAZIONE]: '-1' }) === null);
ok('un valore valido si legge', D.leggiFrazione({ [D.ENV_FRAZIONE]: '0.444' }) === 0.444);
ok('  e un valore assurdo si CLAMPA, non si ignora', D.leggiFrazione({ [D.ENV_FRAZIONE]: '10' }) === D.FRAZIONE_MASSIMA);
ok('il nome della manopola è uno solo', D.ENV_FRAZIONE === 'MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V');

console.log('\n════ ② è una FRAZIONE DI v, quindi vale su bande diverse ════');
{
  // La stessa frazione dà distanze diverse su bande diverse, ed è il punto: 0,444 è «poco meno di
  // metà banda» sia su 3,5¢ sia su 5,5¢, mentre «2 centesimi» significherebbe due cose diverse.
  const a = D.distanzaObiettivoCents({ maxSpreadCents: 3.5, frazione: 0.444 });
  const b = D.distanzaObiettivoCents({ maxSpreadCents: 5.5, frazione: 0.444 });
  ok('la distanza scala con la banda', a.distanzaC < b.distanzaC, `${a.distanzaC}¢ vs ${b.distanzaC}¢`);
  ok('  e vale frazione × v', Math.abs(a.distanzaC - 0.444 * raggioBandaCents(3.5)) < 1e-6);
  ok('banda non leggibile ⇒ nessun obiettivo (non si può garantire il bordo che non si è letto)',
    D.distanzaObiettivoCents({ maxSpreadCents: null, frazione: 0.5 }).distanzaC === null);
}

console.log('\n════ ③ PALETTO: mai fuori dalla banda, qualunque valore ════');
{
  const base = { bestOther: 0.49, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 4.5 };
  for (const f of [0.1, 0.25, 0.444, 0.6, 0.9, 0.95, 5, 100]) {
    const r = planBehindBest({ ...base, distanzaObiettivoFrazione: f });
    ok(`frazione ${f}: l'ordine resta DENTRO la banda`,
      r.ok === true && r.price >= r.bandLo - 1e-9 && r.price <= r.bandHi + 1e-9,
      `prezzo ${r.price} su [${r.bandLo}, ${r.bandHi}]`);
  }
  const estremo = planBehindBest({ ...base, distanzaObiettivoFrazione: 100 });
  ok('  un valore assurdo si ferma AL BORDO e lo dichiara',
    estremo.distanzaObiettivo.alBordo === true && estremo.price === estremo.bandLo);
}

console.log('\n════ ④ «mai primo sul libro» è preservato per COSTRUZIONE ════');
{
  const base = { bestOther: 0.49, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 4.5 };
  const senza = planBehindBest(base);
  for (const f of [0.1, 0.25, 0.444, 0.95, 100]) {
    const r = planBehindBest({ ...base, distanzaObiettivoFrazione: f });
    ok(`frazione ${f}: non si finisce MAI davanti al concorrente`, r.onTop === false, `prezzo ${r.price} vs tocco ${base.bestOther}`);
    ok(`  e non ci si avvicina MAI al mid rispetto alla regola di sempre`,
      r.price <= senza.price + 1e-9, `${r.price} <= ${senza.price}`);
  }
}

console.log('\n════ ⑤ è un PAVIMENTO, non un bersaglio ════');
{
  // Se le regole di sempre hanno già messo il prezzo più lontano dell'obiettivo, l'obiettivo non lo
  // riavvicina: riavvicinarlo vorrebbe dire risalire nella coda.
  const r = D.applicaObiettivo({ prezzo: 0.46, scoringMid: 0.50, bandLo: 0.455, distanzaC: 1.0, tick: 0.01 });
  ok('un prezzo già più lontano dell\'obiettivo NON viene riavvicinato', r.prezzo === 0.46 && r.spostato === false);
  const s = D.applicaObiettivo({ prezzo: 0.49, scoringMid: 0.50, bandLo: 0.455, distanzaC: 3.0, tick: 0.01 });
  ok('  e uno più vicino viene allontanato', s.prezzo < 0.49 && s.spostato === true, String(s.prezzo));
  ok('  l\'arrotondamento al tick va LONTANO dal mid, mai verso',
    D.applicaObiettivo({ prezzo: 0.49, scoringMid: 0.50, bandLo: 0.40, distanzaC: 1.5, tick: 0.01 }).prezzo <= 0.485);
  ok('senza obiettivo non tocca niente',
    D.applicaObiettivo({ prezzo: 0.49, scoringMid: 0.50, bandLo: 0.455, distanzaC: null }).spostato === false);
  ok('la distanza EFFETTIVA viene sempre dichiarata, anche a manopola spenta',
    D.applicaObiettivo({ prezzo: 0.49, scoringMid: 0.50, distanzaC: null }).distanzaEffettivaC === 1);
}

console.log('\n════ ⑥ a manopola spenta il comportamento è IDENTICO a prima ════');
{
  for (const caso of [
    { bestOther: 0.49, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 4.5 },
    { bestOther: 0.42, tick: 0.01, scoringMid: 0.445, bandRadiusCents: 4.5 },
    { bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 4.5 },   // ramo «soli»
  ]) {
    const spenta = planBehindBest({ ...caso, distanzaObiettivoFrazione: null, env: {} });
    const esplicita = planBehindBest({ ...caso, env: {} });
    ok(`caso mid ${caso.scoringMid}: spenta ≡ ambiente vuoto`, spenta.price === esplicita.price);
    ok('  e la manopola si dichiara nulla, non assente', spenta.distanzaObiettivo === null);
  }
}

console.log(`\ndistanza-obiettivo: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
