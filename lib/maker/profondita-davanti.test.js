#!/usr/bin/env node
'use strict';
// LA PROTEZIONE DI PROFONDITÀ — arretrare finché davanti non c'è N volte la propria size.
//
// Su tick fine «un tick dietro» lascia l'ordine a 0,1¢ dal mid invece che a 1¢: ottimo per il
// punteggio, pessimo per l'adverse selection, perché si è quasi in cima al libro. Questa regola
// arretra oltre il minimo finché davanti non c'è abbastanza roba da assorbire un ordine aggressivo.
//
// Le tre cose che questo file deve dimostrare, e in quest'ordine di priorità:
//   a. «mai primi» resta intatto — non si torna MAI davanti al minimo;
//   b. la BANDA vince sulla profondità — non si esce mai dalla banda per soddisfare N;
//   c. con N assente o 0 il comportamento è IDENTICO a prima, byte per byte.

const { othersLadder, depthAheadOf, planBehindBest } = require('./top-of-book');
const { prezzoInCoda } = require('./prezzo-in-coda');
const { validateOffset } = require('./offset-config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, e = 1e-9) => a != null && b != null && Math.abs(a - b) < e;

// Un book a tick 0,001: mid 0.500, banda ±2,25¢ ⇒ [0.478 … 0.522] agganciata al tick.
const TICK = 0.001;
const MID = 0.5;
const BANDA = 4.5;
const LIVELLI = [
  { price: 0.499, size: 20 },   // il migliore altrui
  { price: 0.498, size: 30 },
  { price: 0.497, size: 50 },
  { price: 0.496, size: 400 },
  { price: 0.495, size: 900 },
];

console.log('\n══ 1 · LA SCALA ALTRUI È UNA SOLA SOTTRAZIONE, E LA TESTA È IL MIGLIOR ALTRUI');
{
  const nostro = [{ price: 0.499, size: 12 }];
  const L = othersLadder({ levels: LIVELLI, ownOrders: nostro, tick: TICK });
  ok('i nostri vengono sottratti livello per livello', L.readable && vicino(L.levels[0].size, 8), `20 − 12 = ${L.levels[0].size}`);
  ok('  e il livello resta al suo posto se resta qualcun altro', vicino(L.levels[0].price, 0.499));
  const tutto = othersLadder({ levels: [{ price: 0.499, size: 12 }], ownOrders: nostro, tick: TICK });
  ok('un livello INTERAMENTE nostro sparisce (niente residuo di arrotondamento)', tutto.alone === true);
  ok('feed assente ≠ book vuoto', othersLadder({ levels: null, ownOrders: [], tick: TICK }).readable === false);
}

console.log('\n══ 2 · «DAVANTI» È STRETTAMENTE MEGLIO, MAI ALLA PARI');
{
  const L = othersLadder({ levels: LIVELLI, ownOrders: [], tick: TICK }).levels;
  ok('a 0.499 (il migliore) davanti non c è nessuno', vicino(depthAheadOf(L, 0.499), 0));
  ok('a 0.498 davanti c è solo il primo livello', vicino(depthAheadOf(L, 0.498), 20));
  ok('a 0.497 davanti ci sono i primi due', vicino(depthAheadOf(L, 0.497), 50));
  ok('a 0.496 i primi tre', vicino(depthAheadOf(L, 0.496), 100));
  ok('a 0.495 i primi quattro', vicino(depthAheadOf(L, 0.495), 500));
  // Un livello allo STESSO prezzo non protegge: è priorità temporale, non di prezzo.
  ok('un livello al NOSTRO stesso prezzo non conta come protezione', vicino(depthAheadOf(L, 0.499), 0));
}

console.log('\n══ 3 · CON N ASSENTE O 0 IL COMPORTAMENTO È QUELLO DI SEMPRE');
{
  const base = { bestOther: 0.499, tick: TICK, scoringMid: MID, bandRadiusCents: BANDA / 2 };
  const senza = planBehindBest(base);
  const zero = planBehindBest({ ...base, depthMultiple: 0, ownSize: 100, ladder: othersLadder({ levels: LIVELLI, ownOrders: [], tick: TICK }).levels });
  ok('senza il parametro: un tick dietro, 0.498', senza.ok && vicino(senza.price, 0.498), String(senza.price));
  ok('con N=0: lo stesso prezzo identico', zero.ok && vicino(zero.price, senza.price), String(zero.price));
  ok('  e nessun blocco `depth` sul verdetto', senza.depth == null && zero.depth == null);
  ok('  e lo stesso `mode`', senza.mode === 'behind-best' && zero.mode === 'behind-best');
  // Anche senza size o senza scala la regola non si inventa un arretramento.
  const senzaSize = planBehindBest({ ...base, depthMultiple: 2, ownSize: null, ladder: LIVELLI });
  const senzaScala = planBehindBest({ ...base, depthMultiple: 2, ownSize: 100, ladder: null });
  ok('N senza size ⇒ comportamento di sempre', vicino(senzaSize.price, 0.498) && senzaSize.depth == null);
  ok('N senza scala leggibile ⇒ comportamento di sempre', vicino(senzaScala.price, 0.498) && senzaScala.depth == null);
}

console.log('\n══ 4 · SI ARRETRA FINCHÉ DAVANTI NON C È N × LA PROPRIA SIZE');
{
  const L = othersLadder({ levels: LIVELLI, ownOrders: [], tick: TICK }).levels;
  const base = { bestOther: 0.499, tick: TICK, scoringMid: MID, bandRadiusCents: BANDA / 2, ladder: L };
  // size 25, N=2 ⇒ soglia 50. A 0.497 davanti ci sono esattamente 50 ⇒ ci si ferma lì.
  const r = planBehindBest({ ...base, depthMultiple: 2, ownSize: 25 });
  ok('N=2 su size 25 (soglia 50) ⇒ si ferma a 0.497', r.ok && vicino(r.price, 0.497), String(r.price));
  ok('  con 50 share davanti, esattamente la soglia', vicino(r.depth.depthAhead, 50) && vicino(r.depth.required, 50));
  // `ticksBack` conta i tick OLTRE il minimo, non dal miglior altrui: dal minimo 0.498 a 0.497 è UNO.
  ok('  arretrato di 1 tick oltre il minimo 0.498', r.depth.ticksBack === 1 && vicino(r.depth.minPrice, 0.498),
    `${r.depth.ticksBack} tick oltre ${r.depth.minPrice}`);
  ok('  e lo dichiara: fermato dalla SOGLIA', r.depth.stoppedBy === 'soglia');
  ok('  con il suo `mode` distinto', r.mode === 'behind-best-depth');
  // Soglia già soddisfatta al minimo ⇒ non si arretra affatto.
  const gia = planBehindBest({ ...base, depthMultiple: 0.5, ownSize: 20 }); // soglia 10, a 0.498 davanti 20
  ok('soglia già soddisfatta al minimo ⇒ nessun arretramento', vicino(gia.price, 0.498) && gia.depth.ticksBack === 0);
}

console.log('\n══ 5 · LA BANDA VINCE SULLA PROFONDITÀ — PRIORITÀ (b)');
{
  // Banda strettissima: ±0,25¢ ⇒ [0.4975 … 0.5025] → agganciata [0.498 … 0.502].
  const L = othersLadder({ levels: LIVELLI, ownOrders: [], tick: TICK }).levels;
  const r = planBehindBest({
    bestOther: 0.499, tick: TICK, scoringMid: MID, bandRadiusCents: 0.25,
    depthMultiple: 10, ownSize: 1000, ladder: L,   // soglia 10.000: irraggiungibile
  });
  ok('con una soglia irraggiungibile ci si ferma al bordo, NON fuori', r.ok && r.price >= 0.498 - 1e-9, String(r.price));
  ok('  e si accetta una protezione inferiore alla soglia', r.depth.depthAhead < r.depth.required);
  ok('  dichiarando che ha fermato il BORDO BANDA', r.depth.stoppedBy === 'bordo-banda');
  ok('  il prezzo resta dentro la banda', r.price >= r.bandLo - 1e-9 && r.price <= r.bandHi + 1e-9);
}

console.log('\n══ 6 · «MAI PRIMI» RESTA IL VINCOLO ASSOLUTO — PRIORITÀ (a) e (c)');
{
  const L = othersLadder({ levels: LIVELLI, ownOrders: [], tick: TICK }).levels;
  // Qualunque N, il prezzo non può MAI risalire sopra il minimo (un tick dietro).
  for (const N of [0.5, 1, 1.5, 2, 5, 10]) {
    const r = planBehindBest({ bestOther: 0.499, tick: TICK, scoringMid: MID, bandRadiusCents: BANDA / 2, depthMultiple: N, ownSize: 60, ladder: L });
    if (!(r.ok && r.price <= 0.498 + 1e-9 && r.price < 0.499 - 1e-9)) {
      ok(`N=${N}: mai davanti al minimo`, false, String(r.price)); break;
    }
    if (N === 10) ok('a ogni N da 0,5 a 10 il prezzo resta ≤ minimo e sotto il migliore altrui', true);
  }
  // (c) se già il minimo è fuori banda, il lato NON si quota — e la profondità non lo cambia.
  const fuori = planBehindBest({
    bestOther: 0.46, tick: TICK, scoringMid: MID, bandRadiusCents: 0.5,   // minimo 0.459, banda [0.495…0.505]
    depthMultiple: 2, ownSize: 25, ladder: L,
  });
  ok('minimo già fuori banda ⇒ non si quota (quotabile false)', fuori.ok === false && fuori.quotabile === false);
  ok('  col motivo di sempre', fuori.mode === 'behind-best-fuori-banda');
  // Soli sul lato: la profondità NON si applica (davanti non c è nessuno a qualunque prezzo).
  const soli = planBehindBest({ bestOther: null, tick: TICK, scoringMid: MID, bandRadiusCents: BANDA / 2, fallbackOffsetCents: 1, depthMultiple: 2, ownSize: 25, ladder: [] });
  ok('soli sul lato ⇒ nessun arretramento per profondità', soli.ok && soli.depth == null && soli.mode === 'fallback-alone');
}

console.log('\n══ 7 · LA VENDITA USA LA STESSA ARITMETICA, SPECCHIATA');
{
  // Un ASK a p è un BID a 1−p. Gli ask a 0.501/0.502/0.503 specchiano i bid a 0.499/0.498/0.497.
  const rules = {
    readable: true, tick: TICK, maxSpreadCents: BANDA,
    books: { yes: { scoringMid: MID }, no: { scoringMid: MID } },
  };
  const depth = { yes: { bids: LIVELLI, asks: [{ price: 0.501, size: 20 }, { price: 0.502, size: 30 }, { price: 0.503, size: 50 }, { price: 0.504, size: 400 }] }, no: null };
  const acq = prezzoInCoda({ book: 'yes', side: 'BUY', rules, depth, ownOrders: [], depthMultiple: 2, ownSize: 25 });
  const ven = prezzoInCoda({ book: 'yes', side: 'SELL', rules, depth, ownOrders: [], depthMultiple: 2, ownSize: 25 });
  ok('acquisto: si ferma a 0.497', acq.ok && vicino(acq.price, 0.497), String(acq.price));
  ok('vendita: si ferma a 0.503, lo specchio esatto', ven.ok && vicino(ven.price, 0.503), String(ven.price));
  ok('  con la stessa profondità davanti', vicino(acq.depth.depthAhead, ven.depth.depthAhead), `${acq.depth.depthAhead}`);
  ok('  e lo stesso numero di tick arretrati', acq.depth.ticksBack === ven.depth.ticksBack);
  ok('  e il minimo specchiato indietro correttamente', vicino(ven.depth.minPrice, 0.502), String(ven.depth.minPrice));
}

console.log('\n══ 8 · IL PARAMETRO SI CONFIGURA, E ZERO È UN VALORE VALIDO (È LO SPEGNIMENTO)');
{
  const v = (d) => validateOffset({ depthMultiple: d, bandRadiusCents: 2.25, tick: TICK });
  ok('N = 0 è valido (spegne la protezione)', v(0).valid);
  ok('N = 1.5 è valido', v(1.5).valid);
  ok('N = 2 è valido', v(2).valid);
  ok('N negativo è RIFIUTATO, non trattato come zero', !v(-1).valid);
  ok('N oltre il massimo è rifiutato', !v(999).valid, v(999).errors[0] && v(999).errors[0].detail.slice(0, 60));
  ok('N assente non è un errore', validateOffset({ targetOffsetCents: 1, bandRadiusCents: 2.25, tick: TICK }).valid);
}

console.log(`\nprofondità davanti: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
