#!/usr/bin/env node
'use strict';
// PUNTO 6 · dove va l'uscita dopo un fill, e fin dove la si insegue.
// Aritmetica pura: nessun venue, nessun ordine, nessun file.

const { planExit, exitNeedsMove, EXIT_PROFIT_PCT, MAX_ADVERSE_PCT } = require('./exit-plan');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n── le due percentuali, in un punto solo');
{
  ok('obiettivo 1%', EXIT_PROFIT_PCT === 1);
  ok('pavimento di rischio 4%', MAX_ADVERSE_PCT === 4);
}

console.log('\n── 1 · l obiettivo: carico + 1%, arrotondato IN SU');
{
  // carico 50¢, banda larga: l obiettivo e 50.5¢ → sul tick da 1¢ diventa 51¢.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 5 });
  ok('uscita a 51¢', p.ok && p.price === 0.51, String(p.price));
  ok('  deciso dall obiettivo', p.clampedBy === 'obiettivo', p.clampedBy);
  ok('  e NON e al pavimento', p.atFloor === false);
  ok('  il guadagno reale e dichiarato', p.profitPct === 2, `${p.profitPct}% (l arrotondamento al tick da piu di 1%)`);

  // su tick fine l obiettivo e preciso
  const f = planExit({ entryPrice: 0.500, scoringMid: 0.500, tick: 0.001, bandRadiusCents: 5 });
  ok('con tick 0.001 l uscita e 50.5¢', f.ok && f.price === 0.505, String(f.price));
  ok('  cioe esattamente +1%', f.profitPct === 1, `${f.profitPct}%`);
}

console.log('\n── LA PERCENTUALE VALE UGUALE A OGNI PREZZO (il vecchio +1¢ no)');
{
  const basso = planExit({ entryPrice: 0.10, scoringMid: 0.10, tick: 0.001, bandRadiusCents: 5 });
  const alto = planExit({ entryPrice: 0.90, scoringMid: 0.90, tick: 0.001, bandRadiusCents: 5 });
  ok('a 10¢ l uscita e 10.1¢ (+1%)', basso.price === 0.101, String(basso.price));
  ok('a 90¢ l uscita e 90.9¢ (+1%)', alto.price === 0.909, String(alto.price));
  ok('  stessa percentuale a due prezzi lontanissimi', basso.profitPct === alto.profitPct,
    'col vecchio +1¢ fisso sarebbero stati +10% e +1.1%');
}

console.log('\n── 2 · LA BANDA limita l obiettivo, e lo dice');
{
  // carico 50¢, mid 50¢, banda stretta ±0.5¢ ⇒ bordo alto 50.5¢, che sul tick da 1¢ scende a 50¢.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 0.5 });
  ok('l uscita non supera il bordo premiante', p.ok && p.price <= 0.50, String(p.price));
  ok('  ed e dichiarato chi ha deciso', p.clampedBy === 'banda' || p.clampedBy === 'pavimento', p.clampedBy);
  ok('  il motivo spiega il compromesso', /BANDA|PAVIMENTO/.test(p.reason), p.reason.slice(0, 80));

  // banda larga: l obiettivo passa intatto
  const largo = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 10 });
  ok('con banda larga l obiettivo non viene limitato', largo.clampedBy === 'obiettivo');
}

console.log('\n── senza banda pubblicata non si finge che ci sia');
{
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: null });
  ok('si esce comunque all obiettivo', p.ok && p.price === 0.51, String(p.price));
  ok('  e bandHi resta null, non un numero inventato', p.bandHi === null);
}

console.log('\n── 3 · IL PAVIMENTO DEL 4%: si smette di inseguire');
{
  // Il mercato e crollato: carico 50¢, mid ora 40¢. La banda seguirebbe l uscita fin verso 40¢.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.40, tick: 0.01, bandRadiusCents: 2.25 });
  ok('l uscita NON scende fino alla banda', p.price > 0.42, `${p.price} invece del bordo banda ~0.42`);
  ok('  si ferma al 4% sotto il carico', p.price === 0.48, `${p.price} = 50¢ − 4%`);
  ok('  ed e dichiarato «pavimento»', p.clampedBy === 'pavimento', p.clampedBy);
  ok('  con atFloor true', p.atFloor === true);
  ok('  e il motivo dice che si smette di inseguire', /smette di inseguire/.test(p.reason), p.reason.slice(-70));
  ok('  la perdita massima accettata e ~4%', p.profitPct <= 0 && p.profitPct >= -4.1, `${p.profitPct}%`);
}

console.log('\n── il pavimento non si sfonda nemmeno con un crollo enorme');
{
  for (const mid of [0.30, 0.20, 0.10, 0.05]) {
    const p = planExit({ entryPrice: 0.50, scoringMid: mid, tick: 0.01, bandRadiusCents: 2.25 });
    ok(`  mid a ${(mid * 100).toFixed(0)}¢ ⇒ uscita ferma a 48¢`, p.price === 0.48, String(p.price));
  }
  ok('  il 4% e un tetto, non un obiettivo mobile', true,
    'inseguire la banda avrebbe venduto a 32¢, 22¢, 12¢, 7¢');
}

console.log('\n── un mercato che SALE: l uscita segue verso l alto, non verso il basso');
{
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.60, tick: 0.01, bandRadiusCents: 2.25 });
  ok('con mid a 60¢ l obiettivo (51¢) e dentro banda e passa', p.price === 0.51, String(p.price));
  ok('  nessun pavimento coinvolto', p.atFloor === false);
}

console.log('\n── cio che non si legge non produce un prezzo');
{
  for (const [etichetta, args] of [
    ['carico assente', { entryPrice: null, tick: 0.01 }],
    ['carico zero', { entryPrice: 0, tick: 0.01 }],
    ['tick assente', { entryPrice: 0.5, tick: null }],
    ['nessun argomento', undefined],
  ]) {
    const p = args === undefined ? planExit() : planExit(args);
    ok(`  ${etichetta} ⇒ nessuna uscita`, p.ok === false && p.price === null, p.reason.slice(0, 50));
  }
}

console.log('\n── NON si abbassa mai un uscita gia a riposo');
{
  const piano = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 10 });   // 51¢
  ok('senza uscita a riposo: la si piazza', exitNeedsMove({ restingPrice: null, plan: piano, tick: 0.01 }).move === true);
  ok('uscita gia al prezzo giusto: non si tocca', exitNeedsMove({ restingPrice: 0.51, plan: piano, tick: 0.01 }).move === false);
  ok('uscita PIU BASSA del piano: si alza', exitNeedsMove({ restingPrice: 0.505, plan: piano, tick: 0.001 }).move === true);
  const giu = exitNeedsMove({ restingPrice: 0.55, plan: piano, tick: 0.01 });
  ok('uscita PIU ALTA del piano: NON si abbassa', giu.move === false, giu.reason.slice(0, 70));

  const alPavimento = planExit({ entryPrice: 0.50, scoringMid: 0.30, tick: 0.01, bandRadiusCents: 2.25 });
  const fermo = exitNeedsMove({ restingPrice: 0.48, plan: alPavimento, tick: 0.01 });
  ok('al pavimento l uscita non si muove piu', fermo.move === false && /non si insegue piu/.test(fermo.reason));
}

console.log(`\npiano di uscita: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
