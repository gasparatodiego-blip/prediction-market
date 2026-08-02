#!/usr/bin/env node
'use strict';
// La traduzione «riga toccata sul book → offset del motore». Aritmetica pura: nessun browser, nessuna
// rete, nessun ordine. E' l'unica logica nuova del flusso al tocco, e qui viene esaurita ai bordi.

const { offsetFromPrice, planQuotes } = require('./mm-quote-math');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// Mercato tipico: mid 32.5¢, tick 1¢, banda ±2.25¢.
const M = { mid: 0.325, tick: 0.01, bandRadiusCents: 2.25 };

console.log('\n── la distanza dal mid, in centesimi');
{
  ok('riga a 30¢ dista 2.5¢ → limitato a 2.25¢ dalla banda',
    offsetFromPrice({ ...M, price: 0.30 }) === 2.25, String(offsetFromPrice({ ...M, price: 0.30 })));
  ok('riga a 32¢ dista 0.5¢ → 1¢ (un tick, il minimo)',
    offsetFromPrice({ ...M, price: 0.32 }) === 1, String(offsetFromPrice({ ...M, price: 0.32 })));
  ok('riga a 31¢ dista 1.5¢ → 2¢ sul tick',
    offsetFromPrice({ ...M, price: 0.31 }) === 2, String(offsetFromPrice({ ...M, price: 0.31 })));
  // Simmetria: sopra e sotto il mid la distanza e' la stessa, perche' l'offset e' un raggio.
  ok('un ask e un bid equidistanti danno lo stesso offset',
    offsetFromPrice({ ...M, price: 0.345 }) === offsetFromPrice({ ...M, price: 0.305 }),
    `${offsetFromPrice({ ...M, price: 0.345 })}¢ da entrambi i lati`);
}

console.log('\n── MAI SOTTO UN TICK: un offset 0 farebbe incrociare i due lati fra loro');
{
  ok('toccare esattamente il mid ⇒ 1 tick, non 0', offsetFromPrice({ ...M, price: 0.325 }) === 1);
  ok('  e con tick 0.001 ⇒ 0.1¢, non 0',
    offsetFromPrice({ mid: 0.5, tick: 0.001, bandRadiusCents: 2.25, price: 0.5 }) === 0.1,
    String(offsetFromPrice({ mid: 0.5, tick: 0.001, bandRadiusCents: 2.25, price: 0.5 })));
  // Il valore minimo che il registro accetta e' 0.1¢: quello che esce di qui dev'essere accettabile.
  const { LIMITS } = require('./mm-tracking-config');
  ok('  il minimo prodotto non e mai sotto il minimo del registro',
    offsetFromPrice({ ...M, price: 0.325 }) >= LIMITS.offsetCents.min, `min registro ${LIMITS.offsetCents.min}¢`);
}

console.log('\n── MAI OLTRE IL RAGGIO PREMIANTE: non si suggerisce una configurazione che matura zero');
{
  ok('riga lontanissima (10¢) ⇒ limitato a 2.25¢', offsetFromPrice({ ...M, price: 0.225 }) === 2.25);
  ok('riga a 20¢ ⇒ limitato a 2.25¢', offsetFromPrice({ ...M, price: 0.20 }) === 2.25);
  // E la prova che il limite serve davvero: con quell'offset i due lati restano IN BANDA.
  const p = planQuotes({ mid: M.mid, offsetCents: 2.25, tick: M.tick, bandRadiusCents: M.bandRadiusCents });
  ok('  e con quell offset entrambi i lati risultano in banda', p.ok && p.yes.inBand === true && p.no.inBand === true);
  // Senza il limite, invece, si finirebbe fuori.
  const q = planQuotes({ mid: M.mid, offsetCents: 10, tick: M.tick, bandRadiusCents: M.bandRadiusCents });
  ok('  mentre senza limite si sarebbe fuori banda', q.ok && q.yes.inBand === false);
}

console.log('\n── se il venue non pubblica una banda non si inventa un tetto');
{
  const v = offsetFromPrice({ mid: 0.325, tick: 0.01, bandRadiusCents: null, price: 0.20 });
  ok('senza banda l offset e la distanza vera', v === 13, String(v));
  ok('  e non un numero di comodo', v !== 2.25);
}

console.log('\n── cio che non si legge non produce un offset');
{
  for (const [etichetta, args] of [
    ['prezzo assente', { ...M, price: null }],
    ['prezzo NaN', { ...M, price: NaN }],
    ['mid assente', { mid: null, tick: 0.01, price: 0.30 }],
    ['nessun argomento', undefined],
  ]) {
    const v = args === undefined ? offsetFromPrice() : offsetFromPrice(args);
    ok(`  ${etichetta} ⇒ null, mai 0`, v === null, String(v));
  }
  // Un tick illeggibile NON impedisce il calcolo: si ripiega su 1¢, che e' il tick di quasi ogni
  // mercato di questo programma. E' l'unico ripiego di questa funzione, ed e' dichiarato.
  ok('tick illeggibile ⇒ si assume 1¢ invece di rifiutare',
    offsetFromPrice({ mid: 0.325, tick: null, bandRadiusCents: null, price: 0.30 }) === 3,
    String(offsetFromPrice({ mid: 0.325, tick: null, bandRadiusCents: null, price: 0.30 })));
}

console.log('\n── l offset prodotto e sempre utilizzabile da planQuotes');
{
  // La prova che chiude il cerchio: qualunque riga di un book plausibile produce un offset con cui il
  // motore sa davvero quotare. Un offset «valido in astratto» ma che poi non pianifica non servirebbe.
  let tutti = true;
  for (const mid of [0.05, 0.2, 0.325, 0.5, 0.77, 0.95]) {
    for (let d = -8; d <= 8; d++) {
      const price = +(mid + d / 100).toFixed(4);
      if (price <= 0 || price >= 1) continue;
      const off = offsetFromPrice({ mid, tick: 0.01, bandRadiusCents: 2.25, price });
      if (off == null) { tutti = false; break; }
      const p = planQuotes({ mid, offsetCents: off, tick: 0.01, bandRadiusCents: 2.25 });
      if (!p.ok) { tutti = false; console.log(`     ✗ mid ${mid} prezzo ${price} offset ${off}: ${p.reason}`); break; }
    }
  }
  ok('102 combinazioni mid/riga: ogni offset prodotto e pianificabile', tutti);
}

console.log(`\ntocco → offset: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
