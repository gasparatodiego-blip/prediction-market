#!/usr/bin/env node
'use strict';
// La scala del cursore della size del foglio rapido: 0% = minimo premiante, 100% = massimo
// acquistabile col capitale a quel prezzo. Aritmetica pura, nessun browser.

const { sizeScale, sizeAtPct } = require('./mm-quote-math');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n── i due estremi');
{
  // 50 share minime, prezzo 50¢, 99.21 USDC ⇒ 198 share al massimo.
  const s = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 99.21 });
  ok('la scala e leggibile', s.readable === true);
  ok('  0% = la size minima premiante', s.lo === 50, String(s.lo));
  ok('  100% = capitale / prezzo, arrotondato per difetto', s.hi === 198, String(s.hi));
  ok('0% da la size minima', sizeAtPct(s, 0) === 50);
  ok('100% da il massimo', sizeAtPct(s, 100) === 198);
  ok('50% sta esattamente a meta', sizeAtPct(s, 50) === 124, String(sizeAtPct(s, 50)));
  ok('  e la progressione e monotona', [0, 10, 25, 50, 75, 90, 100]
    .map((p) => sizeAtPct(s, p)).every((v, i, a) => i === 0 || a[i - 1] <= v));
}

console.log('\n── il prezzo cambia il massimo, non il minimo');
{
  const caro = sizeScale({ minSize: 50, price: 0.90, capitalUsd: 99.21 });
  const economico = sizeScale({ minSize: 50, price: 0.10, capitalUsd: 99.21 });
  ok('a 90¢ si comprano 110 share', caro.hi === 110, String(caro.hi));
  ok('a 10¢ se ne comprano 992', economico.hi === 992, String(economico.hi));
  ok('  ma il minimo premiante non si muove', caro.lo === 50 && economico.lo === 50);
}

console.log('\n── un capitale che non copre il minimo NON produce un intervallo alla rovescia');
{
  // 50 share a 50¢ costano 25$, ma ce ne sono 5.
  const s = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 5 });
  ok('il massimo non scende sotto il minimo', s.hi === 50, `lo ${s.lo} hi ${s.hi}`);
  ok('  quindi ogni percentuale da la stessa size', sizeAtPct(s, 0) === 50 && sizeAtPct(s, 100) === 50);
  ok('  e il cursore non offre una scelta fra due numeri entrambi impossibili', s.hi >= s.lo,
    'a dirlo sara il gate del saldo, che nomina la cifra mancante');
}

console.log('\n── cio che non si legge NON diventa uno zero');
{
  for (const [etichetta, args] of [
    ['senza size minima', { minSize: null, price: 0.5, capitalUsd: 99 }],
    ['senza prezzo', { minSize: 50, price: null, capitalUsd: 99 }],
    ['prezzo zero', { minSize: 50, price: 0, capitalUsd: 99 }],
    ['senza saldo', { minSize: 50, price: 0.5, capitalUsd: null }],
    ['size minima zero', { minSize: 0, price: 0.5, capitalUsd: 99 }],
    ['nessun argomento', undefined],
  ]) {
    const s = args === undefined ? sizeScale() : sizeScale(args);
    ok(`  ${etichetta} ⇒ scala non leggibile`, s.readable === false);
    ok(`    e nessuna size viene inventata`, sizeAtPct(s, 50) === null);
  }
  // La distinzione che conta: «non leggibile» non e' «zero share».
  ok('una scala illeggibile non produce 0 share', sizeAtPct(sizeScale(), 0) === null,
    'zero share sarebbe un ordine, null e un rifiuto di indovinare');
}

console.log('\n── DUE TETTI, e vince il piu basso');
{
  // Capitale 99.21$, ma il tetto per ordine e 30$: a 50¢ il massimo e 60 share, non 198.
  const s = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 99.21, orderCapUsd: 30 });
  ok('il tetto per ordine limita il 100%', s.hi === 60, String(s.hi));
  ok('  e la scala lo DICE, invece di lasciar credere a un saldo basso', s.boundBy === 'tetto-ordine', String(s.boundBy));
  ok('  il 100% resta sotto il tetto', sizeAtPct(s, 100) * 0.50 <= 30);

  // Quando il capitale e piu stretto del tetto, e il capitale a mordere.
  const p = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 12, orderCapUsd: 30 });
  ok('con poco capitale e il capitale a limitare', p.hi === 50 && p.boundBy === 'capitale', `${p.hi} · ${p.boundBy}`);

  // Senza tetto dichiarato la scala si comporta come prima.
  const senza = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 99.21 });
  ok('senza tetto dichiarato ⇒ limita il capitale', senza.hi === 198 && senza.boundBy === 'capitale', String(senza.hi));

  // IL CASO CHE CONTA DAVVERO su questa macchina: 99.21$ di saldo, tetto 30$, prezzo 50¢.
  ok('lo scenario reale: 60 share, non 198', sizeScale({ minSize: 50, price: 0.50, capitalUsd: 99.21, orderCapUsd: 30 }).hi === 60,
    'un cursore che arrivasse a 198 disegnerebbe una posizione che il gate rifiuta un attimo dopo');
}

console.log('\n── la percentuale viene tenuta nei suoi limiti');
{
  const s = sizeScale({ minSize: 50, price: 0.50, capitalUsd: 99.21 });
  ok('sotto lo 0% si resta al minimo', sizeAtPct(s, -40) === 50);
  ok('sopra il 100% si resta al massimo', sizeAtPct(s, 300) === 198);
  ok('una percentuale non numerica vale 0%', sizeAtPct(s, NaN) === 50);
}

console.log('\n── il saldo reale di questa macchina, come controprova');
{
  // 99.21 USDC e la size minima da 50 share: a che prezzo il cursore smette di offrire una scelta?
  const s = sizeScale({ minSize: 50, price: 0.99, capitalUsd: 99.21 });
  ok('a 99¢ il massimo e 100 share, poco sopra il minimo', s.hi === 100, String(s.hi));
  ok('  e il cursore offre ancora una scelta vera', s.hi > s.lo);
}

console.log(`\nscala della size: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
