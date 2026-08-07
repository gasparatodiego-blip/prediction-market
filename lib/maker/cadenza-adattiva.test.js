#!/usr/bin/env node
'use strict';
// LA CADENZA SEGUE IL MERCATO, MA LA SOGLIA DI MOVIMENTO NON SI MUOVE.
//
// ═══ LE DUE COSE CHE QUESTO TEST TIENE SEPARATE ══════════════════════════════════════════════════════
// «Ogni quanto guardo» e «quanto deve muoversi per riprezzare» sono due decisioni diverse, e il modo in
// cui una cadenza adattiva si trasforma in un incidente è confonderle: guardare dieci volte più spesso
// con una soglia dieci volte più bassa è il loop di ratcheting già diagnosticato su questo progetto —
// cancel/replace continui su movimenti che non pagano il costo del giro.
//
// Qui si verifica che:
//   1. la cadenza cambia con la velocità MISURATA del mercato, dentro un pavimento (1s) e un tetto (10s);
//   2. quando la misura non c'è, non cambia NIENTE rispetto a prima (cadenza di difetto);
//   3. i due cicli di agent40 saltano davvero il mercato non ancora scaduto, PRIMA di chiamare il venue;
//   4. la soglia di movimento resta dov'era, e viene valutata a ogni sguardo.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { decidiCadenza, cadenzaAttiva, tickOra, MIN_MS, MAX_MS, VELOCE_TICK_ORA, LENTO_TICK_ORA, CAMPIONI_MINIMI } = require('./cadenza-adattiva');
const ROOT = path.resolve(__dirname, '..', '..');

// Una misura sintetica nella forma esatta che restituisce leggiFinestraMercato.
const misura = ({ rangeMid, coperturaMin = 15, campioni = 12, leggibile = true }) =>
  ({ leggibile, campioni, sufficiente: true, rangeMid, coperturaMin, motivo: null });

const NOW = 1_786_200_000_000;

console.log('\n══ 1 · LA CLASSE VIENE DALLA MISURA, NON DA UN\'ETICHETTA');
{
  // 6¢ di escursione in 15 min = 24¢/ora = 24 tick/ora su tick da 1¢ ⇒ veloce.
  const veloce = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.06 }), tickCents: 1, difettoMs: 3_000 });
  ok('mercato che percorre 24 tick/ora ⇒ veloce, cadenza al pavimento',
    veloce.classe === 'veloce' && veloce.cadenzaMs === MIN_MS, `${veloce.tickOra} tick/ora → ${veloce.cadenzaMs}ms`);

  // 0,05¢ in 15 min = 0,2¢/ora = 0,2 tick/ora ⇒ lento.
  const lento = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.0005 }), tickCents: 1, difettoMs: 3_000 });
  ok('mercato che percorre 0,2 tick/ora ⇒ lento, cadenza al tetto',
    lento.classe === 'lenta' && lento.cadenzaMs === MAX_MS, `${lento.tickOra} tick/ora → ${lento.cadenzaMs}ms`);

  // In mezzo si tiene l'orologio di prima: la banda morta esiste perché la misura oscilla.
  const medio = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.005 }), tickCents: 1, difettoMs: 3_000 });
  ok('mercato in mezzo ⇒ cadenza di difetto, invariata',
    medio.classe === 'media' && medio.cadenzaMs === 3_000, `${medio.tickOra} tick/ora → ${medio.cadenzaMs}ms`);
  ok('  e le due soglie sono distanti fra loro (banda morta larga)',
    VELOCE_TICK_ORA / LENTO_TICK_ORA >= 4, `${LENTO_TICK_ORA} … ${VELOCE_TICK_ORA} tick/ora`);

  // Il tick conta: la stessa escursione in centesimi su un tick più fine è più movimento, non meno.
  const finoso = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.005 }), tickCents: 0.1, difettoMs: 3_000 });
  ok('stessa escursione, tick da 0,1¢ ⇒ diventa veloce',
    finoso.classe === 'veloce', `${finoso.tickOra} tick/ora`);
}

console.log('\n══ 2 · NEL DUBBIO NON CAMBIA NIENTE — né più veloce né più lento');
{
  for (const [nome, mis] of [
    ['nessuna misura', null],
    ['misura illeggibile', { leggibile: false, motivo: 'giornale assente' }],
    ['troppi pochi campioni', misura({ rangeMid: 0.06, campioni: CAMPIONI_MINIMI - 1 })],
    ['copertura nulla', misura({ rangeMid: 0.06, coperturaMin: 0 })],
    ['range non numerico', misura({ rangeMid: null })],
  ]) {
    const d = decidiCadenza({ now: NOW, misura: mis, tickCents: 1, difettoMs: 5_000 });
    ok(`${nome} ⇒ cadenza di difetto`, d.classe === 'ignota' && d.cadenzaMs === 5_000, `${d.cadenzaMs}ms`);
    ok('  e si guarda comunque', d.valuta === true, 'un dato assente non rende cieco un mercato');
  }
  const spenta = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.06 }), difettoMs: 5_000, attiva: false });
  ok('con l\'interruttore spento ⇒ orologio fisso come prima',
    spenta.classe === 'spenta' && spenta.cadenzaMs === 5_000);
  ok('  e l\'interruttore si spegne solo scrivendolo per esteso',
    cadenzaAttiva({}) === true && cadenzaAttiva({ MAKER_CADENZA_ADATTIVA: 'off' }) === false
    && cadenzaAttiva({ MAKER_CADENZA_ADATTIVA: '0' }) === true);
}

console.log('\n══ 3 · IL PAVIMENTO E IL TETTO VALGONO SEMPRE');
{
  const sotto = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.5 }), tickCents: 1, difettoMs: 200, minMs: MIN_MS });
  ok('un difetto sotto il pavimento non porta sotto 1s', sotto.cadenzaMs >= MIN_MS, `${sotto.cadenzaMs}ms`);
  const sopra = decidiCadenza({ now: NOW, misura: misura({ rangeMid: 0.0001 }), tickCents: 1, difettoMs: 60_000 });
  ok('un difetto sopra il tetto non porta oltre 10s', sopra.cadenzaMs <= MAX_MS, `${sopra.cadenzaMs}ms`);
  ok('  e il pavimento è 1s, il tetto 10s, come chiesto', MIN_MS === 1_000 && MAX_MS === 10_000);
}

console.log('\n══ 4 · «VALUTA ADESSO?» — il conto del tempo');
{
  const m = misura({ rangeMid: 0.0005 });   // lento ⇒ 10s
  ok('mai valutato ⇒ si guarda subito',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: null, misura: m }).valuta === true);
  ok('valutato 3s fa, cadenza 10s ⇒ si salta',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 3_000, misura: m }).valuta === false);
  ok('  e dice quanto manca',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 3_000, misura: m }).attesaMs === 7_000);
  ok('valutato 11s fa ⇒ si guarda',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 11_000, misura: m }).valuta === true);
  ok('un orologio che torna indietro non congela il mercato',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW + 60_000, misura: m }).valuta === true,
    'ultimaValutazione nel futuro ⇒ si guarda lo stesso');

  // Lo stesso mercato, veloce: a 3 secondi di distanza è già ora di riguardarlo.
  const v = misura({ rangeMid: 0.06 });
  ok('mercato veloce valutato 3s fa ⇒ si guarda (cadenza 1s)',
    decidiCadenza({ now: NOW, ultimaValutazioneMs: NOW - 3_000, misura: v }).valuta === true);
}

console.log('\n══ 5 · I DUE CICLI SALTANO DAVVERO, E PRIMA DI CHIAMARE IL VENUE');
{
  // Il punto non è che il gate esista: è che stia PRIMA di listOrders. Saltare dopo non risparmierebbe
  // la chiamata, che è tutto ciò che questo gate serve a risparmiare.
  for (const f of ['lib/maker/mm-tracking.js', 'lib/maker/auto-reprice.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const iGate = src.indexOf("gate = 'cadenza-adattiva'");
    const iLista = src.indexOf('deps.listOrders');
    ok(`${f}: il gate esiste`, iGate > 0);
    ok('  e sta prima della chiamata al venue', iGate > 0 && iLista > 0 && iGate < iLista,
      `gate@${iGate} · listOrders@${iLista}`);
  }
}

console.log('\n══ 6 · IL CICLO DI TRACKING SALTA IL MERCATO NON SCADUTO — provato facendolo girare');
(async () => {
  const { runTrackingCycle } = require('./mm-tracking');
  const MKT = '0x' + '11'.repeat(32);
  let listOrdersChiamate = 0;
  const base = {
    readConfig: () => ({ readable: true, marketIds: [MKT], markets: { [MKT]: { offsetCents: 1, minMoveCents: 0.5, sizeShares: 50 } } }),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    listOrders: async () => { listOrdersChiamate++; return { ok: true, orders: [] }; },
    resolveRules: () => ({ readable: true, missing: [], tickSize: 0.01, mid: 0.5, minSize: 50, maxSpread: 4.5 }),
    now: () => NOW,
  };

  listOrdersChiamate = 0;
  const saltato = await runTrackingCycle({ ...base, cadenza: () => ({ valuta: false, cadenzaMs: 10_000, attesaMs: 7_000, classe: 'lenta', motivo: 'misura' }) });
  ok('mercato non scaduto ⇒ gate cadenza-adattiva',
    saltato.markets[0] && saltato.markets[0].gate === 'cadenza-adattiva', String(saltato.markets[0] && saltato.markets[0].gate));
  ok('  e NESSUNA chiamata al venue', listOrdersChiamate === 0, `${listOrdersChiamate} chiamate`);
  ok('  e il motivo dice quanto manca e perché', /mancano 7000ms/.test(saltato.markets[0].reason || ''), (saltato.markets[0].reason || '').slice(0, 60));

  listOrdersChiamate = 0;
  let segnato = null;
  const visto = await runTrackingCycle({ ...base,
    cadenza: () => ({ valuta: true, cadenzaMs: 1_000, attesaMs: 0, classe: 'veloce', motivo: 'misura' }),
    segnaValutazione: (id, t) => { segnato = { id, t }; } });
  ok('mercato scaduto ⇒ il ciclo procede', visto.markets[0] && visto.markets[0].gate !== 'cadenza-adattiva',
    String(visto.markets[0] && visto.markets[0].gate));
  ok('  e il venue viene interrogato', listOrdersChiamate === 1, `${listOrdersChiamate} chiamate`);
  ok('  e la valutazione viene registrata', segnato && segnato.id === MKT && segnato.t === NOW);

  // Senza la dipendenza iniettata il ciclo si comporta ESATTAMENTE come prima: nessun salto.
  listOrdersChiamate = 0;
  const senza = await runTrackingCycle({ ...base });
  ok('senza la mano `cadenza` il ciclo non salta niente',
    senza.markets[0] && senza.markets[0].gate !== 'cadenza-adattiva' && listOrdersChiamate === 1,
    'il comportamento di prima resta il difetto');

  console.log('\n══ 7 · LA SOGLIA DI MOVIMENTO NON È STATA TOCCATA');
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib/maker/cadenza-adattiva.js'), 'utf8');
    ok('il modulo della cadenza non nomina nessuna soglia di movimento',
      !/minMoveCents\s*[:=]|hysteresisTicks\s*[:=]|confirmSamples\s*[:=]/.test(src),
      'decide QUANDO guardare, non SE riprezzare');
    const mt = fs.readFileSync(path.join(ROOT, 'lib/maker/mm-tracking.js'), 'utf8');
    ok('  e il tracking legge ancora minMoveCents dalla configurazione', /minMoveCents/.test(mt));
    const cfg = fs.readFileSync(path.join(ROOT, 'lib/maker/auto-reprice-config.js'), 'utf8');
    ok('  e il watcher ha ancora hysteresisTicks e confirmSamples ai valori di prima',
      /hysteresisTicks:\s*1/.test(cfg) && /confirmSamples:\s*2/.test(cfg));
  }

  console.log(`\ncadenza adattiva: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();
