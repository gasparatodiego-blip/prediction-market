'use strict';
// lib/maker/capitale-riconciliato.test.js — UNA SOLA VERITÀ SUL CAPITALE, E LE DIVERGENZE FERMANO.
//
// Il difetto: il mini-ciclo del 12 agosto 2026 ha scritto, nello stesso giro, «capitale liquido fermo
// $663,11» e «$273,11 al lavoro / $273,11 totali · liberi $0,00». La seconda era `misuraUtilizzo`
// chiamata di nuovo con `saldoUsd: max(0, saldo − impegnato)` E `ordiniARiposoUsd: aRiposo +
// impegnato` — lo stesso $390 contato due volte. Su questo venue un BUY a riposo tiene il collaterale
// nel wallet fino al match: piazzare NON abbassa il saldo.
//
// Run: node lib/maker/capitale-riconciliato.test.js

const fs = require('fs');
const path = require('path');
const U = require('./utilizzo-capitale');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · IL CASO VERO DEL 12 AGOSTO, coi numeri veri');
{
  const prima = U.misuraUtilizzo({ saldoUsd: 663.11, ordiniARiposoUsd: 0, posizioniUsd: 0 });
  ok('prima: totale $663,11 · libero $663,11 · impegnato $0',
    prima.capitaleTotaleUsd === 663.11 && prima.liberoUsd === 663.11 && prima.impegnatoUsd === 0);

  // Com'era: il saldo decrementato E gli ordini aumentati.
  const comeEra = U.misuraUtilizzo({ saldoUsd: Math.max(0, 663.11 - 390), ordiniARiposoUsd: 0 + 390, posizioniUsd: 0 });
  ok('com\'era: totale $273,11 · libero $0 · utilizzo 100% (la riga di log)',
    comeEra.capitaleTotaleUsd === 273.11 && comeEra.liberoUsd === 0 && comeEra.pct === 100);

  // Adesso: derivato, e il saldo non è nemmeno un parametro.
  const dopo = U.misuraDopo(prima, 390);
  ok('adesso: totale $663,11 — il saldo NON viene decrementato', dopo.capitaleTotaleUsd === 663.11);
  ok('  libero $273,11', dopo.liberoUsd === 273.11);
  ok('  impegnato $390 — cioè esattamente ciò che il giro ha messo al lavoro', dopo.impegnatoUsd === 390);
  ok('  utilizzo 58,8% invece di 100%', Math.round(dopo.pct * 10) / 10 === 58.8, `${dopo.pct}%`);
  ok('  e il totale è lo STESSO di prima: piazzare non crea né distrugge capitale',
    dopo.capitaleTotaleUsd === prima.capitaleTotaleUsd);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · l\'errore non è più esprimibile');
{
  const prima = U.misuraUtilizzo({ saldoUsd: 663.11, ordiniARiposoUsd: 0, posizioniUsd: 0 });
  // Anche passando un saldo fasullo in `extra`, non deve poter sovrascrivere quello derivato.
  const d = U.misuraDopo(prima, 390, { motivoDeficit: 'x' });
  ok('`misuraDopo` non accetta un saldo dal chiamante', d.saldoUsd === 663.11,
    'il saldo viene dalla misura di partenza, sempre');
  // Si guarda il CODICE, non i commenti: il commento che RACCONTA la riga corretta non deve far
  // fallire il test che la difende (stessa trappola già incontrata in freno-prova.test.js).
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('e agent41 non decrementa più il saldo dopo un piazzamento',
    !/saldoUsd:\s*Math\.max\(0,\s*decisione\.saldoUsd\s*-/.test(src),
    'era la riga che produceva $273,11');
  ok('  usa la funzione derivata', /UTIL\.misuraDopo\(utilPrima,/.test(src));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · LA PROPRIETÀ: due letture divergenti oltre soglia FERMANO il giro');
{
  ok('letture uguali ⇒ concordi', U.riconcilia({ a: 663.11, b: 663.11 }).concorde === true);
  ok('scarto piccolo ⇒ concordi (arrotondamenti)', U.riconcilia({ a: 663.11, b: 661.5 }).concorde === true);

  const div = U.riconcilia({ a: 663.11, b: 273.11, etichettaA: 'saldo del trigger', etichettaB: 'saldo della misura' });
  ok('IL CASO DEL 12 AGOSTO ⇒ NON concordi', div.concorde === false, div.motivo.slice(0, 96));
  ok('  con lo scarto in dollari', div.scartoUsd === 390);
  ok('  e la soglia dichiarata', div.sogliaUsd > 0, `$${div.sogliaUsd}`);

  ok('una lettura mancante NON è una lettura concorde (fail-closed)',
    U.riconcilia({ a: 663.11, b: null }).concorde === false);
  ok('  né due mancanti', U.riconcilia({ a: null, b: null }).concorde === false);
  ok('  né un NaN', U.riconcilia({ a: 663.11, b: NaN }).concorde === false);

  // La soglia è relativa E assoluta: su conti piccoli non deve scattare per due dollari.
  ok('su conti piccoli la soglia non scatta per pochi dollari', U.riconcilia({ a: 20, b: 24 }).concorde === true,
    `soglia $${U.riconcilia({ a: 20, b: 24 }).sogliaUsd}`);
  ok('su conti grandi resta relativa', U.riconcilia({ a: 10000, b: 10150 }).concorde === true);
  ok('  e morde quando lo scarto è vero', U.riconcilia({ a: 10000, b: 12000 }).concorde === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · il cablaggio: il giro si ferma davvero, e lo dichiara');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  ok('agent41 riconcilia PRIMA di decidere quanto impegnare', /UTIL\.riconcilia\(/.test(src));
  const blocco = src.slice(src.indexOf('UTIL.riconcilia('), src.indexOf('const capitaleTotale'));
  ok('  e se non concordano esce senza agire', /if \(!ric\.concorde\)/.test(blocco) && /return \{ azione: 'nessuna'/.test(blocco));
  ok('  scrivendo il motivo nel giornale', /fermato-capitale-incoerente/.test(blocco));
  ok('  e annunciandolo nel log', /mini-ciclo FERMATO/.test(blocco));
  ok('la riconciliazione sta PRIMA del calcolo del capitale totale',
    src.indexOf('UTIL.riconcilia(') < src.indexOf('const capitaleTotale'),
    'fermarsi dopo aver deciso quanto impegnare non servirebbe a niente');
}

console.log(`\n===== capitale-riconciliato: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);
