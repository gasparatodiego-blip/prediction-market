#!/usr/bin/env node
'use strict';
// IL PROFILO ARRIVA AL MOTORE, FRESCO, E CAMBIA IL PERCORSO — GIRO PER GIRO.
//
// ═══ LE QUATTRO PROPRIETÀ ════════════════════════════════════════════════════════════════════════════
//   1. lo store porta tetto E profilo sulla STESSA riga, e un piano fonde per profilo invece di
//      sostituire tutto — un piano Risk non deve poter cancellare i tetti dei mercati Safe;
//   2. `readMarketProfile` rilegge il file a OGNI chiamata: nessuna cache, e un profilo cambiato fra
//      due cicli viene visto al ciclo successivo, non a quello dopo ancora;
//   3. un profilo che non si può stabilire NON ricade su 'safe': si traduce in «nessun ordine nuovo»;
//   4. Risk applica ENTRAMBI i controlli — mai-primo-sul-libro E tick2/tick3 — con le funzioni VERE,
//      non con delle spie: qui la composizione dev'essere quella reale.
//
// Nessun ordine, nessuna rete: lo store è un file temporaneo di questo test.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeAllocatedCapital, readAllocatedCapital, readMarketProfile, MAX_AGE_MS,
} = require('./allocated-capital');
const { valutaPiazzamento } = require('./regole-piazzamento');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profilo-ciclo-'));
const file = path.join(dir, 'store.json');
let ORA = Date.parse('2026-08-06T12:00:00Z');
const deps = () => ({ allocatedCapitalFile: file, now: () => ORA });

const A = '0x' + 'aa'.repeat(32);
const B = '0x' + 'bb'.repeat(32);
const C = '0x' + 'cc'.repeat(32);

console.log('\n══ 1 · TETTO E PROFILO SULLA STESSA RIGA');
{
  writeAllocatedCapital({ rows: [{ marketId: A, capital: 100 }], capital: 1000, profile: 'safe' }, deps());
  const cap = readAllocatedCapital(A, deps());
  const prof = readMarketProfile(A, deps());
  ok('il tetto si legge', cap.capUsd === 100, `$${cap.capUsd}`);
  ok('  e il profilo pure, dalla stessa lettura', prof.profile === 'safe', prof.reason);
  ok('  con la stessa età', cap.ageSec === prof.ageSec, `${cap.ageSec}s / ${prof.ageSec}s`);
}

console.log('\n══ 2 · UN PIANO FONDE PER PROFILO, NON SOSTITUISCE TUTTO');
{
  // Il difetto che questo impedisce: prima `writeAllocatedCapital` riscriveva `markets` per intero,
  // quindi un piano Risk avrebbe cancellato i tetti Safe — e un tetto assente vale «niente esposizione».
  writeAllocatedCapital({ rows: [{ marketId: B, capital: 50 }], capital: 1000, profile: 'risk' }, deps());

  ok('il mercato Safe è ancora lì col suo tetto', readAllocatedCapital(A, deps()).capUsd === 100);
  ok('  e col suo profilo', readMarketProfile(A, deps()).profile === 'safe');
  ok('il mercato Risk è stato aggiunto', readAllocatedCapital(B, deps()).capUsd === 50);
  ok('  col profilo risk', readMarketProfile(B, deps()).profile === 'risk');

  // Un secondo piano Safe sostituisce SOLO i mercati Safe.
  writeAllocatedCapital({ rows: [{ marketId: C, capital: 70 }], capital: 1000, profile: 'safe' }, deps());
  ok('il nuovo piano Safe sostituisce il vecchio Safe', readAllocatedCapital(A, deps()).capUsd === null,
    'A non è nel piano nuovo');
  ok('  aggiunge il suo mercato', readAllocatedCapital(C, deps()).capUsd === 70);
  ok('  e NON tocca il mercato Risk', readAllocatedCapital(B, deps()).capUsd === 50,
    'è esattamente il difetto che la fusione esiste per impedire');
}

console.log('\n══ 3 · RETROCOMPATIBILITÀ: UN RECORD SENZA PROFILO È SAFE');
{
  // Lo store scritto prima che il campo esistesse. Il percorso Safe era l'unico che scrivesse.
  fs.writeFileSync(file, JSON.stringify({
    markets: { [A.toLowerCase()]: { capitalUsd: 42 } }, updatedAt: ORA, capital: 1000,
  }));
  ok('un record senza profilo si legge come safe', readMarketProfile(A, deps()).profile === 'safe');
  ok('  e il suo tetto resta leggibile', readAllocatedCapital(A, deps()).capUsd === 42);

  // E un piano Risk non lo cancella, perché non è suo.
  writeAllocatedCapital({ rows: [{ marketId: B, capital: 9 }], capital: 1000, profile: 'risk' }, deps());
  ok('  un piano Risk non cancella i vecchi record senza profilo', readAllocatedCapital(A, deps()).capUsd === 42);
}

console.log('\n══ 4 · LETTURA FRESCA A OGNI CICLO, NESSUNA CACHE');
{
  writeAllocatedCapital({ rows: [{ marketId: A, capital: 100 }], capital: 1000, profile: 'safe' }, deps());
  ok('primo ciclo: safe', readMarketProfile(A, deps()).profile === 'safe');

  // Il mercato passa a Risk fra un ciclo e l'altro.
  ORA += 5_000;
  writeAllocatedCapital({ rows: [], capital: 1000, profile: 'safe' }, deps());          // esce dal piano Safe
  writeAllocatedCapital({ rows: [{ marketId: A, capital: 30 }], capital: 1000, profile: 'risk' }, deps());

  ok('ciclo successivo: il profilo AGGIORNATO, non quello vecchio',
    readMarketProfile(A, deps()).profile === 'risk', 'nessuna cache fra i due cicli');
  ok('  e il tetto è quello del piano nuovo', readAllocatedCapital(A, deps()).capUsd === 30, 'era 100');

  // E ritorna Safe: il cambio funziona nei due sensi.
  ORA += 5_000;
  writeAllocatedCapital({ rows: [], capital: 1000, profile: 'risk' }, deps());
  writeAllocatedCapital({ rows: [{ marketId: A, capital: 80 }], capital: 1000, profile: 'safe' }, deps());
  ok('e torna safe al ciclo dopo', readMarketProfile(A, deps()).profile === 'safe');

  // Dieci letture consecutive senza scritture: sempre lo stesso, e sempre dal file.
  const dieci = new Set(Array.from({ length: 10 }, () => readMarketProfile(A, deps()).profile));
  ok('  dieci letture consecutive sono coerenti', dieci.size === 1 && dieci.has('safe'));
}

console.log('\n══ 5 · UN PROFILO CHE NON SI PUÒ STABILIRE NON SCEGLIE');
{
  const fuoriPiano = readMarketProfile('0x' + 'ff'.repeat(32), deps());
  ok('mercato fuori dal piano ⇒ profile null, NON safe', fuoriPiano.profile === null, fuoriPiano.reason);
  ok('  col motivo che spiega la conseguenza', /nessun ordine nuovo/.test(fuoriPiano.reason));

  // Piano scaduto: oltre MAX_AGE_MS il profilo non è più affidabile.
  const dopo = { allocatedCapitalFile: file, now: () => ORA + MAX_AGE_MS + 1000 };
  const scaduto = readMarketProfile(A, dopo);
  ok('piano più vecchio di 24 h ⇒ profile null e stale', scaduto.profile === null && scaduto.stale === true, scaduto.reason);

  // Store illeggibile.
  fs.writeFileSync(file, '{ non è json');
  const rotto = readMarketProfile(A, deps());
  ok('store illeggibile ⇒ profile null, non un difetto comodo', rotto.profile === null && rotto.readable === false);

  // ── E IL MOTORE, RICEVENDO null, RIFIUTA ──────────────────────────────────────────────────────
  // È l'anello che rende utile tutto il resto: un profilo assente non fa passare il mercato da un
  // percorso a caso, lo ferma.
  const v = valutaPiazzamento({ profilo: null, marketId: A, side: 'BUY' });
  ok('valutaPiazzamento con profilo null ⇒ rifiuto', v.ok === false && v.profilo === null, v.reason);
  ok('  e non propone nessun prezzo', v.price === null);
}

console.log('\n══ 6 · RISK APPLICA ENTRAMBI I CONTROLLI — CON LE FUNZIONI VERE');
{
  // Niente spie qui: la composizione dev'essere quella reale.
  const BANDA = { lo: 0.44, hi: 0.56 };
  const base = {
    marketId: A, profilo: 'risk', side: 'BUY', bandBounds: BANDA, bandRadiusCents: 6,
    tick: 0.01, scoringMid: 0.50,
    // Il nervosismo richiederebbe il giornale: iniettato per tenere il test senza I/O.
    deps: { nervosismoRisk: () => ({ nervoso: false, misurato: true, motivo: 'calmo' }) },
  };

  // (a) SAREMMO PRIMI: il libro ha solo roba NOSTRA davanti. Tolti i nostri, il miglior prezzo altrui
  //     è 0,45 — un tick dietro darebbe 0,44, che con mid 0,50 e banda ±6¢ è al bordo... quindi il
  //     caso che conta è quello in cui un tick dietro USCIREBBE: usiamo un concorrente a 0,44.
  const primi = valutaPiazzamento({
    ...base,
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.44, size: 100 }],
    ownOrders: [{ orderId: 'X', price: 0.50, size: 200 }],
  });
  ok('(a) un tick dietro l unico concorrente uscirebbe dalla banda ⇒ bocciato',
    primi.ok === false, primi.reason);
  ok('  e la bocciatura è mai-primo-sul-libro, NON la depth',
    primi.bocciature.some((b) => b.controllo === 'mai-primo-sul-libro'),
    primi.bocciature.map((b) => b.controllo).join(','));
  ok('  la depth non è nemmeno stata calcolata: si esce prima',
    primi.controlli.depth === undefined, 'se si fallisce il controllo base, calcolare la depth è lavoro sprecato');

  // (b) NON primi, ma depth insufficiente ⇒ boccia la SECONDA regola. Prova che i due controlli sono
  //     davvero due e che il primo non maschera il secondo.
  const depthScarsa = valutaPiazzamento({
    ...base,
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.49, size: 2 }, { price: 0.48, size: 2 }],
    ownOrders: [],
  });
  ok('(b) non primi ma gradino sottile ⇒ bocciato dalla depth', depthScarsa.ok === false);
  ok('  e il controllo base era passato', depthScarsa.controlli.maiPrimo && depthScarsa.controlli.maiPrimo.ok === true);
  ok('  quindi i controlli sono DUE, non uno',
    depthScarsa.bocciature.some((b) => b.controllo === 'depth-adattiva-risk'),
    depthScarsa.bocciature.map((b) => b.controllo).join(','));

  // (c) entrambi soddisfatti ⇒ passa.
  const buono = valutaPiazzamento({
    ...base,
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.49, size: 100 }],
    ownOrders: [],
  });
  ok('(c) non primi e gradino solido ⇒ passa', buono.ok === true, buono.reason);
  ok('  ed entrambi i controlli compaiono nel referto',
    buono.controlli.maiPrimo && buono.controlli.maiPrimo.ok === true && buono.controlli.depth.ok === true);
}

console.log('\n══ 7 · IL PROFILO DECIDE IL PERCORSO, SUGLI STESSI IDENTICI DATI');
{
  const BANDA = { lo: 0.44, hi: 0.56 };
  const comune = {
    marketId: A, side: 'BUY', bandBounds: BANDA, bandRadiusCents: 6, tick: 0.01, scoringMid: 0.50,
    ownOrders: [], proposedSize: 10, proposedPrice: 0.49,
    spreadCorrente: 0.01, saldoUsd: 1000, esposizioneMercatoUsd: 0,
    // Gradino da $9,80: sopra il pavimento Safe ($15 cumulato? no) e sotto quello Risk ($20).
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.49, size: 20 }, { price: 0.48, size: 20 }],
    deps: {
      volatilitaSafe: () => ({ nervoso: false, margineMultiplo: 1, misurato: true, motivo: 'calmo' }),
      spreadAnomaloSafe: () => ({ bloccato: false, misurato: true, motivo: 'ok', rapporto: 1 }),
      nervosismoRisk: () => ({ nervoso: false, misurato: true, motivo: 'calmo' }),
    },
  };
  const s = valutaPiazzamento({ ...comune, profilo: 'safe' });
  const r = valutaPiazzamento({ ...comune, profilo: 'risk' });

  // Safe cumula: $9,80 + $9,60 = $19,40 ≥ $15 al terzo livello ⇒ passa.
  // Risk misura il gradino: $9,80 e $9,60, entrambi < $20 ⇒ skip.
  ok('SAFE passa (cumula fino a $15)', s.ok === true, s.reason);
  ok('RISK non passa (nessun gradino regge $20)', r.ok === false, r.reason);
  ok('  stessi dati, due verdetti: è il profilo a decidere', s.ok !== r.ok);
  ok('  e ciascuno ha attraversato solo i suoi controlli',
    s.controlli.spread !== undefined && r.controlli.spread === undefined
    && r.controlli.nervosismo !== undefined && s.controlli.nervosismo === undefined);
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* il temp resta, non è un errore del test */ }

console.log(`\nprofilo nel ciclo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
