#!/usr/bin/env node
'use strict';
// Unit test della soglia di fine scala. Aritmetica pura: nessun file, nessun venue, nessun ordine.

const E = require('./end-of-scale');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n── la soglia vive in un posto solo');
{
  ok('3.0¢ in basso', E.END_OF_SCALE_LOW_CENTS === 3.0, `${E.END_OF_SCALE_LOW_CENTS}`);
  ok('97.0¢ in alto', E.END_OF_SCALE_HIGH_CENTS === 97.0, `${E.END_OF_SCALE_HIGH_CENTS}`);
  ok('le due soglie sono specchiate', E.END_OF_SCALE_LOW_CENTS + E.END_OF_SCALE_HIGH_CENTS === 100,
    'su un binario un YES a 97¢ E un NO a 3¢: proteggerne uno solo non proteggerebbe niente');
  ok('il motivo e una stringa sola, riusata dai due motori', /fine scala, cancellazione di sicurezza/.test(E.END_OF_SCALE_REASON));
}

console.log('\n── in mezzo alla scala non succede nulla');
{
  for (const mid of [0.10, 0.25, 0.50, 0.73, 0.90]) {
    const v = E.endOfScaleCheck(mid);
    ok(`  mid ${(mid * 100).toFixed(0)}¢ ⇒ nessuna cancellazione`, v.endOfScale === false && v.readable === true);
  }
}

console.log('\n── sotto i 3¢ e sopra i 97¢ si cancella');
{
  const lo = E.endOfScaleCheck(0.02);
  ok('mid 2¢ ⇒ fine scala', lo.endOfScale === true);
  ok('  e dice da che parte', lo.side === 'low');
  ok('  con il motivo per l audit', /sotto la soglia di 3.0¢/.test(lo.reason || ''), (lo.reason || '').slice(0, 70));
  const hi = E.endOfScaleCheck(0.98);
  ok('mid 98¢ ⇒ fine scala', hi.endOfScale === true && hi.side === 'high');
  ok('  simmetrico al basso', /sopra la soglia di 97.0¢/.test(hi.reason || ''));
}

console.log('\n── i bordi esatti: la soglia NON e inclusiva');
{
  // 3.0¢ e 97.0¢ sono ancora zona operabile. Il confine dev essere una riga sola, altrimenti un mercato
  // che oscilla sul bordo verrebbe cancellato e ripiazzato a ogni giro.
  ok('esattamente 3.0¢ ⇒ si opera ancora', E.endOfScaleCheck(0.03).endOfScale === false);
  ok('esattamente 97.0¢ ⇒ si opera ancora', E.endOfScaleCheck(0.97).endOfScale === false);
  ok('2.99¢ ⇒ fine scala', E.endOfScaleCheck(0.0299).endOfScale === true);
  ok('97.01¢ ⇒ fine scala', E.endOfScaleCheck(0.9701).endOfScale === true);
}

console.log('\n── un mid che non si legge NON e un mid a fine scala');
{
  // La direzione prudente qui sarebbe cancellare, e proprio per questo va detto perche non lo facciamo:
  // cancellare e un AZIONE, e un azione presa su un numero che non abbiamo letto e una decisione a caso
  // anche quando il verso e quello giusto. Chi chiama ha gia i propri gate sul mid vivo e fresco.
  for (const bad of [null, undefined, NaN, 'abc', Infinity]) {
    const v = E.endOfScaleCheck(bad);
    ok(`  ${String(bad)} ⇒ non si agisce`, v.endOfScale === false && v.readable === false);
  }
  ok('  e «non letto» si distingue da «letto e in mezzo»',
    E.endOfScaleCheck(null).readable === false && E.endOfScaleCheck(0.5).readable === true);
}

console.log(`\nend-of-scale: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
