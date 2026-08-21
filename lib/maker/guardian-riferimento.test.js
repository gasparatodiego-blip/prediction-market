'use strict';
// lib/maker/guardian-riferimento.test.js
//
// Difende la proprietà che il difetto di §5.2 p.14 violava: **un deposito non è un guadagno e un
// prelievo non è una perdita**, e il punto da cui si misura non deve invecchiare.

const assert = require('assert');
const R = require('./guardian-riferimento');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const cap = (tot, pos) => ({ leggibile: true, totaleUsd: tot, saldoUsd: +(tot - pos).toFixed(6), valorePosizioniUsd: pos });
const T0 = 1_700_000_000_000;

console.log('\n════ ① il riferimento nasce, e nasce dal totale VERO ════');
{
  // Il formato v1 (la vecchia fotografia) non porta `riferimentoUsd`: vale come «da creare», ed è
  // esattamente ciò che ri-ancora il guardiano dopo il deposito del 13 agosto.
  const vecchio = { v: 1, baselineUsd: 660.562368, atIso: '2026-08-07T21:27:31.594Z' };
  const r = R.aggiornaRiferimento({ stato: vecchio, capitale: cap(2149.88, 135.98), now: T0 });
  ok('la fotografia v1 non vale come riferimento: si ricrea sul totale corrente', r.riferimentoUsd === 2149.88, String(r.riferimentoUsd));
  ok('  e il record resta leggibile dal codice VECCHIO (`baselineUsd`)', r.stato.baselineUsd === 2149.88);
  ok('  e si dichiara v2', r.stato.v === 2);
  ok('capitale illeggibile ⇒ il riferimento NON si crea e NON si muove',
    R.aggiornaRiferimento({ stato: null, capitale: { leggibile: false, motivo: 'rpc muto' }, now: T0 }).cambiato === false);
}

console.log('\n════ ② un deposito non è un guadagno — ma il riferimento SALE solo su conferma ════');
{
  // ⚠ RISCRITTO IL 21 AGOSTO 2026 (D-D), NON AMMORBIDITO. La proprietà difesa è la stessa — «da un
  // versamento non si guadagna» — ma da oggi **ogni salita del riferimento pretende due letture**,
  // deposito compreso: era la seconda strada per cui il fantasma del 16 agosto saliva lo stesso.
  // Nel giro di attesa il PnL è POSITIVO, e un PnL positivo non ha mai fatto scattare niente.
  let s = R.aggiornaRiferimento({ stato: null, capitale: cap(650, 136), now: T0 }).stato;
  const r = R.aggiornaRiferimento({ stato: s, capitale: cap(2150, 136), now: T0 + 30_000,
    osservazione: { saldoLetturaAt: T0 + 25_000 } });
  ok('il deposito è riconosciuto come cassa esterna', r.movimento.esterno === true);
  ok('  al primo giro il riferimento NON si muove: è un candidato', Math.abs(r.riferimentoUsd - 650) < 0.01, String(r.riferimentoUsd));
  ok('  e nel frattempo il PnL è positivo, quindi nessuno scatta', 2150 - r.riferimentoUsd > 0);
  const r2 = R.aggiornaRiferimento({ stato: r.stato, capitale: cap(2151, 137), now: T0 + 60_000,
    osservazione: { saldoLetturaAt: T0 + 55_000 } });
  ok('  alla conferma il riferimento assorbe il versamento', Math.abs(r2.riferimentoUsd - 2150) < 0.01, String(r2.riferimentoUsd));
  ok('  quindi il drawdown resta ZERO: da un versamento non si guadagna',
    2151 - r2.riferimentoUsd >= 0);
  ok('  e il cumulato dei movimenti lo registra', Math.abs(r2.stato.movimentiEsterniUsd - 1500) < 0.01, String(r2.stato.movimentiEsterniUsd));
}

console.log('\n════ ③ un prelievo non è una perdita ════');
{
  let s = R.aggiornaRiferimento({ stato: null, capitale: cap(2150, 136), now: T0 }).stato;
  const r = R.aggiornaRiferimento({ stato: s, capitale: cap(1650, 136), now: T0 + 30_000 });
  ok('il prelievo è riconosciuto come cassa esterna', r.movimento.esterno === true);
  ok('  e il riferimento SCENDE con lui', Math.abs(r.riferimentoUsd - 1650) < 0.01, String(r.riferimentoUsd));
  ok('  quindi non produce un drawdown fantasma di $500', Math.abs(1650 - r.riferimentoUsd) < 0.01);
}

console.log('\n════ ④ una perdita VERA resta una perdita ════');
{
  let s = R.aggiornaRiferimento({ stato: null, capitale: cap(2150, 500), now: T0 }).stato;
  // Le posizioni perdono $300: cassa ferma, posizioni giù. Non è cassa esterna.
  const r = R.aggiornaRiferimento({ stato: s, capitale: cap(1850, 200), now: T0 + 30_000 });
  ok('un calo delle POSIZIONI non è scambiato per un movimento di cassa', r.movimento.esterno === false);
  ok('  il riferimento non si muove', Math.abs(r.riferimentoUsd - 2150) < 0.01, String(r.riferimentoUsd));
  ok('  e il drawdown è quello vero', Math.abs((1850 - r.riferimentoUsd) + 300) < 0.01);

  // Un FILL sposta cassa e posizioni in versi opposti: il totale non si muove, niente da dedurre.
  let s2 = R.aggiornaRiferimento({ stato: null, capitale: cap(2150, 100), now: T0 }).stato;
  const rf = R.aggiornaRiferimento({ stato: s2, capitale: cap(2150, 400), now: T0 + 30_000 });
  ok('un FILL (cassa→posizioni) non è un movimento esterno', rf.movimento.esterno === false);
}

console.log('\n════ ⑤ quando non si può concludere, si fallisce CHIUSO ════');
{
  let s = R.aggiornaRiferimento({ stato: null, capitale: cap(2150, 136), now: T0 }).stato;
  // Lettura precedente troppo vecchia (riavvio, processo fermo): NON si deduce un movimento.
  const r = R.aggiornaRiferimento({ stato: s, capitale: cap(1650, 136), now: T0 + R.ETA_MASSIMA_LETTURA_PRECEDENTE_MS + 1000 });
  ok('lettura precedente troppo vecchia ⇒ nessun movimento dedotto', r.movimento.esterno === false);
  ok('  e il riferimento NON scende: un prelievo non visto vale come perdita, cioè si scatta PRIMA',
    Math.abs(r.riferimentoUsd - 2150) < 0.01, String(r.riferimentoUsd));

  ok('senza lettura precedente non si deduce niente',
    R.rilevaMovimentoEsterno({ precedente: null, corrente: { totaleUsd: 1, valorePosizioniUsd: 0 }, now: T0 }).movimentoUsd === null);
  // Un movimento piccolo è PnL, non cassa: sotto soglia non si sposta il riferimento.
  let s3 = R.aggiornaRiferimento({ stato: null, capitale: cap(2150, 136), now: T0 }).stato;
  const piccolo = R.aggiornaRiferimento({ stato: s3, capitale: cap(2145, 131), now: T0 + 30_000 });
  ok('una variazione piccola resta PnL, non diventa un movimento di cassa', piccolo.movimento.esterno === false);
}

console.log('\n════ ⑥ il massimo è MOBILE, non scende da solo, e non sale su UNA lettura sola ════');
{
  // ⚠ QUESTO BLOCCO E' STATO RISCRITTO IL 21 AGOSTO 2026 (D-D), NON AMMORBIDITO. Difendeva «un
  // guadagno alza il massimo» con UNA lettura: era la proprieta' vera fino al 20 agosto e il difetto
  // dal 16, quando una lettura sola ha fissato $1.550,18 per sempre. La proprieta' nuova e' piu'
  // STRETTA: il massimo sale solo se due letture distinte lo sostengono, e sale alla minore.
  let s = R.aggiornaRiferimento({ stato: null, capitale: cap(1000, 100), now: T0 }).stato;
  const primo = R.aggiornaRiferimento({ stato: s, capitale: cap(1010, 110), now: T0 + 30_000,
    osservazione: { saldoLetturaAt: T0 + 25_000 } });
  ok('una lettura sola NON alza il massimo: diventa un CANDIDATO',
    Math.abs(Number(primo.riferimentoUsd) - 1000) < 0.01, String(primo.riferimentoUsd));
  ok('  e il candidato è dichiarato, non silenzioso',
    !!(primo.stato.candidato && Math.abs(Number(primo.stato.candidato.valoreUsd) - 1010) < 0.01));
  const secondo = R.aggiornaRiferimento({ stato: primo.stato, capitale: cap(1012, 112), now: T0 + 60_000,
    osservazione: { saldoLetturaAt: T0 + 55_000 } });
  ok('due letture distinte lo alzano, e alla MINORE delle due (1010, non 1012)',
    Math.abs(Number(secondo.riferimentoUsd) - 1010) < 0.01, String(secondo.riferimentoUsd));
  const giu = R.aggiornaRiferimento({ stato: secondo.stato, capitale: cap(990, 90), now: T0 + 90_000,
    osservazione: { saldoLetturaAt: T0 + 85_000 } });
  ok('  e una discesa NON lo abbassa: il drawdown si misura dal picco',
    Math.abs(giu.riferimentoUsd - 1010) < 0.01, String(giu.riferimentoUsd));
}

console.log('\n════ ⑦ la soglia assoluta è DERIVATA, col .env come pavimento ════');
{
  const grande = R.sogliaAssoluta({ riferimentoUsd: 2149.88, pavimentoUsd: 30, frazione: 0.05 });
  ok('su $2.149,88 la soglia è il 5%, non i $30 del .env', Math.abs(grande.sogliaUsd - 107.49) < 0.01, String(grande.sogliaUsd));
  ok('  e si dichiara derivata', grande.derivata === true);
  const piccolo = R.sogliaAssoluta({ riferimentoUsd: 200, pavimentoUsd: 30, frazione: 0.05 });
  ok('su $200 morde il PAVIMENTO del .env ($30 > $10): il .env non viene ignorato', piccolo.sogliaUsd === 30);
  ok('  e in quel caso NON si dichiara derivata', piccolo.derivata === false);
  ok('la soglia cresce col riferimento, sempre',
    R.sogliaAssoluta({ riferimentoUsd: 5000, pavimentoUsd: 30 }).sogliaUsd
    > R.sogliaAssoluta({ riferimentoUsd: 2000, pavimentoUsd: 30 }).sogliaUsd);
  // ⚠ Il denominatore è il RIFERIMENTO e non il totale corrente: col totale la soglia si stringerebbe
  // mentre si perde, cioè un cricchetto che accelera lo scatto nel momento peggiore.
  ok('riferimento illeggibile ⇒ resta il pavimento, mai null',
    R.sogliaAssoluta({ riferimentoUsd: null, pavimentoUsd: 30 }).sogliaUsd === 30);
  ok('  e senza nemmeno il pavimento resta null, che a valle vale «non decidere»',
    R.sogliaAssoluta({ riferimentoUsd: null, pavimentoUsd: null }).sogliaUsd === null);
}

console.log(`\nguardian-riferimento: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
