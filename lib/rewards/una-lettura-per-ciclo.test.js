#!/usr/bin/env node
'use strict';
// UNA LETTURA PER CICLO, E UN SEEK GRANDE QUANTO LA FINESTRA — LE DUE REGRESSIONI DA NON RIFARE.
//
// ═══ IL GUASTO ═══════════════════════════════════════════════════════════════════════════════════════
// Misurato l'8 agosto 2026 su agent40-manual-reprice, che stava al 108-110% di un core in crescita
// durante la giornata e con azzeramento a mezzanotte. Due difetti indipendenti nello stesso percorso:
//
//   1. `cadenzaPer` chiamava `leggiFinestraMercato` UNA VOLTA PER MERCATO PER CICLO. Ogni chiamata
//      accumula in `accs` TUTTI i mercati del tratto letto e poi ne proietta uno: tredici mercati
//      erano tredici letture identiche del file, tredici mappe complete costruite e dodici
//      tredicesimi buttati ogni volta.
//   2. Il seek era `size − TETTO_BYTE` con TETTO_BYTE = 128 MB, dimensionato per una finestra da SEI
//      ORE. Con il giornale a 77 MB quel conto dà zero: si leggeva tutto dall'inizio anche per una
//      finestra di quindici minuti, che vale ~1,7 MB. 524 ms per chiamata, 61.746 righe parsate per
//      estrarne 12.
//
// Insieme: 6.812 ms di CPU dentro un ciclo da 5.000 ms. Dopo: 36 ms.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
// Non i millisecondi — quelli dipendono dalla macchina. Prova i due MECCANISMI, contando le letture e
// i byte, così la regressione non può tornare in silenzio: sono difetti che non si vedono in nessun
// test funzionale, perché il RISULTATO era ed è corretto. Solo il costo era sbagliato.

const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./velocita-mercato');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ── UN GIORNALE FINTO, GRANDE ABBASTANZA DA FAR MORDERE IL SEEK ─────────────────────────────────────
// ~12 MB su 6 ore di campioni: sotto il TETTO da 128 MB (quindi col vecchio codice il seek partiva da
// zero) e ben sopra il budget di una finestra da 15 minuti.
const T0 = Date.parse('2026-08-08T12:00:00Z');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velocita-'));
const giorno = new Date(T0).toISOString().slice(0, 10);
const file = path.join(dir, `mid-history-${giorno}.jsonl`);
{
  // 6 ore all'indietro, un campione ogni 75s per 160 mercati: la forma e la TAGLIA del giornale vero
  // (~24 MB), perche' il punto e' che il budget di una finestra da 15 minuti sia una frazione del file.
  const righe = [];
  const zeppa = 'x'.repeat(300);          // porta la riga alla taglia di quelle vere (~1,2 KB con levels)
  for (let t = T0 - 6 * 3_600_000; t <= T0; t += 75_000) {
    for (let m = 0; m < 160; m += 1) {
      righe.push(JSON.stringify({
        ts: new Date(t).toISOString(), marketId: `0xM${m}`, tokenIdYes: `T${m}`,
        adjMid: 0.5 + 0.001 * ((t / 75_000 + m) % 7), plainMid: 0.5,
        bestBid: 0.49, bestAsk: 0.51, bidDepthInBand: 100 + m, askDepthInBand: 100 + m,
        bandLow: 0.4775, bandHigh: 0.5225, tick: 0.01, src: (m % 5 === 0 ? 'stale' : 'ws'), zeppa,
      }));
    }
  }
  fs.writeFileSync(file, righe.join('\n') + '\n');
}
const dimensione = fs.statSync(file).size;

console.log(`\n══ IL GIORNALE DI PROVA: ${(dimensione / 1048576).toFixed(1)} MB, sotto il tetto da ${V.TETTO_BYTE / 1048576} MB`);
ok('è più piccolo del TETTO, quindi col vecchio seek si sarebbe letto TUTTO dall\'inizio',
  dimensione < V.TETTO_BYTE, `${(dimensione / 1048576).toFixed(1)} MB < ${V.TETTO_BYTE / 1048576} MB`);

console.log('\n══ 1 · IL SEEK È GRANDE QUANTO LA FINESTRA, NON QUANTO IL TETTO');
{
  ok(`una finestra da 15 minuti chiede ${(V.budgetPerFinestra(15) / 1048576).toFixed(1)} MB, non i ${V.TETTO_BYTE / 1048576} MB del tetto`,
    V.budgetPerFinestra(15) < V.TETTO_BYTE / 10 && V.budgetPerFinestra(15) < dimensione / 4);
  ok('  una da 6 ore ne chiede di più, ma resta sotto il tetto',
    V.budgetPerFinestra(360) > V.budgetPerFinestra(15) && V.budgetPerFinestra(360) <= V.TETTO_BYTE);
  ok('  e il tetto resta il limite massimo, per finestre assurde',
    V.budgetPerFinestra(60 * 24 * 30) === V.TETTO_BYTE);
  ok('  sotto il minimo non si scende: leggere meno di un blocco non fa risparmiare niente',
    V.budgetPerFinestra(0.01) === V.MINIMO_BYTE);

  const r = V.leggiFinestraTutti({ windowMinutes: 15, minCampioni: 2, now: T0, dir });
  ok('leggendo 15 minuti si legge una FRAZIONE del file', r.byteLetti < dimensione / 3,
    `${(r.byteLetti / 1048576).toFixed(2)} MB su ${(dimensione / 1048576).toFixed(1)} MB`);
  ok('  e un solo tentativo basta: la stima del tasso è tarata bene', r.tentativi === 1);
  ok('  la finestra è COPERTA davvero, non accorciata in silenzio', r.coperto === true);
  ok('  e i mercati ci sono tutti', r.mercati === 160);
}

console.log('\n══ 2 · SE LA STIMA DEL TASSO SBAGLIA, SI ALLARGA — NON SI TRONCA IN SILENZIO');
{
  // Una finestra da 6 ore su un giornale scritto molto più fitto della stima: il primo tentativo non
  // copre, e il meccanismo deve accorgersene e rileggere. È la difesa che rende il margine ×2 una
  // ottimizzazione e non una scommessa.
  const stretto = V.leggiFinestraTutti({ windowMinutes: 360, minCampioni: 2, now: T0, dir });
  ok('una finestra da 6 ore copre l\'intero giornale di prova', stretto.coperto === true);
  const campioniAttesi = Math.floor((6 * 3600) / 75) + 1;
  const m0 = stretto.per.get('0xM0');
  ok(`  e trova tutti i ~${campioniAttesi} campioni del mercato`, Math.abs(m0.campioni - campioniAttesi) <= 1,
    `${m0.campioni} campioni`);
}

console.log('\n══ 3 · IL RISULTATO NON CAMBIA: LA VARIANTE SINGOLA È UNA PROIEZIONE DI QUELLA IN BLOCCO');
{
  const tutti = V.leggiFinestraTutti({ windowMinutes: 15, minCampioni: 4, now: T0, dir });
  let diversi = 0;
  for (let m = 0; m < 160; m += 1) {
    const id = `0xM${m}`;
    const singola = V.leggiFinestraMercato({ marketId: id, windowMinutes: 15, minCampioni: 4, now: T0, dir });
    if (JSON.stringify(singola) !== JSON.stringify(tutti.per.get(id))) diversi += 1;
  }
  ok('per tutti i 160 mercati la misura singola è IDENTICA a quella della mappa', diversi === 0,
    'stessa lettura, stessa aggregazione, stessa proiezione — non due implementazioni');

  const assente = V.leggiFinestraMercato({ marketId: '0xNONESISTE', windowMinutes: 15, now: T0, dir });
  ok('un mercato senza campioni resta «non leggibile» con il suo motivo, non uno zero',
    assente.leggibile === false && assente.campioni === 0 && /nessun campione/.test(assente.motivo));
  ok('  e un marketId vuoto lo dice invece di leggere il file',
    V.leggiFinestraMercato({ windowMinutes: 15, now: T0, dir }).motivo === 'marketId assente');
}

console.log('\n══ 4 · UNA LETTURA PER CICLO — LA REGRESSIONE CONTATA, NON SPERATA');
{
  // Si conta quante volte il modulo APRE il file. È la misura che avrebbe preso il bug il primo giorno:
  // il risultato era corretto anche prima, solo pagato tredici volte.
  const conta = () => {
    let aperture = 0, byte = 0;
    const spia = {
      statSync: (f) => fs.statSync(f),
      openSync: (f, m) => { aperture += 1; return fs.openSync(f, m); },
      readSync: (fd, b, o, l, p) => { const n = fs.readSync(fd, b, o, l, p); byte += n; return n; },
      closeSync: (fd) => fs.closeSync(fd),
    };
    return { spia, stato: () => ({ aperture, byte }) };
  };

  const MERCATI = Array.from({ length: 13 }, (_, i) => `0xM${i}`);

  // (a) IL VECCHIO SCHEMA, riprodotto: una chiamata per mercato.
  const a = conta();
  for (const id of MERCATI) V.leggiFinestraMercato({ marketId: id, windowMinutes: 15, minCampioni: 4, now: T0, dir, fs: a.spia });
  const vecchio = a.stato();

  // (b) LO SCHEMA NUOVO: una lettura, tredici consultazioni.
  const b = conta();
  const mappa = V.leggiFinestraTutti({ windowMinutes: 15, minCampioni: 4, now: T0, dir, fs: b.spia });
  for (const id of MERCATI) mappa.per.get(id);
  const nuovo = b.stato();

  ok(`una lettura per ciclo: ${nuovo.aperture} apertura contro ${vecchio.aperture} del vecchio schema`,
    nuovo.aperture === 1, 'se questo torna a 13, il bug è tornato');
  ok(`  e ${(nuovo.byte / 1048576).toFixed(2)} MB letti contro ${(vecchio.byte / 1048576).toFixed(2)} MB`,
    nuovo.byte * 5 < vecchio.byte, `${(vecchio.byte / nuovo.byte).toFixed(1)}× in meno`);
  ok('  con gli STESSI valori per ogni mercato', MERCATI.every((id) => {
    const singola = V.leggiFinestraMercato({ marketId: id, windowMinutes: 15, minCampioni: 4, now: T0, dir });
    return JSON.stringify(singola) === JSON.stringify(mappa.per.get(id));
  }));
}

console.log('\n══ 5 · IL CABLAGGIO IN agent40: LA MAPPA SI COSTRUISCE UNA VOLTA PER GIRO');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('il ciclo costruisce la mappa una volta sola', /const velocita = velocitaDelGiro\(\);/.test(codice));
  ok('  e la passa alla cadenza invece di far rileggere ogni mercato',
    /cadenzaPer\(marketId,[\s\S]{0,60}?, velocita\)/.test(codice));
  ok('  `velocitaDelGiro` usa la variante in BLOCCO', /leggiFinestraTutti\(/.test(codice));
  // La riga che conta: nel corpo del ciclo non deve ricomparire una lettura per mercato.
  const corpoCiclo = codice.slice(codice.indexOf('async function cycle()'), codice.indexOf('const run = async'));
  ok('  e dentro il ciclo non c\'è NESSUNA lettura per singolo mercato',
    !/leggiFinestraMercato\s*\(/.test(corpoCiclo),
    'era lì che stavano le tredici letture della cadenza — e quella da 240 min della liquidità');
  ok('  anche la liquidità media passa da una mappa, e la costruisce solo se qualcuno la chiede',
    /const liquiditaGiro = memoLiquidita\(\);/.test(codice) && /liquiditaGiro\.per\(marketId\)/.test(codice));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nuna lettura per ciclo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
