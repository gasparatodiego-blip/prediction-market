#!/usr/bin/env node
'use strict';
// scripts/monitor-reti-dei-21.js — I MERCATI DI ADESSO, LETTI CON IL METRO DEI 21 MAKER VINCENTI.
//
// ═══ COSA FA ════════════════════════════════════════════════════════════════════════════════════════
// Prende il board reward corrente e lo confronta, mercato per mercato, con il SETTING CONSENSUS
// misurato su 21 wallet vincenti (data/manuale-operativo-maker-v2.md, «Il setting consensus»). Non
// propone ordini e non calcola piani: dice quali mercati, ADESSO, somigliano a quelli su cui quei 21
// stanno davvero — e quali no, e per cosa.
//
// ═══ IL METRO, E DA DOVE VIENE OGNI NUMERO ══════════════════════════════════════════════════════════
// Non sono preferenze: sono mediane di un campione osservato, con il loro intervallo Q1–Q3.
//   · SCADENZA BREVE — mediana 0,44 giorni al primo fill (Q1–Q3 0,18–0,80). È il parametro con lo
//     scarto più grande rispetto a noi (12–24 giorni), ed è il primo criterio di questo monitor.
//   · NOZIONALE ~$34 per ordine (Q1–Q3 $16–74), size 77 share (45–200).
//   · UN TICK dal mid: 1,5¢ in acquisto, 0,88¢ in vendita — cioè il tick, non di più.
//   · CHIUSURA VIA REDEEM nel 94% dei casi: si lascia risolvere, non si esce prima.
//   · NESSUN FILTRO SUL MONTEPREMI. Il consensus dice «montepremi minimo $47/g mediana, ma la banda
//     NON è un criterio» e la correlazione col premio è debole (+0,34): questo monitor quindi NON
//     scarta un mercato perché paga poco. Lo dice e basta — è esattamente la differenza fra guardare
//     e decidere.
//
// ═══ SOLA LETTURA, E DIMOSTRATO ════════════════════════════════════════════════════════════════════
// Legge file già scritti da altri (il board di agent24, lo snapshot dei book di agent34, lo stato dei
// 21 di agent42-watch-makers) e stampa. Non ha credenziali, non apre socket, non scrive un byte.
//
// La promessa NON è «non importa niente da lib/maker/»: importa `market-clock`, che è il lettore
// condiviso della data di chiusura a tre fonti (catalogo manuale, board, normalizzato). Riscriverne una
// copia qui sarebbe esattamente l'errore che questo repo combatte da percorsi-dati.test.js in avanti —
// una seconda risoluzione dello stesso fatto, che diverge al primo cambio.
//
// La promessa è più forte e si verifica: NESSUNA superficie di piazzamento o cancellazione è
// raggiungibile dall'albero dei `require` di questo file. Lo dimostra un test che cammina quell'albero,
// lo stesso metodo con cui si dimostra che il guardiano delle perdite è incapace di piazzare.
//
// ═══ COME SI LANCIA ═════════════════════════════════════════════════════════════════════════════════
//     cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js
//     cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --watch      (rilegge ogni 60s)
//     cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --json       (una riga JSON)

const fs = require('fs');
const path = require('path');
const { fileRuntime } = require('../lib/percorsi-runtime');

const RADICE = path.resolve(__dirname, '..');
const BOARD = fileRuntime('liquidity-rewards.json');
const BOOKS = fileRuntime('clob-live-books.json');
const STATO_21 = path.join(RADICE, 'data', 'maker-21-stato.json');
const STAT_21 = path.join(RADICE, 'data', 'maker-21-statistiche.json');

// ── IL CONSENSUS, IN UN POSTO SOLO ────────────────────────────────────────────────────────────────
const C = Object.freeze({
  scadenzaGiorniMediana: 0.44, scadenzaQ1: 0.18, scadenzaQ3: 0.80,
  nozionaleMediana: 34, nozionaleQ1: 16, nozionaleQ3: 74,
  sizeMediana: 77, sizeQ1: 45, sizeQ3: 200,
  distanzaBuyCents: 1.5, distanzaSellCents: 0.88,
  mercatiContemporanei: 10,
  redeemPct: 94,
  montepremiMediana: 47,
});

const leggi = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Quanto manca alla chiusura, in giorni. `null` quando la data non si legge — e null non è «lontano»:
 * un mercato di cui non sappiamo la scadenza NON entra fra i coerenti, perché la scadenza breve è il
 * primo criterio del campione e non si può affermare su un dato assente.
 *
 * La data la risolve `lib/maker/market-clock`, che è il lettore condiviso a tre fonti. Il board reward
 * da solo non la porta (verificato: nessun campo di data fra le sue chiavi), ed è precisamente il
 * motivo per cui quel modulo esiste.
 */
function giorniAllaChiusura(m, adesso, deps = {}) {
  let ms = null;
  try {
    const { readMarketCloseMs } = require(path.join(RADICE, 'lib', 'maker', 'market-clock.js'));
    const r = readMarketCloseMs(m.marketId, deps);
    if (r && r.readable && Number.isFinite(r.endMs)) ms = r.endMs;
  } catch { ms = null; }
  if (ms == null) {
    const t = m && (m.endDate || m.endDateIso || m.end_date_iso);
    const p = typeof t === 'string' ? Date.parse(t) : NaN;
    if (Number.isFinite(p)) ms = p;
  }
  if (!Number.isFinite(ms)) return null;
  return (ms - adesso) / 86_400_000;
}

function valuta(m, book, adesso) {
  const g = giorniAllaChiusura(m, adesso);
  const pool = n(m.dailyPool);
  const mid = book && n(book.mid) != null ? n(book.mid) : n(m.midpoint);
  const minSize = n(m.minSize) ?? n(book && book.minSize);
  const banda = n(m.maxSpread) ?? n(book && book.maxSpread);

  // La size che il consensus userebbe qui: la mediana, ma mai sotto il minimo del venue.
  const sizeProposta = minSize != null ? Math.max(C.sizeMediana, minSize) : C.sizeMediana;
  const nozionaleProposto = mid != null ? +(sizeProposta * mid).toFixed(2) : null;

  const motivi = [];
  let coerente = true;
  if (g == null) { motivi.push('scadenza non leggibile'); coerente = false; }
  else if (g > C.scadenzaQ3) { motivi.push(`scade fra ${g.toFixed(2)}g, oltre il Q3 del campione (${C.scadenzaQ3}g)`); coerente = false; }
  else if (g < 0) { motivi.push('già scaduto'); coerente = false; }

  if (nozionaleProposto != null && nozionaleProposto > C.nozionaleQ3) {
    motivi.push(`la size minima del venue porta il nozionale a $${nozionaleProposto}, oltre il Q3 ($${C.nozionaleQ3})`);
    coerente = false;
  }
  if (mid == null) { motivi.push('mid non leggibile'); coerente = false; }

  return {
    marketId: m.marketId, titolo: m.title || m.question || null,
    giorni: g == null ? null : +g.toFixed(3),
    mid, banda, minSize, pool,
    sizeProposta, nozionaleProposto,
    // Il montepremi NON entra nel giudizio: si riporta e basta (vedi l'intestazione).
    notaMontepremi: pool == null ? 'montepremi non letto'
      : (pool < C.montepremiMediana ? `paga $${pool}/g, sotto la mediana del campione ($${C.montepremiMediana}/g) — non è un criterio di scarto` : `paga $${pool}/g`),
    coerente, motivi,
  };
}

function componi(adesso = Date.now()) {
  const board = leggi(BOARD);
  const books = leggi(BOOKS);
  const stato21 = leggi(STATO_21);
  const stat21 = leggi(STAT_21);

  const mercati = (board && Array.isArray(board.markets)) ? board.markets : [];
  const perId = (books && books.markets) ? books.markets : {};
  const righe = mercati.map((m) => valuta(m, perId[m.marketId] || null, adesso));
  const coerenti = righe.filter((r) => r.coerente)
    .sort((a, b) => (a.giorni ?? Infinity) - (b.giorni ?? Infinity));

  return {
    at: new Date(adesso).toISOString(),
    fonti: {
      board: board ? `${mercati.length} mercati` : 'NON LETTO',
      books: books ? `${Object.keys(perId).length} book` : 'NON LETTO',
      ventuno: stato21 ? 'letto' : 'NON LETTO',
    },
    consensus: C,
    // Cosa stanno facendo ADESSO i 21, se il loro monitor l'ha scritto: è il termine di paragone vivo.
    ventuno: stat21 ? {
      wallet: n(stat21.wallet) ?? (Array.isArray(stat21.per) ? stat21.per.length : null),
      aggiornato: stat21.at || stat21.generatedAt || null,
    } : null,
    totali: { esaminati: righe.length, coerenti: coerenti.length, scartati: righe.length - coerenti.length },
    coerenti: coerenti.slice(0, 25),
    // I primi scartati, col motivo: una lista che si accorcia senza dire perché non serve a niente.
    scartati: righe.filter((r) => !r.coerente).slice(0, 10)
      .map((r) => ({ marketId: r.marketId, titolo: r.titolo, giorni: r.giorni, motivi: r.motivi })),
  };
}

function stampa(s) {
  const R = (x) => (x == null ? '—' : x);
  console.log('\n════ RETI DEI 21 · il metro dei maker vincenti sui mercati di adesso ════');
  console.log(`  ${s.at}`);
  console.log(`  fonti: board ${s.fonti.board} · book ${s.fonti.books} · stato dei 21 ${s.fonti.ventuno}`);
  console.log(`  metro: scadenza < ${C.scadenzaQ3}g · nozionale $${C.nozionaleQ1}–${C.nozionaleQ3} `
    + `· size ${C.sizeQ1}–${C.sizeQ3} share · ${C.distanzaBuyCents}¢ dal mid in acquisto · chiusura via redeem (${C.redeemPct}%)`);
  console.log(`  NESSUN filtro sul montepremi: il campione dice che la banda non e' un criterio.\n`);
  console.log(`  esaminati ${s.totali.esaminati} · coerenti col consensus ${s.totali.coerenti} · scartati ${s.totali.scartati}`);
  if (s.totali.coerenti > C.mercatiContemporanei) {
    console.log(`  (il campione ne tiene ${C.mercatiContemporanei} contemporanei: qui sotto i piu' vicini alla scadenza)`);
  }
  console.log('\n  ── COERENTI, dal piu vicino alla scadenza ──');
  if (!s.coerenti.length) console.log('    nessuno.');
  for (const r of s.coerenti) {
    const t = (r.titolo || r.marketId).slice(0, 46).padEnd(48);
    console.log(`    ${t} ${String(R(r.giorni)).padStart(6)}g  mid ${R(r.mid)}  size ${R(r.sizeProposta)} → $${R(r.nozionaleProposto)}  ${r.notaMontepremi}`);
  }
  if (s.scartati.length) {
    console.log('\n  ── SCARTATI (primi 10), col motivo ──');
    for (const r of s.scartati) {
      console.log(`    ${(r.titolo || r.marketId).slice(0, 46).padEnd(48)} ${r.motivi.join('; ')}`);
    }
  }
  console.log('\n  sola lettura: questo processo non piazza, non cancella e non scrive niente.\n');
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const watch = process.argv.includes('--watch');
  const giro = () => { const s = componi(); if (json) console.log(JSON.stringify(s)); else stampa(s); };
  giro();
  if (watch) setInterval(giro, 60_000);
}

module.exports = { componi, valuta, giorniAllaChiusura, CONSENSUS: C };
