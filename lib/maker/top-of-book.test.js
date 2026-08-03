#!/usr/bin/env node
'use strict';
// MAI IN CIMA AL BOOK — l'aritmetica del posizionamento, esaurita senza venue.
// Il cablaggio nel ciclo (chi lo usa, chi no, la size simmetrica) vive in top-of-book-cycle.test.js.

const {
  bestOtherBid, bandBounds, planBehindBest, followNeedsMove, snap, FALLBACK_OFFSET_CENTS,
} = require('./top-of-book');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const c = (p) => +(p * 100).toFixed(3);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ IL MIGLIOR BID ALTRUI · il book meno noi');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const levels = [
    { price: 0.49, size: 300 },
    { price: 0.48, size: 500 },
    { price: 0.47, size: 100 },
  ];
  const b = bestOtherBid({ levels, ownOrders: [], tick: 0.01 });
  ok('senza ordini nostri il migliore e il primo livello', b.price === 0.49 && b.size === 300);
  ok('  e non siamo soli', b.alone === false && b.levels === 3);
}

console.log('\n── I NOSTRI ORDINI VENGONO TOLTI, altrimenti inseguiremmo noi stessi');
{
  const levels = [{ price: 0.49, size: 300 }, { price: 0.48, size: 500 }];
  // Il livello a 49¢ e' INTERAMENTE nostro: sparisce, e il migliore altrui diventa 48¢.
  const b = bestOtherBid({ levels, ownOrders: [{ price: 0.49, size: 300 }], tick: 0.01 });
  ok('un livello tutto nostro sparisce', b.price === 0.48, `${c(b.price)}c`);
  ok('  e la size che resta e quella altrui', b.size === 500);

  // Parzialmente nostro: resta il residuo altrui, e quel livello e' ancora il migliore.
  const p = bestOtherBid({ levels, ownOrders: [{ price: 0.49, size: 120 }], tick: 0.01 });
  ok('un livello in parte nostro resta, al netto', p.price === 0.49 && p.size === 180, `${p.size} share altrui`);

  // Due nostri ordini sullo stesso livello vanno tolti ENTRAMBI.
  const d = bestOtherBid({ levels, ownOrders: [{ price: 0.49, size: 150 }, { price: 0.49, size: 150 }], tick: 0.01 });
  ok('due ordini nostri sullo stesso livello si sommano', d.price === 0.48, `${c(d.price)}c`);

  // Si usa la size RESIDUA quando c'e': un ordine mezzo eseguito pesa per quel che ne resta.
  const r = bestOtherBid({ levels, ownOrders: [{ price: 0.49, size: 300, sizeRemaining: 100 }], tick: 0.01 });
  ok('conta la size residua, non quella originale', r.price === 0.49 && r.size === 200, `${r.size} share`);
}

console.log('\n── SIAMO SOLI: è un fatto, e ha un nome suo');
{
  const b = bestOtherBid({ levels: [{ price: 0.49, size: 300 }], ownOrders: [{ price: 0.49, size: 300 }], tick: 0.01 });
  ok('tolti i nostri non resta nessuno ⇒ alone', b.alone === true && b.price === null);
  ok('  ma il book E stato letto', b.readable === true, 'e diverso da «non ho letto»');
  ok('  e lo dice', /non resta nessun altro/.test(b.reason), b.reason.slice(0, 50));

  const nl = bestOtherBid({ levels: null, ownOrders: [], tick: 0.01 });
  ok('nessun livello pubblicato ⇒ NON leggibile, non «soli»', nl.readable === false && nl.alone === false,
    'un book non letto non e un book vuoto');
  ok('tick assente ⇒ non leggibile', bestOtherBid({ levels: [{ price: 0.4, size: 1 }], tick: null }).readable === false);
}

console.log('\n── un residuo di arrotondamento non e «un altro partecipante»');
{
  const b = bestOtherBid({ levels: [{ price: 0.49, size: 300.0000001 }, { price: 0.48, size: 50 }], ownOrders: [{ price: 0.49, size: 300 }], tick: 0.01 });
  ok('un residuo sotto la tolleranza sparisce', b.price === 0.48, `${c(b.price)}c`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ I BORDI DELLA BANDA · agganciati VERSO L INTERNO');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const b = bandBounds({ scoringMid: 0.50, bandRadiusCents: 2.25, tick: 0.001 });
  ok('bordo basso arrotondato in SU', b.lo === 0.478, String(b.lo));
  ok('bordo alto arrotondato in GIU', b.hi === 0.522, String(b.hi));
  ok('  cosi un prezzo sul bordo e davvero dentro', Math.abs(0.5 - b.lo) * 100 <= 2.25 && Math.abs(0.5 - b.hi) * 100 <= 2.25);
  ok('banda piu stretta di un tick ⇒ non leggibile', bandBounds({ scoringMid: 0.5, bandRadiusCents: 0.4, tick: 0.01 }).readable === false);
  ok('senza banda ⇒ non leggibile', bandBounds({ scoringMid: 0.5, bandRadiusCents: null, tick: 0.01 }).readable === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ DOVE VA L ORDINE');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25, fallbackOffsetCents: 1 };
  const p = planBehindBest({ ...base, bestOther: 0.495 });
  ok('un tick dietro il migliore altrui', p.ok && p.price === 0.494, `${c(p.price)}c dietro ${c(0.495)}c`);
  ok('  modo «behind-best»', p.mode === 'behind-best');
  ok('  e NON siamo in cima', p.onTop === false);
  ok('  la distanza dal mid e un RISULTATO, non un parametro', p.offsetCents === 0.6, `${p.offsetCents}¢`);
}

console.log('\n── la distanza dal mid cambia col book, senza che nessuno la configuri');
{
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25, fallbackOffsetCents: 1 };
  const vicino = planBehindBest({ ...base, bestOther: 0.499 });
  const lontano = planBehindBest({ ...base, bestOther: 0.490 });
  ok('book fitto vicino al mid ⇒ stiamo vicini', vicino.offsetCents === 0.2, `${vicino.offsetCents}¢`);
  ok('book largo ⇒ stiamo larghi', lontano.offsetCents === 1.1, `${lontano.offsetCents}¢`);
  ok('  stesso mercato, stessa configurazione, due distanze', vicino.offsetCents !== lontano.offsetCents);
}

console.log('\n── LA BANDA E IL LIMITE SUPERIORE: un tick dietro non porta mai fuori');
{
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25, fallbackOffsetCents: 1 };
  // Tutti gli altri quotano lontanissimo: un tick dietro cadrebbe a 46¢, fuori dalla banda (47.8-52.2).
  const p = planBehindBest({ ...base, bestOther: 0.461 });
  ok('un tick dietro cadrebbe fuori banda ⇒ ci si ferma al bordo', p.ok && p.price === 0.478, `${c(p.price)}c`);
  ok('  modo «band-clamped»', p.mode === 'band-clamped');
  ok('  e resta dentro il raggio', Math.abs(0.5 - p.price) * 100 <= 2.25);

  // LA CONSEGUENZA, DICHIARATA: fermarsi al bordo ci mette IN CIMA al book. E' la scelta voluta —
  // fuori banda si matura zero — e deve essere visibile, non nascosta.
  ok('  e questo ci mette IN CIMA, dichiarato', p.onTop === true,
    'la banda vince sul «mai in cima», perche fuori banda non si matura nulla');
  ok('  a parole', /IN CIMA al book/.test(p.reason), p.reason.slice(-80));
}

console.log('\n── IL RIPIEGO quando siamo gli unici sul lato');
{
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25 };
  const p = planBehindBest({ ...base, bestOther: null, fallbackOffsetCents: 1 });
  ok('nessun altro ⇒ offset configurato dal mid', p.ok && p.price === 0.49, `${c(p.price)}c`);
  ok('  modo «fallback-alone»', p.mode === 'fallback-alone');
  ok('  e «in cima» non e affermabile: non c e nessuno con cui confrontarsi', p.onTop === null);
  ok('  e reversibile da se, e lo dice', /finché non ricompare un altro partecipante/.test(p.reason), p.reason.slice(-60));

  // Senza offset configurato si usa il default interno — non si resta senza risposta.
  const d = planBehindBest({ ...base, bestOther: null, fallbackOffsetCents: null });
  ok('senza offset configurato vale il default interno', d.ok && d.offsetCents === FALLBACK_OFFSET_CENTS, `${d.offsetCents}¢`);
}

console.log('\n── il ripiego rispetta la banda come tutto il resto');
{
  const p = planBehindBest({ bestOther: null, tick: 0.001, scoringMid: 0.50, bandRadiusCents: 1.0, fallbackOffsetCents: 5 });
  ok('un offset di ripiego piu largo della banda viene agganciato al bordo', p.price === 0.49, `${c(p.price)}c`);
  ok('  e dichiarato «band-clamped»', p.mode === 'band-clamped');
}

console.log('\n── la griglia del tick, sempre');
{
  const p = planBehindBest({ bestOther: 0.4955, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 4, fallbackOffsetCents: 1 });
  ok('un prezzo fuori griglia viene agganciato', p.ok && Math.abs(p.price / 0.01 - Math.round(p.price / 0.01)) < 1e-9, String(p.price));
  ok('  snap() e la stessa funzione', snap(0.4849, 0.01) === 0.48);
}

console.log('\n── cio che non si legge non produce un prezzo');
{
  for (const [et, a] of [
    ['tick assente', { bestOther: 0.49, tick: null, scoringMid: 0.5, bandRadiusCents: 2.25 }],
    ['mid assente', { bestOther: 0.49, tick: 0.01, scoringMid: null, bandRadiusCents: 2.25 }],
    ['mid fuori da (0,1)', { bestOther: 0.49, tick: 0.01, scoringMid: 1.2, bandRadiusCents: 2.25 }],
    ['banda assente', { bestOther: 0.49, tick: 0.01, scoringMid: 0.5, bandRadiusCents: null }],
    ['nessun argomento', undefined],
  ]) {
    const v = a === undefined ? planBehindBest() : planBehindBest(a);
    ok(`  ${et} ⇒ nessun prezzo`, v.ok === false && v.price === null, (v.reason || '').slice(0, 55));
  }
  ok('senza banda si RIFIUTA invece di ripiegare su «dove capita»',
    /non sarebbe garantibile/.test(planBehindBest({ bestOther: 0.49, tick: 0.01, scoringMid: 0.5, bandRadiusCents: null }).reason));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ SI SPOSTA? · il bersaglio si muove col book, la soglia lo tiene fermo');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  ok('nessun ordine a riposo ⇒ si piazza', followNeedsMove({ restingPrice: null, targetPrice: 0.494, minMoveCents: 1 }).move === true);
  const fermo = followNeedsMove({ restingPrice: 0.494, targetPrice: 0.4945, minMoveCents: 1, tick: 0.001 });
  ok('bersaglio a 0.05¢ con soglia 1¢ ⇒ non si tocca', fermo.move === false, `${fermo.deltaCents}¢`);
  ok('  ed e la STESSA soglia gia configurata, non una nuova', /soglia di 1¢/.test(fermo.reason));
  const muove = followNeedsMove({ restingPrice: 0.494, targetPrice: 0.482, minMoveCents: 1, tick: 0.001 });
  ok('bersaglio a 1.2¢ con soglia 1¢ ⇒ si sposta', muove.move === true, `${muove.deltaCents}¢`);
  ok('senza bersaglio non si decide nulla', followNeedsMove({ restingPrice: 0.49, targetPrice: null }).move === false);
  const senzaSoglia = followNeedsMove({ restingPrice: 0.494, targetPrice: 0.4935, minMoveCents: null, tick: 0.001 });
  ok('soglia assente ⇒ si ripiega sul tick, non su zero', senzaSoglia.move === false, `${senzaSoglia.deltaCents}¢ contro un tick`);
}

console.log(`\nmai in cima al book: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
