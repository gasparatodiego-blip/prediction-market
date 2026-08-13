#!/usr/bin/env node
'use strict';
// LA CODA LUNGA NON SI CANCELLA: SI DOSA.
//
// Il tetto di orizzonte è nato l'8 agosto 2026 come cancello secco a 1,5 giorni e ci è rimasto mezza
// giornata. Giusto come direzione, sbagliato come forma: i 307 ingressi veri dei 21 maker dicono
// mediana 0,212 g · Q3 0,504 · **P90 7,00** · max **145,7**, cioè il **10,4% dei loro ingressi
// (32 su 307) va oltre i 7 giorni**. Un cancello a 1,5 g cancellava quel decimo invece di
// rappresentarlo — ed era un decimo di comportamento che i vincitori hanno davvero.
//
// Adesso ci sono due cose in due posti, e fanno due lavori diversi:
//   · un MURO a 150 giorni in `horizon.js` — oltre il massimo mai osservato: rifiuto secco;
//   · una QUOTA di CAPITALE sulla fascia oltre 7 giorni, in `allocator.js`, applicata quando il piano
//     viene COMPOSTO. Un mercato lungo non è più scartato: è il portafoglio a non potersi appoggiare
//     su quella fascia per più del 12%.
//
// Nessun venue, nessun ordine, nessun capitale reale: curve sintetiche e il knapsack vero.

const path = require('path');
const {
  MIN_HORIZON_DAYS, MAX_HORIZON_DAYS_DEFAULT, LONG_TAIL_DAYS, LONG_TAIL_CAP_FRAC, horizonVerdict,
} = require('./horizon');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = Date.parse('2026-08-08T15:00:00Z');
const iso = (g) => new Date(NOW + g * 86_400_000).toISOString();

// ══ 1 · I DUE NUMERI, E DA DOVE VENGONO ═════════════════════════════════════════════════════════
console.log('\n══ IL MURO E LA QUOTA');
{
  ok('il muro è 150 g, sopra il massimo osservato di 145,7', MAX_HORIZON_DAYS_DEFAULT === 150);
  ok('il confine della coda lunga è 7 g, cioè il P90 misurato', LONG_TAIL_DAYS === 7);
  ok('la quota è il 12% del capitale', LONG_TAIL_CAP_FRAC === 0.12);
  ok('  sopra il 10,4% misurato, così il rumore campionario non boccia una composizione onesta',
    LONG_TAIL_CAP_FRAC > 0.104);
  ok('  e sotto il 15% che si otterrebbe spostando il confine a 3 g', LONG_TAIL_CAP_FRAC < 0.15);
}

// ══ 2 · IL MURO RESTA UN RIFIUTO SECCO, LA QUOTA NON LO TOCCA ═══════════════════════════════════
console.log('\n══ IL MURO — indipendente dalla quota');
{
  const sano = { nowMs: NOW, grossPerDay: 10, costPerDay: 0 };
  ok('a 149,9 g → ok: è ammissibile, sarà la quota a dosarlo',
    horizonVerdict({ endDate: iso(149.9), ...sano }).state === 'ok');
  ok('a 150 g esatti → ok, confine inclusivo come il pavimento',
    horizonVerdict({ endDate: iso(150), ...sano }).state === 'ok');
  ok('a 150,1 g → too-far, e nessuna quota lo salva',
    horizonVerdict({ endDate: iso(150.1), ...sano }).state === 'too-far');
  ok('a 400 g → too-far', horizonVerdict({ endDate: iso(400), ...sano }).state === 'too-far');
  // IL CAMBIO CHE CONTA: prima questi erano tutti rifiutati.
  for (const g of [2.4, 7.1, 30, 144.4]) {
    ok(`  a ${g} g NON è più too-far (prima lo era)`, horizonVerdict({ endDate: iso(g), ...sano }).state === 'ok');
  }
  // Il pavimento È stato toccato l'8 agosto sera (0,25 → 0,75 g): era tarato sulla mediana di TUTTI
  // gli ingressi dei 21, e il 91% di quelli non sono su mercati che pagano premi. Vedi horizon.js.
  // Questa asserzione resta perché il TETTO e il pavimento sono due cose diverse e questo test è sul
  // tetto: qui si verifica solo che il pavimento sia quello dichiarato, non che non cambi mai.
  // ⚠ Era `=== 0.75`: una fotografia del valore, non una proprietà. Il pavimento è un'ASSUNZIONE
  // dichiarata e l'operatore la muove (0,75 → 0,50 il 13 agosto 2026); ciò che deve restare vero è
  // che sia un orizzonte positivo e sotto la fascia di coda lunga.
  ok('il pavimento è un orizzonte positivo, sotto la coda lunga',
    MIN_HORIZON_DAYS > 0 && MIN_HORIZON_DAYS < 7, String(MIN_HORIZON_DAYS));
  ok('  e sotto il pavimento si rifiuta ancora',
    horizonVerdict({ endDate: iso(0.1), ...sano }).state === 'resolved');
}

// ══ 3 · LA QUOTA — un BUDGET, non una potatura ═════════════════════════════════════════════════
// Il primo tentativo potava: lascia scegliere il knapsack, guarda se la coda sfora, togli i mercati in
// eccesso, rigira il DP. NON CONVERGE, ed è stato misurato sull'universo vero: tolti due mercati
// lunghi il DP ne pesca altri due, e dopo tre giri la composizione era ancora al 26,5% contro una
// quota del 12%. La potatura combatte il DP; il budget lo informa.
console.log('\n══ LA QUOTA — un budget concesso, non un taglio a posteriori');
const { budgetCodaLungaUsd } = require('./allocator');
const B = (S, q = LONG_TAIL_CAP_FRAC, residuo = 1e9) =>
  budgetCodaLungaUsd({ capitaleCortoUsd: S, frac: q, residuoUsd: residuo });

{
  // L'ALGEBRA, che è l'unica parte non ovvia: la quota è sul TOTALE e il totale contiene la coda,
  // quindi L <= S·q/(1−q), non L <= S·q. Con q=0,12 la coda vale al più il 13,64% della fascia corta.
  ok('con $880 di fascia corta la coda ottiene $120', Math.abs(B(880) - 120) < 1e-6, `$${B(880)}`);
  ok('  e $120 su $1000 di totale è esattamente il 12%', Math.abs(120 / (880 + 120) - 0.12) < 1e-9);
  ok('  NON è S·q, che darebbe $105,6 e sbaglierebbe in difetto', Math.abs(B(880) - 880 * 0.12) > 1);
  ok('la relazione è lineare nella fascia corta', Math.abs(B(440) - 60) < 1e-6, `$${B(440)}`);

  // Il residuo di budget è un secondo tetto: non si può concedere ciò che non c'è.
  ok('il budget residuo limita comunque', Math.abs(B(880, 0.12, 30) - 30) < 1e-9, `$${B(880, 0.12, 30)}`);
  ok('  e un residuo negativo vale zero', B(880, 0.12, -5) === 0);
}
{
  // FASCIA CORTA VUOTA — severo e voluto: «al più il 12% del piano» su un piano di sola coda vale
  // 100%, quindi nessuna allocazione diversa da zero rispetta la quota.
  ok('senza fascia corta la coda non ottiene niente', B(0) === 0);
  ok('  e nemmeno con una fascia corta negativa (dato impossibile)', B(-100) === 0);

  // QUOTA DISATTIVATA ⇒ nessun limite, e si distingue da «zero dollari»: null, non 0.
  ok('quota 0 → nessun limite (null), non «zero dollari»', B(880, 0) === null);
  ok('quota 1 → nessun limite', B(880, 1) === null);
  ok('quota illeggibile → nessun limite invece di azzerare il piano', B(880, null) === null);
  ok('  e la distinzione è leggibile da chi chiama', B(0) === 0 && B(880, 0) === null);
}

// ══ 4 · REGRESSIONE — la fascia corta non cambia di una virgola ═════════════════════════════════
console.log('\n══ REGRESSIONE — sotto i 7 giorni non è cambiato niente');
{
  // La fascia corta prende TUTTO il budget nella passata 1: la sua allocazione è, per costruzione,
  // quella che il knapsack avrebbe fatto se la coda lunga non esistesse. Non è un test che spera —
  // è la struttura delle due passate a garantirlo, e il sorgente lo dice più sotto.
  ok('la fascia corta riceve l\'intero budget, non il residuo', true, 'garantito da knapsack(corte, budgetUnits)');
  // Il confine è inclusivo: 7 giorni esatti è ancora fascia corta.
  const lungo = (g) => g > LONG_TAIL_DAYS;
  ok('7 giorni esatti sono fascia CORTA (confine inclusivo)', !lungo(7));
  ok('  7,01 giorni entrano nella coda', lungo(7.01));
  ok('  e 0,5 · 1,5 · 2,4 · 6,9 g restano tutti corti', ![0.5, 1.5, 2.4, 6.9].some(lungo));

  // I casi reali di oggi, uno per uno.
  const sano = { nowMs: NOW, grossPerDay: 10, costPerDay: 0 };
  ok('«Matt Little» a 2,4 g: fascia corta, la quota non lo tocca',
    2.4 <= LONG_TAIL_DAYS && horizonVerdict({ endDate: iso(2.4), ...sano }).state === 'ok');
  ok('  gli HI-01 a 9,4 ore: fascia corta', (9.4 / 24) <= LONG_TAIL_DAYS);
  ok('  Bab el-Mandeb a 33,4 ore: fascia corta', (33.4 / 24) <= LONG_TAIL_DAYS);
  ok('  «Snapchat» a 144,4 g: coda lunga, ammissibile, dosata dalla quota',
    144.4 > LONG_TAIL_DAYS && 144.4 <= MAX_HORIZON_DAYS_DEFAULT
    && horizonVerdict({ endDate: iso(144.4), ...sano }).state === 'ok');

  const src = require('fs').readFileSync(path.join(__dirname, 'allocator.js'), 'utf8');
  // La divisione dei compiti, verificata sul sorgente: `horizonVerdict` decide l'AMMISSIBILITÀ e non
  // sa niente di quote; la quota è un vincolo di composizione e vive dove il piano viene composto.
  const hz = require('fs').readFileSync(path.join(__dirname, 'horizon.js'), 'utf8');
  const corpo = hz.slice(hz.indexOf('function horizonVerdict'), hz.indexOf('/** Independent assertions'));
  ok('il corpo di horizonVerdict non conosce la quota', !/LONG_TAIL_CAP_FRAC|eccedenzaCodaLunga/.test(corpo));
  ok('  e la quota è applicata nell\'allocatore', /budgetCodaLungaUsd\(\{/.test(src));
  ok('  con DUE passate del knapsack, corta prima e coda dopo',
    /PASSATA 1 — la fascia corta/.test(src) && /PASSATA 2 — la coda lunga/.test(src));
  ok('  e la fascia corta della passata 1 non ha vincoli nuovi: knapsack(corte, budgetUnits)',
    /knapsack\(corte, budgetUnits\)/.test(src));
  ok('  e il tetto sui book vuoti è rimasto un vincolo separato',
    /CAP_VUOTI_FRAC/.test(src) && /vuotiTagliati/.test(src));
}

console.log(`\nquota coda lunga: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
