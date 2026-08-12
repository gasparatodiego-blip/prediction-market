#!/usr/bin/env node
'use strict';
// IL TETTO MASSIMO DI ORIZZONTE — IL MURO, E COME SI COMPORTA AI BORDI.
//
// NOTA STORICA, perché questo file è nato con un altro numero: il tetto è stato 1,5 giorni per mezza
// giornata, come cancello secco. È poi diventato un MURO a 150 g (oltre il massimo mai osservato) più
// una QUOTA di capitale sulla fascia oltre 7 g, che vive nell'allocatore e ha il suo file
// (`quota-coda-lunga.test.js`). Qui resta ciò che riguarda il verdetto per-mercato: i bordi, la
// simmetria col pavimento, e che i quattro verdetti storici non siano cambiati.
//
// Fino all'8 agosto 2026 il pianificatore aveva un PAVIMENTO (`MIN_HORIZON_DAYS = 0,25`) e nessun
// tetto. Non era una svista benigna: il knapsack massimizza un tasso AL GIORNO, e un tasso al giorno
// non contiene la durata — un mercato che rende $3/g per due giorni e uno che rende $3/g per
// centoquarantaquattro hanno lo stesso punteggio. Misurato: il piano in produzione aveva mediana
// 144,4 giorni contro lo 0,44 dei 21 maker di riferimento, cioè 328 volte.
//
// Questo file prova tre cose, e la terza è quella che conta di più:
//   1. il confine si comporta come quello del minimo (inclusivo da entrambi i lati);
//   2. tutti i verdetti che c'erano prima rispondono ancora identici;
//   3. sul PIANO VERO di oggi il filtro fa quello che deve — e il risultato non è comodo.
//
// Nessun venue, nessun ordine, nessun capitale: dati finti più due file JSON letti da disco.

const path = require('path');
const {
  horizonVerdict, MIN_HORIZON_DAYS, MAX_HORIZON_DAYS_DEFAULT, maxHorizonDays, daysToResolution,
} = require('./horizon');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = Date.parse('2026-08-08T14:00:00Z');
const iso = (giorni) => new Date(NOW + giorni * 86_400_000).toISOString();
/** Un mercato che rende e non costa: passa qualunque test di payback, così resta solo il calendario. */
const sano = { nowMs: NOW, grossPerDay: 10, costPerDay: 0 };

// ══ 1 · IL VALORE, E CHE SIA CONFIGURABILE SENZA POTER ESSERE SPENTO ═════════════════════════════
console.log('\n══ IL TETTO');
{
  ok('il muro è 150 giorni', MAX_HORIZON_DAYS_DEFAULT === 150, String(MAX_HORIZON_DAYS_DEFAULT));
  ok('  sopra il massimo mai osservato sui 21 (145,7 g), con una settimana di margine',
    MAX_HORIZON_DAYS_DEFAULT > 145.7 && MAX_HORIZON_DAYS_DEFAULT < 200);
  ok('  e comunque sopra il pavimento, altrimenti la finestra è vuota', MAX_HORIZON_DAYS_DEFAULT > MIN_HORIZON_DAYS);

  ok('`.env` lo cambia', maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: '3' }) === 3);
  ok('  uno spazio intorno non lo rompe', maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: ' 2.5 ' }) === 2.5);
  // Un `.env` sbagliato non deve poter spegnere una protezione: stessa regola di end-of-scale.
  for (const [nome, v] of [['testo', 'moltissimo'], ['vuoto', ''], ['zero', '0'], ['negativo', '-4'],
    ['sotto il pavimento', '0.1'], ['pari al pavimento', '0.25'], ['NaN', 'NaN'], ['infinito', 'Infinity']]) {
    ok(`  un valore ${nome} viene scartato in favore del difetto`,
      maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: v }) === MAX_HORIZON_DAYS_DEFAULT, `→ ${maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: v })}`);
  }
}

// ══ 2 · I BORDI, E LA SIMMETRIA COL MINIMO ═══════════════════════════════════════════════════════
console.log('\n══ I CONFINI — la finestra è [MIN, MAX], chiusa da entrambi i lati');
{
  const env = { MAKER_MAX_HORIZON_DAYS: '1.5' };   // un tetto stretto, per esercitare i bordi
  const v = (giorni) => horizonVerdict({ endDate: iso(giorni), ...sano, env });

  ok('appena sotto il tetto (1,49 g) → passa', v(1.49).state === 'ok', v(1.49).state);
  // Il confine: `days < MIN` rifiuta e `days === MIN` passa, quindi `days > MAX` rifiuta e
  // `days === MAX` passa. Le due estremità si comportano allo stesso modo — è l'unica scelta che
  // rende la finestra leggibile come un intervallo chiuso.
  ok('esattamente al tetto (1,5 g) → PASSA, come il minimo lascia passare 0,25 esatti',
    v(1.5).state === 'ok', v(1.5).state);
  ok('  e infatti al pavimento esatto (0,25 g) passa anche lui',
    v(MIN_HORIZON_DAYS).state === 'ok', v(MIN_HORIZON_DAYS).state);
  ok('appena sopra il tetto (1,51 g) → rifiutato', v(1.51).state === 'too-far', v(1.51).state);
  ok('  con lo stato esplicito «too-far», non un silenzio', v(1.51).state === 'too-far');
  ok('  e il motivo dice il numero e il perché',
    /oltre il muro di 1\.5 g/.test(v(1.51).reason) && /immobilizzato/.test(v(1.51).reason),
    v(1.51).reason.slice(0, 58) + '…');
  ok('  il verdetto porta con sé il tetto applicato', v(1.51).maxDays === 1.5);

  ok('un mercato lontanissimo (144,4 g, il caso Snapchat) → too-far', v(144.4).state === 'too-far');
  ok('  e uno a 2,4 g (il caso Matt Klein) → too-far anche lui', v(2.4).state === 'too-far');

  // Il tetto è un fatto di CALENDARIO: non deve dipendere da quanto il mercato rende.
  ok('too-far vale anche su un mercato che renderebbe moltissimo',
    horizonVerdict({ endDate: iso(50), nowMs: NOW, grossPerDay: 9999, costPerDay: 0, env }).state === 'too-far');
  ok('  e anche su uno con costo non misurato (dove prima usciva «unknown»)',
    horizonVerdict({ endDate: iso(50), nowMs: NOW, grossPerDay: 10, costPerDay: null, env }).state === 'too-far');
}

// ══ 3 · REGRESSIONE — nulla di ciò che c'era prima è cambiato ════════════════════════════════════
console.log('\n══ REGRESSIONE — i quattro verdetti storici rispondono identici');
{
  const env = { MAKER_MAX_HORIZON_DAYS: '1.5' };   // un tetto stretto, per esercitare i bordi
  const casi = [
    ['scadenza assente → unknown', { endDate: null, ...sano }, 'unknown'],
    ['scadenza illeggibile → unknown', { endDate: 'non-una-data', ...sano }, 'unknown'],
    ['già risolto → resolved', { endDate: iso(-1), ...sano }, 'resolved'],
    ['sotto il pavimento (0,1 g) → resolved', { endDate: iso(0.1), ...sano }, 'resolved'],
    ['costo non misurato → unknown', { endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: null }, 'unknown'],
    ['netto non positivo → short', { endDate: iso(1), nowMs: NOW, grossPerDay: 3, costPerDay: 8 }, 'short'],
    // Allestito SOPRA il pavimento (0,75 g dall'8 agosto sera): sotto, il verdetto sarebbe `resolved` e
    // si starebbe provando il pavimento invece del rientro. netto 4/g, costo 6/g ⇒ payback 1,5 g > 1 g.
    ['rientro più lungo della vita → short', { endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 6 }, 'short'],
    ['dentro la finestra e redditizio → ok', { endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 2 }, 'ok'],
  ];
  for (const [nome, arg, atteso] of casi) {
    const r = horizonVerdict({ ...arg, env });
    ok(nome, r.state === atteso, r.state);
  }
  // IL PAVIMENTO È CAMBIATO L'8 AGOSTO SERA: 0,25 → 0,75 g (18 ore), su decisione dell'operatore dopo
  // la ricerca per categoria. 0,25 era tarato sulla mediana di TUTTI gli ingressi dei 21; separando la
  // popolazione premiante (40 su 450) la mediana è 22,7 h, e fra 12,4 h e 19,6 h il campione è vuoto —
  // quindi 18 h cade in un vuoto e la scelta è insensibile a ±5 h. Vedi horizon.js e
  // data/ricerca-categorie-21-wallet.md §5 R1.
  ok('MIN_HORIZON_DAYS è 0,75 g = 18 ore', MIN_HORIZON_DAYS === 0.75, String(MIN_HORIZON_DAYS));

  // L'ORDINE DEI CONTROLLI: un mercato già risolto è `resolved`, non `too-far`, anche se il tetto
  // esiste. Il calendario passato viene prima di quello futuro.
  ok('un mercato scaduto resta «resolved», il tetto non lo ruba',
    horizonVerdict({ endDate: iso(-3), ...sano, env }).state === 'resolved');
}

// ══ 4 · IL FILTRO DELL'ALLOCATORE VEDE too-far ═══════════════════════════════════════════════════
console.log('\n══ IL PUNTO DI APPLICAZIONE — uno solo, quello del pavimento');
{
  const src = require('fs').readFileSync(path.join(__dirname, 'allocator.js'), 'utf8');
  ok('`too-far` entra in `horizonRejects`, la stessa lista di resolved/short',
    /v\.state === 'too-far'/.test(src) && /horizonRejects\.add\(mid\)/.test(src));
  ok('  e non è stato aggiunto un secondo filtro altrove',
    (src.match(/horizonRejects\.add\(/g) || []).length === 1);
  // ⚠ QUESTA ASSERZIONE E' STATA RIBALTATA IL 12 AGOSTO 2026, per decisione dell'operatore.
  // Diceva: «`unknown` continua a NON essere rifiutato (assenza di prova ≠ prova)». Era giusta finche'
  // la scadenza mancava per CASO. Misurato: mancava per COSTRUZIONE — il board normalizzato non
  // portava `endDate` su 306 righe su 306 — quindi il filtro non escludeva NULLA e un mercato a 14,3
  // ore entrava nel piano per farsi rifiutare dalla verifica, fermando il ciclo dopo tre ricalcoli
  // (§5 punto 98). Ora il board porta la scadenza vera e chi non ce l'ha esce: fail-closed.
  // Non e' stata rimossa ma INVERTITA, cosi' un ritorno silenzioso alla regola vecchia resta rosso.
  ok('  `unknown` VIENE rifiutato: fail-closed sulla scadenza non determinabile',
    /v\.state === 'unknown'/.test(src.slice(src.indexOf('const horizonRejects'), src.indexOf('const keptCurves'))));
}

// ══ 5 · L'EFFETTO SUL PIANO VERO, E NON È COMODO ═════════════════════════════════════════════════
console.log('\n══ IL PIANO DELL\'8 AGOSTO, riga per riga (lettura da disco, nessun venue)');
{
  const ora = Date.now();
  const board = require(path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json'));
  const arr = Array.isArray(board) ? board : (board.markets || []);
  const byId = new Map();
  for (const m of arr) { const id = String(m.conditionId || m.marketId || '').toLowerCase(); if (id) byId.set(id, m); }
  const piano = require(path.join(__dirname, '..', '..', 'data', 'realloc-ultimo-piano.json'));

  let sopravvissuti = 0, esclusi = 0, ignoti = 0;
  for (const r of piano.righe) {
    const m = byId.get(String(r.marketId).toLowerCase());
    const v = horizonVerdict({ endDate: m && m.endDate, nowMs: ora, grossPerDay: r.grossPerDay, costPerDay: 0.10 });
    const g = v.days == null ? null : v.days;
    if (v.state === 'too-far') esclusi++;
    else if (v.state === 'unknown') ignoti++;      // il board non porta più quella riga: non è un verdetto
    else sopravvissuti++;
    console.log(`     ${String(r.name || '').slice(0, 40).padEnd(42)} ${g == null ? '   ?' : g.toFixed(1).padStart(6)} g  → ${v.state}`);
  }
  // COSA DEVE VALERE ORA. Col muro a 150 g queste righe NON sono più tutte escluse — è esattamente il
  // cambiamento voluto: la coda lunga torna ammissibile e viene dosata dalla quota, che sta altrove.
  // Quello che questo file deve ancora garantire è solo il muro: niente oltre 150 g entra mai.
  ok('nessuna riga del piano supera il MURO dei 150 g', esclusi === 0,
    `oltre il muro ${esclusi}, ammissibili ${sopravvissuti}, senza scadenza nel board ${ignoti}`);
  ok('  e la coda lunga è tornata ammissibile invece di essere cancellata',
    sopravvissuti > 0, `${sopravvissuti} righe ora valutabili`);

  // E il fatto che conta davvero: non è che il piano scelga male fra le alternative. È che sul board
  // di oggi ALTERNATIVE NON CE NE SONO. Questo non è un test che deve restare verde per sempre — è la
  // misura di uno stato del mondo, e serve a impedire che il tetto entri in servizio credendo di
  // spostare la scelta quando invece la azzera.
  const orizzonti = arr.map((m) => daysToResolution(m.endDate, ora)).filter((x) => x != null);
  const eleggibili = orizzonti.filter((x) => x >= MIN_HORIZON_DAYS && x <= MAX_HORIZON_DAYS_DEFAULT).length;
  const piuCorto = Math.min(...orizzonti);
  console.log(`\n     board: ${orizzonti.length} mercati · il più corto scade fra ${piuCorto.toFixed(2)} g · eleggibili col tetto: ${eleggibili}`);
  ok('MISURA, non requisito: quanti mercati del board sopravvivono al tetto',
    Number.isInteger(eleggibili), `${eleggibili} su ${orizzonti.length}`);
  if (eleggibili === 0) {
    console.log('     ⚠ ZERO. Il tetto è giusto ma non basta: nessun mercato del board scende sotto 1,5 g.');
    console.log('       Il vincolo che morde è A MONTE, in cosa agent24 mette nel board. Vedi CLAUDE.md §5 punto 23.');
  }
}

console.log(`\ntetto orizzonte: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
