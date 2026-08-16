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

console.log('\n── IL CONFLITTO CON LA BANDA: adesso vince «mai primi», e si rinuncia al mercato');
{
  // ── LA PRIORITA' E' STATA INVERTITA IL 5 AGOSTO 2026 ──────────────────────────────────────────
  // Questo blocco pretendeva il contrario: un tick dietro fuori banda ⇒ aggancio al bordo, `onTop:true`,
  // «la banda vince sul mai in cima, perche fuori banda non si matura nulla».
  // La decisione e' cambiata, e il motivo e' che i due costi non sono commensurabili: il reward di un
  // mercato e' un numero noto e limitato, il costo di essere il primo a essere eseguito da chi sa
  // qualcosa che noi non sappiamo non lo e'. Meglio non impegnare capitale che impegnarlo nel posto
  // peggiore del libro.
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25, fallbackOffsetCents: 1 };
  // Tutti gli altri quotano lontanissimo: un tick dietro cadrebbe a 46¢, fuori dalla banda (47.8-52.2).
  const p = planBehindBest({ ...base, bestOther: 0.461 });
  ok('un tick dietro cadrebbe fuori banda ⇒ NON SI QUOTA', p.ok === false && p.price === null);
  ok('  modo «behind-best-fuori-banda»', p.mode === 'behind-best-fuori-banda');
  ok('  e la risposta e «non quotare», non «non so»', p.quotabile === false);
  ok('  con il motivo a parole', /fuori dalla banda premiante/.test(p.reason) && /non si quota/.test(p.reason));
  ok('  e NON si aggancia piu al bordo', p.price !== 0.478,
    'era il vecchio comportamento: 47,8¢ in cima al libro');
  ok('  ne si dichiara in cima, perche non ci si mette', p.onTop === false);
}

console.log('\n── IL RIPIEGO quando siamo gli unici sul lato');
{
  const base = { tick: 0.001, scoringMid: 0.50, bandRadiusCents: 2.25 };
  const p = planBehindBest({ ...base, bestOther: null, fallbackOffsetCents: 1 });
  // ⚠ REGOLA CAMBIATA IL 12 AGOSTO 2026, decisione dell'operatore. Prima: offset configurato dal mid,
  // agganciato al bordo solo se cadeva fuori. Adesso: il BORDO ESTERNO della banda e' il bersaglio.
  // Il motivo non e' evitare la prima posizione — senza concorrenti ci si sta per forza — ma stare al
  // prezzo PEGGIORE che resta premiante, cosi' il fill e' improbabile e il reward matura comunque.
  // ⚠ Dal 15 agosto 2026 il bersaglio e' il bordo MENO il margine anti-oscillazione: si chiede alla
  // stessa funzione che decide (`bordiConMargine`) invece di ricopiarne il risultato, cosi' l'asserzione
  // resta vera a margine 0 (bordo nudo) come a margine 2.
  const bmA = require('./distanza-obiettivo').bordiConMargine({ bandLo: p.bandLo, bandHi: p.bandHi, tick: base.tick, maxSpreadCents: base.bandRadiusCents });
  ok('nessun altro ⇒ BORDO ESTERNO ammesso della banda, non un offset dal mid',
    p.ok && p.price === (bmA.applicato ? bmA.lo : p.bandLo), `${c(p.price)}c su banda [${c(p.bandLo)}-${c(p.bandHi)}]c`);
  ok('  e comunque dentro banda', p.price >= p.bandLo - 1e-12 && p.price <= p.bandHi + 1e-12);
  ok('  cioe\' il prezzo piu\' LONTANO dal mid che resta in banda', p.price < base.scoringMid);
  ok('  modo «fallback-alone-bordo-esterno»', p.mode === 'fallback-alone-bordo-esterno');
  ok('  e «in cima» non e affermabile: non c e nessuno con cui confrontarsi', p.onTop === null);
  ok('  e reversibile da se, e lo dice', /si torna a un tick dietro/.test(p.reason), p.reason.slice(-60));

  // L'offset configurato NON entra piu' nel calcolo: il bordo dipende solo da mid, raggio e tick.
  const d = planBehindBest({ ...base, bestOther: null, fallbackOffsetCents: null });
  ok('l\'offset configurato non cambia piu\' il prezzo del ramo «soli»', d.ok && d.price === p.price, `${c(d.price)}c`);
  const largo = planBehindBest({ ...base, bestOther: null, fallbackOffsetCents: 99 });
  ok('  e nemmeno un offset assurdo', largo.ok && largo.price === p.price, `${c(largo.price)}c`);
  void FALLBACK_OFFSET_CENTS;
}

console.log('\n── il ripiego rispetta la banda come tutto il resto');
{
  // Con il bordo esterno come bersaglio l'aggancio non serve piu': il prezzo NASCE in banda. Cio' che
  // va difeso e' che resti dentro, qualunque siano tick e raggio.
  const p = planBehindBest({ bestOther: null, tick: 0.001, scoringMid: 0.50, bandRadiusCents: 1.0, fallbackOffsetCents: 5 });
  ok('il ramo «soli» nasce gia\' in banda, senza bisogno di aggancio',
    p.ok && p.price >= p.bandLo && p.price <= p.bandHi, `${c(p.price)}c in [${c(p.bandLo)}-${c(p.bandHi)}]c`);
  // Il bordo inferiore MENO il margine anti-oscillazione: la stessa funzione che decide, non il numero.
  ok('  ed e\' il bordo inferiore ammesso, cioe\' il piu\' lontano dal mid nello spazio bid',
    (() => { const b = require('./distanza-obiettivo').bordiConMargine({ bandLo: p.bandLo, bandHi: p.bandHi, tick: 0.001, maxSpreadCents: 1.0 });
      return p.price === (b.applicato ? b.lo : p.bandLo); })());
  ok('  dichiarato come tale', p.mode === 'fallback-alone-bordo-esterno');
  // Sweep: nessuna combinazione produce un prezzo fuori banda o fuori dai limiti del libro.
  let fuori = 0; let prodotti = 0;
  for (const mid of [0.05, 0.2, 0.5, 0.8, 0.95]) {
    for (const raggio of [0.5, 1, 2, 4.5, 10]) {
      for (const tick of [0.001, 0.01, 0.1]) {
        const q = planBehindBest({ bestOther: null, tick, scoringMid: mid, bandRadiusCents: raggio });
        if (!q.ok) continue;
        prodotti += 1;
        if (q.price < q.bandLo - 1e-9 || q.price > q.bandHi + 1e-9 || !(q.price > 0 && q.price < 1)) fuori += 1;
      }
    }
  }
  ok(`sweep su ${prodotti} prezzi del ramo «soli»: ZERO fuori banda o fuori dai limiti`, fuori === 0, `fuori ${fuori}`);
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
