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
  // ⚠ Dal 15 agosto 2026 il paletto non e' piu' il bordo NUDO ma il bordo meno il margine
  // anti-oscillazione (`bordiConMargine`), e la proprieta' difesa resta la stessa: un valore assurdo
  // non produce un ordine fuori banda, produce l'ordine piu' lontano AMMESSO, e lo dichiara.
  {
    const b = require('./distanza-obiettivo').bordiConMargine({ bandLo: estremo.bandLo, bandHi: estremo.bandHi, tick: base.tick });
    ok('  un valore assurdo si ferma AL BORDO AMMESSO e lo dichiara',
      estremo.distanzaObiettivo.alBordo === true && estremo.price === (b.applicato ? b.lo : estremo.bandLo),
      `prezzo ${estremo.price} · bordo nudo ${estremo.bandLo} · margine ${b.applicato ? b.margineTick + ' tick' : 'non applicato'}`);
    ok('  e non esce comunque dalla banda', estremo.price >= estremo.bandLo - 1e-12);
  }
}

console.log('\n════ ③-bis IL MARGINE DAL BORDO — adattivo alla BANDA, non alla griglia ════');
{
  // ⚠ QUESTO BLOCCO NASCE DA UN DIFETTO TROVATO DALL'ANTEPRIMA DEL PIANO, non dal ragionamento: con il
  // margine misurato in soli TICK, sul mercato «Ballon d'Or» (tick 0,1¢) l'ordine finiva a 4,4¢ dal mid
  // con punteggio 0,0011 — cioè sul bordo nudo, che è esattamente ciò che il margine esiste per evitare.
  // Un tick su una griglia fine non è un margine, è un arrotondamento.
  const casi = [
    { nome: 'banda modale, tick grosso', tick: 0.01, v: 4.5, tickAttesi: 1 },
    { nome: 'stessa banda, tick fine', tick: 0.001, v: 4.5, tickAttesi: 10 },
    { nome: 'banda larga, tick fine', tick: 0.001, v: 6.5, tickAttesi: 15 },
  ];
  for (const c of casi) {
    const m = D.margineEffettivoTick({ tick: c.tick, maxSpreadCents: c.v });
    ok(`${c.nome}: margine ${m} tick`, m === c.tickAttesi, `${(m * c.tick * 100).toFixed(2)}¢`);
  }
  // LA PROPRIETÀ, che è il punto: a parità di banda il margine in CENTESIMI è lo stesso su qualunque
  // griglia. È questo che rende gli ordini confrontabili fra mercati.
  const a = D.margineEffettivoTick({ tick: 0.01, maxSpreadCents: 4.5 }) * 1.0;
  const b = D.margineEffettivoTick({ tick: 0.001, maxSpreadCents: 4.5 }) * 0.1;
  ok('  a parità di banda il margine in centesimi NON dipende dal tick', Math.abs(a - b) < 1e-9, `${a}¢ contro ${b}¢`);
  // ⚠ IL TETTO A METÀ BANDA, e questa asserzione è nata da un SECONDO difetto, trovato dal selfcheck
  // del riprezzo: su banda ±1,5¢ con tick 1,0¢ un tick di margine portava il bersaglio da 0,52 a 0,53,
  // che È il mid. Il margine difende il bordo esterno, non lo sostituisce col centro — quindi si ferma
  // a v/2, e su una banda più stretta di due tick vale ZERO. Un margine che non ci sta è un margine
  // assente, mai un prezzo diverso da quello che si è chiesto.
  ok('  il margine non supera MAI metà banda: ±1,5¢ con tick 1,0¢ ⇒ 0 tick, bordo nudo',
    D.margineEffettivoTick({ tick: 0.01, maxSpreadCents: 3 /* v = 1,5¢ */ }) === 1
    && D.margineEffettivoTick({ tick: 0.01, maxSpreadCents: 1.5 /* v = 0,75¢ */ }) === 0);
  for (const [tick, ms] of [[0.01, 4.5], [0.001, 4.5], [0.001, 6.5], [0.01, 1.5], [0.005, 3], [0.01, 0.5]]) {
    const v = require('../banda-premiante').raggioBandaCents(ms);
    const m = D.margineEffettivoTick({ tick, maxSpreadCents: ms });
    ok(`  proprietà · tick ${tick * 100}¢ banda ±${v}¢ ⇒ margine ${(m * tick * 100).toFixed(2)}¢ ≤ metà banda`,
      m * tick * 100 <= v * D.FRAZIONE_MASSIMA_DEL_RAGGIO + 1e-9);
  }
  // Banda non leggibile ⇒ resta il solo pavimento in tick: non si inventa una frazione di un numero assente.
  ok('  banda non leggibile ⇒ solo il pavimento in tick, nessuna frazione inventata',
    D.margineEffettivoTick({ tick: 0.01, maxSpreadCents: null }) === D.MARGINE_BORDO_TICK_DEFAULT);
  // La frazione di difetto NON è un numero nuovo: è quanto vale un tick sulla banda modale.
  ok('  la frazione di difetto è quanto vale UN tick sulla banda modale, non un numero nuovo',
    Math.abs(D.MARGINE_BORDO_FRAZIONE_DEFAULT - 1.0 / 4.5) < 0.005, String(D.MARGINE_BORDO_FRAZIONE_DEFAULT));
  // Un env illeggibile vale il DIFETTO, mai zero: un valore sbagliato non può spegnere il margine.
  for (const cattivo of ['abc', '-1', '1.5', '']) {
    ok(`  frazione «${cattivo}» ⇒ difetto, non zero`,
      D.leggiMargineBordoFrazione({ [D.ENV_MARGINE_FRAZIONE]: cattivo }) === D.MARGINE_BORDO_FRAZIONE_DEFAULT);
  }
  // ⚠ E IL MARGINE NON PUÒ MAI PORTARE UN ORDINE FUORI BANDA: stringe, non allarga. Spazzata.
  let fuori = 0; let n = 0;
  for (const tick of [0.01, 0.001]) {
    for (const v of [1, 2.25, 3, 4.5, 6.5, 10]) {
      for (const mid of [0.10, 0.30, 0.50, 0.70, 0.90]) {
        const b = require('./top-of-book').bandBounds({ scoringMid: mid, bandRadiusCents: v, tick });
        if (!b.readable) continue;
        const bm = D.bordiConMargine({ bandLo: b.lo, bandHi: b.hi, tick, maxSpreadCents: v });
        n += 1;
        if (bm.applicato && (bm.lo < b.lo - 1e-12 || bm.hi > b.hi + 1e-12 || bm.lo > bm.hi + 1e-12)) fuori += 1;
      }
    }
  }
  ok(`spazzata di ${n} bande: il margine STRINGE sempre, non allarga mai`, fuori === 0, `${fuori} anomalie`);
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
