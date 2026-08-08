'use strict';
// lib/maker/decisione-per-evento.test.js — LA DECISIONE SEGUE IL FEED, MA IL FRENO SUI VELOCI RESTA.
//
// Il DATO del mid era già live su tutti i mercati (agent34). La DECISIONE no: un mercato classificato
// «lento» aspettava dieci secondi anche quando il suo book era appena cambiato. Questo test verifica le
// due metà del cambio, e la seconda è quella che protegge da un guasto già visto:
//   · sui mercati LENTI un book nuovo fa valutare subito, senza aspettare la cadenza;
//   · sui mercati VELOCI il pavimento anti-ratcheting (MIN_MS) vale anche per gli eventi, e le soglie
//     che decidono se RIPREZZARE non sono state toccate da nessuna parte.
//
// Run: node lib/maker/decisione-per-evento.test.js

const fs = require('fs');
const path = require('path');
const { decidiCadenza, MIN_MS, MAX_MS, VELOCE_TICK_ORA, LENTO_TICK_ORA, FINESTRA_MIN } = require('./cadenza-adattiva');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = 1_000_000_000;
// Misure sintetiche che producono le tre classi. `coperturaMin` = FINESTRA_MIN, tick 1¢.
const misura = (tickOraVoluto) => ({
  leggibile: true, campioni: 100, coperturaMin: FINESTRA_MIN,
  rangeMid: (tickOraVoluto * 1 * (FINESTRA_MIN / 60)) / 100,
});
const LENTO = misura(LENTO_TICK_ORA / 2);
const VELOCE = misura(VELOCE_TICK_ORA * 2);
const MEDIO = misura((VELOCE_TICK_ORA + LENTO_TICK_ORA) / 2);

console.log('\n1 · le classi non sono cambiate (regressione)');
{
  const base = { now: NOW, ultimaValutazioneMs: NOW - 100, tickCents: 1, difettoMs: 5000 };
  ok('mercato lento ⇒ classe lenta, cadenza 10s', decidiCadenza({ ...base, misura: LENTO }).classe === 'lenta'
    && decidiCadenza({ ...base, misura: LENTO }).cadenzaMs === MAX_MS);
  ok('mercato veloce ⇒ classe veloce, cadenza 1s', decidiCadenza({ ...base, misura: VELOCE }).classe === 'veloce'
    && decidiCadenza({ ...base, misura: VELOCE }).cadenzaMs === MIN_MS);
  ok('mercato medio ⇒ cadenza di difetto', decidiCadenza({ ...base, misura: MEDIO }).cadenzaMs === 5000);
  ok('misura assente ⇒ classe ignota, cadenza di difetto', decidiCadenza({ ...base, misura: null }).classe === 'ignota');
}

console.log('\n2 · SENZA istanti di book il comportamento è IDENTICO a prima');
{
  // È la proprietà che rende sicuro il cambio: chi non passa i due nuovi campi non vede differenze.
  const senza = decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 3000, misura: LENTO, tickCents: 1, difettoMs: 5000 });
  ok('lento a 3s dall\'ultima valutazione ⇒ NON valuta (cadenza 10s)', senza.valuta === false, `attesa ${senza.attesaMs}ms`);
  ok('  e non dichiara nessun evento', senza.perEvento !== true);
  const scaduta = decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 11_000, misura: LENTO, tickCents: 1, difettoMs: 5000 });
  ok('lento a 11s ⇒ valuta per cadenza scaduta', scaduta.valuta === true && scaduta.perEvento !== true);
}

console.log('\n3 · IL CAMBIO: sui LENTI un book nuovo fa valutare subito');
{
  const r = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 3000, misura: LENTO, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 500, bookValutatoMs: NOW - 4000,
  });
  ok('lento, cadenza NON scaduta, ma book nuovo ⇒ valuta', r.valuta === true, r.motivo.slice(0, 80));
  ok('  e lo dichiara come decisione per evento', r.perEvento === true);
  ok('  la classe resta «lenta»: la cadenza non è stata riscritta', r.classe === 'lenta' && r.cadenzaMs === MAX_MS);

  // Lo stesso book già valutato NON rifà scattare niente: un evento si consuma una volta sola.
  const ripetuto = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 3000, misura: LENTO, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 4000, bookValutatoMs: NOW - 4000,
  });
  ok('stesso book già valutato ⇒ NON valuta di nuovo', ripetuto.valuta === false);
  const piuVecchio = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 3000, misura: LENTO, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 9000, bookValutatoMs: NOW - 4000,
  });
  ok('un book PIÙ VECCHIO di quello già visto non è un evento', piuVecchio.valuta === false);

  // Vale su tutte le classi, non solo sui lenti.
  for (const [nome, m] of [['media', MEDIO], ['ignota', null]]) {
    const x = decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 1500, misura: m, tickCents: 1, difettoMs: 5000,
      bookAggiornatoMs: NOW - 100, bookValutatoMs: NOW - 5000 });
    ok(`  vale anche sulla classe ${nome}`, x.valuta === true && x.perEvento === true);
  }
}

console.log('\n4 · IL FRENO SUI VELOCI — il pavimento vale anche per gli eventi');
{
  // È il punto che protegge dal loop di ratcheting già diagnosticato: un feed che pubblicasse dieci
  // volte al secondo non deve produrre dieci valutazioni.
  const troppoPresto = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 300, misura: VELOCE, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 50, bookValutatoMs: NOW - 5000,
  });
  ok(`veloce, 300ms dall'ultima valutazione (< MIN_MS ${MIN_MS}) ⇒ NON valuta nemmeno con book nuovo`,
    troppoPresto.valuta === false, `attesa ${troppoPresto.attesaMs}ms`);
  const oltreIlPavimento = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 1200, misura: VELOCE, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 50, bookValutatoMs: NOW - 5000,
  });
  ok('  oltre il pavimento valuta (ma per cadenza scaduta: veloce = 1s)', oltreIlPavimento.valuta === true);
  // Anche su un lento il pavimento vale: un evento non può valutare due volte nello stesso secondo.
  const lentoTroppoPresto = decidiCadenza({
    now: NOW, ultimaValutazioneMs: NOW - 200, misura: LENTO, tickCents: 1, difettoMs: 5000,
    bookAggiornatoMs: NOW - 10, bookValutatoMs: NOW - 5000,
  });
  ok('il pavimento vale anche sui lenti: due eventi nello stesso secondo ⇒ una valutazione',
    lentoTroppoPresto.valuta === false);
}

console.log('\n5 · guardare più spesso NON abbassa la soglia di riprezzo');
{
  // La regola che l'intestazione dichiara, verificata sul sorgente: questo modulo non nomina nessuna
  // delle soglie che decidono SE riprezzare. Se un giorno le nominasse, il freno anti-ratcheting
  // sarebbe stato spostato dentro il modulo che decide QUANDO GUARDARE — la confusione esatta che
  // l'intestazione esiste per impedire.
  const src = fs.readFileSync(path.join(__dirname, 'cadenza-adattiva.js'), 'utf8');
  for (const soglia of ['hysteresisTicks', 'confirmSamples', 'minIntervalMs', 'minMoveCents', 'maxPerHour']) {
    ok(`cadenza-adattiva non tocca «${soglia}»`, !new RegExp(`${soglia}\\s*[:=]`).test(src));
  }
  // E agent40 passa gli istanti del book, cioè il cablaggio esiste davvero.
  const a40 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('agent40 passa bookAggiornatoMs a decidiCadenza', /bookAggiornatoMs:\s*bookMs/.test(a40));
  ok('  e ricorda il book solo quando valuta davvero', /if \(d\.valuta && Number\.isFinite\(bookMs\)\) ultimoBookValutato\.set/.test(a40));
  // Il campo sbagliato (`r.tickSize`, che resolveMarketRules non restituisce) teneva `tickCents = 1`
  // su OGNI mercato, quindi la misura era in centesimi/ora invece che in tick/ora. Si controlla il
  // CODICE, non il testo: il commento che spiega il difetto nomina per forza il campo vecchio.
  const codice = a40.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('  e legge il tick dal campo giusto (`tick`, non `tickSize`)',
    /Number\.isFinite\(r\.tick\) && r\.tick > 0\) tickCents = r\.tick \* 100/.test(codice)
    && !/Number\.isFinite\(r\.tickSize\)/.test(codice));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
