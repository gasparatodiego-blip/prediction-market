#!/usr/bin/env node
'use strict';
// IL NETTO NON È IL LORDO TRAVESTITO — E LA REGOLA È SCRITTA UNA VOLTA SOLA.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// 4 agosto 2026, tab «Ottimizza capitale», card di proposta dell'allocatore: NETTO/G identico a LORDO/G
// su tutti i mercati proposti, fino all'ultima cifra decimale, mentre il banner della stessa pagina
// prometteva che il netto fosse «—» dove non esiste un fill osservato.
//
// La causa non era una formula sbagliata: era la STESSA formula scritta due volte nello stesso file, e
// la seconda copia era vecchia.
//
//     allocator.js:233 (righe del piano)     (a.fills > 0 && fin(a.netPerDay5m)) ? a.netPerDay5m : null   ✓
//     allocator.js:336 (card di proposta)    best && fin(best.net5m) ? best.net5m : null                  ✗
//
// Perché il numero sbagliato era così convincente: il motore modella «nessun fill osservato» come costo
// 0 — ed è la convenzione giusta per OTTIMIZZARE, perché assumere un costo inventato escluderebbe un
// mercato per un'ipotesi. Ma «costo 0 per scegliere» non è «costo 0 nella realtà», e sullo schermo
// diventava netto = lordo − 0 = lordo.
//
// Misurato sul piano vero da $200 prima del fix: 4 proposte su 4 con `fills: 0`, netto delle righe
// `null`, netto delle card uguale al lordo. Una terza copia della regola viveva nel browser
// (RewardsAllocatePanel.rowAt): corretta, ma copia.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planAllocation } = require('./allocator');
const N = require('./net-per-day');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('\n══ 1 · LA REGOLA CANONICA');
N.selfcheck();
pass += 19;

console.log('\n══ 2 · NESSUNO LA RISCRIVE: I TRE PUNTI IMPORTANO');
{
  const alloc = leggi('lib', 'rewards', 'allocator.js');
  ok('l allocatore importa la regola', /require\('\.\/net-per-day'\)/.test(alloc));
  ok('  le righe del piano la usano', /const netPerDay = calcNetPerDay\(/.test(alloc));
  ok('  E ANCHE le card di proposta', /const bestNetPerDay = calcNetPerDay\(/.test(alloc));
  // Le due forme locali che c'erano prima non devono poter tornare.
  ok('la vecchia forma delle righe non c è più',
    !/\(a\.fills > 0 && fin\(a\.netPerDay5m\)\)/.test(alloc));
  // La guardia punta al CAMPO, non alla forma. Dall'8 agosto 2026 esiste `bestObiettivoPerDay`, che è
  // il netto grezzo con cui il knapsack ha ORDINATO — e che deliberatamente NON passa da calcNetPerDay:
  // ordinare su una cifra annullata dai 0-fill escludeva dalla graduatoria i mercati silenziosi (vedi
  // lib/rewards/collector-priority.js). Sono due numeri diversi con due mestieri diversi; il difetto
  // era assegnare il PRIMO con la forma grezza, ed è quello che resta vietato.
  ok('la vecchia forma delle card non c è più — era QUESTA il difetto',
    !/bestNetPerDay\s*=\s*best && fin\(best\.net5m\)/.test(alloc));
  ok('  e il netto grezzo ha un campo suo, dichiarato, invece di travestirsi da netto misurato',
    /bestObiettivoPerDay:\s*best && fin\(best\.net5m\)/.test(alloc));

  const panel = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('il pannello importa la stessa regola', /from '@\/lib\/rewards\/net-per-day'/.test(panel));
  ok('  e non la ricompone a mano', !/fills != null && fills > 0 && gross != null && cost != null/.test(panel));
}

console.log('\n══ 3 · SUL MOTORE VERO: ZERO FILL ⇒ NIENTE NETTO, SU ENTRAMBE LE USCITE');
{
  // Fixture deterministico: due campioni a 24h di distanza, nessuna operazione sul nastro ⇒ 0 fill.
  const riga = (tsMs) => ({
    ts: new Date(tsMs).toISOString(), tsMs, marketId: 'Z', tokenIdYes: 'TKZ',
    adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
    bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws',
  });
  const plan = planAllocation({
    byMarket: new Map([['Z', [riga(0), riga(86_400_000)]]]),
    marketTokens: new Map([['Z', 'TKZ']]),
    tapeByToken: new Map(),                       // nessuna operazione ⇒ nessun fill osservato
    potByCond: new Map([['Z', 100]]),
    budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
  });

  const r = plan.rows[0];
  ok('la riga del piano ha 0 fill', r && r.fills === 0);
  ok('  e il suo netto è null', r.netPerDay === null);
  ok('  mentre il lordo è un numero positivo', typeof r.grossPerDay === 'number' && r.grossPerDay > 0);

  const c = (plan.candidates || []).find((x) => x.marketId === 'Z');
  ok('la CARD DI PROPOSTA esiste', !!c);
  ok('  e il suo netto è null — era qui che usciva uguale al lordo', c.bestNetPerDay === null);
  ok('  con il motivo dichiarato', c.bestNetAssente === 'nessun-fill-osservato', String(c.bestNetAssente));
  ok('  e il conteggio dei fill riportato', c.bestNetFills === 0, String(c.bestNetFills));
  ok('IL LORDO RESTA, ED È UN NUMERO', typeof c.bestGrossPerDay === 'number' && c.bestGrossPerDay > 0);
  ok('LE DUE USCITE DELLO STESSO MOTORE CONCORDANO',
    (r.netPerDay === null) === (c.bestNetPerDay === null),
    'prima divergevano: null sulle righe, lordo sulle card');
}

console.log('\n══ 4 · CON FILL VERI IL NETTO C È (la regola non è «sempre trattino»)');
{
  // Non si inventa un nastro: si prova la regola sui valori che il motore produrrebbe.
  ok('9 fill e netto misurato → il netto passa', N.calcNetPerDay({ fills: 9, netPerDay: 0.499 }) === 0.499);
  ok('  e può essere diverso dal lordo', N.calcNetPerDay({ fills: 9, netPerDay: 0.499 }) !== 1.590);
  ok('  un netto misurato UGUALE al lordo è legittimo: costo misurato zero, non modellato',
    N.calcNetPerDay({ fills: 1, netPerDay: 0.355 }) === 0.355);
}

// Era «il tetto del 30%», poi «il 20%». Dal 9 agosto 2026 è un VALORE FISSO IN DOLLARI: quando il
// capitale cresce il sistema si spalma su più mercati invece di ingrossare la size su ciascuno. Il
// punto di questa sezione non cambia — il tetto deve stare in UN posto e tutti devono importarlo —
// ma adesso i consumatori sono QUATTRO e non due, ed è la lista che va difesa.
console.log('\n══ 5 · IL TETTO PER MERCATO È IN UN PUNTO SOLO, E LO IMPORTANO IN QUATTRO');
{
  const conc = leggi('lib', 'rewards', 'concentration.js');
  ok('il tetto è definito in concentration.js, in dollari', /MARKET_CAP_FIXED_USD = 130/.test(conc));
  ok('  e NON è più una frazione', !/CONCENTRATION_CAP_FRAC\s*=/.test(conc));
  // I QUATTRO consumatori. Se uno smette di importarlo e si riscrive il numero, questo test cade.
  ok('1 · il riallocatore periodico lo importa',
    /require\('\.\.\/rewards\/concentration'\)/.test(leggi('lib', 'maker', 'realloc-cycle.js')));
  ok('2 · la route del pannello lo importa',
    /from '@\/lib\/rewards\/concentration'/.test(leggi('app', 'api', 'rewards', 'allocate', 'route.ts')));
  ok('3 · il motore di piazzamento lo importa (era una sua costante)',
    /require\('\.\.\/rewards\/concentration'\)/.test(leggi('lib', 'maker', 'motore-unico.js')));
  ok('4 · il punteggio di rischio lo importa',
    /require\('\.\/concentration'\)/.test(leggi('lib', 'rewards', 'rischio-beneficio.js')));
  const { MARKET_CAP_FIXED_USD, capPerMarketUsd, mercatiNecessari } = require('./concentration');
  ok('  ed è davvero $130', MARKET_CAP_FIXED_USD === 130);
  ok('  $2.000 di capitale NON alzano il tetto', capPerMarketUsd(2000) === 130);
  ok('  ma $50 lo abbassano a $50: può solo stringere', capPerMarketUsd(50) === 50);
  ok('  capitale non utilizzabile → tetto PIENO, mai null (null varrebbe «nessun tetto»)',
    capPerMarketUsd(null) === 130);
  ok('  e il numero di mercati è una conseguenza, non un parametro', mercatiNecessari(2000) === 16);
}

console.log('\n══ 6 · IL SIZING LEGGE IL MID VERO, MAI 0.50');
{
  const alloc = leggi('lib', 'rewards', 'allocator.js');
  ok('il prezzo viene dal mid misurato, e resta null se non c è',
    /const price = meta\.mid != null \? clampPrice\(meta\.mid\) : null/.test(alloc));
  ok('  nessun ripiego a 0.50 nel percorso di sizing',
    !/mid\s*(\|\||\?\?)\s*0\.5\b/.test(alloc) && !/price\s*(\|\||\?\?)\s*0\.5\b/.test(alloc));
  // Col costo della coppia la size non dipende NEMMENO dal mid: è capitale / (1 − 2d).
  ok('con il costo della coppia la size non dipende dal mid',
    /a\.capital \/ rowPairCostUsd/.test(alloc));
  // E dal 5 agosto 2026 quel costo è PER MERCATO: si legge dal livello scelto, non da uno scalare di
  // piano. Se tornasse a essere globale, la riga mostrerebbe una size diversa da quella con cui il
  // knapsack l'ha classificata — esattamente il difetto che il costo della coppia esiste per chiudere.
  ok('  e il costo della coppia viene dal livello scelto, non da uno scalare di piano',
    /const rowPairCostUsd = fin\(a\.pairCostUsd\)/.test(alloc));
}

console.log(`\nnetto centralizzato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
