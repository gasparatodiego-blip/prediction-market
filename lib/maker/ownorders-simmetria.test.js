#!/usr/bin/env node
'use strict';
// «CHI È IL MIGLIOR CONCORRENTE» NON SI RISPONDE MAI CON ROBA NOSTRA.
//
// ═══ L'ASIMMETRIA ════════════════════════════════════════════════════════════════════════════════════
// `ownOrders` ha un significato preciso (lib/maker/top-of-book.othersLadder): è l'insieme che viene
// SOTTRATTO dalla scala pubblicata per ottenere la scala ALTRUI. Un ordine che non sta lì dentro resta
// nel libro e conta come CONCORRENTE.
//
// Nel ciclo di riprezzo i due rami usavano due insiemi diversi:
//   DECISIONE    (decideReprice)  → tutti i nostri ordini del lato, QUELLO VALUTATO COMPRESO
//   PIAZZAMENTO  (replaceOrder)   → tutti tranne quello valutato  ← lo lasciava fra i concorrenti
// La motivazione del secondo era «tanto sta per essere cancellato». Confonde due cose: se l'ordine sarà
// ancora A RIPOSO (no) e se è ancora nella FOTOGRAFIA del book su cui si fa il conto (sì — lo snapshot
// di agent34 ha fino a 3 secondi, e la cancellazione è di pochi millisecondi prima).
//
// ═══ CHE NON È UNO SCENARIO TEORICO ═════════════════════════════════════════════════════════════════
// 2026-08-05T23:34:38.391Z, Ed Markey (cid_4808488e), lato YES: DUE nostri ordini a riposo
// CONTEMPORANEAMENTE, 0xc5f8b540 e 0x4a1ad2e6, entrambi a 0.77 per 48.4 quote — 96.8 quote nostre sullo
// stesso livello, che quel giorno era il miglior bid. Nell'audit ce ne sono quattro di casi così (tre su
// TX-15, uno su Ed Markey). Valutando una delle due gambe, la decisione sottraeva entrambe e il
// piazzamento una sola: due percorsi, due libri diversi, nello stesso ciclo.
//
// ═══ COSA VERIFICA QUESTO FILE ══════════════════════════════════════════════════════════════════════
//   1 · su book VERI (lo snapshot di agent34 di adesso) con UN solo ordine nostro non in testa, i due
//       insiemi danno lo STESSO prezzo — l'allineamento non cambia ciò che oggi funziona
//   2 · il caso di Ed Markey ricostruito: i due insiemi DIVERGONO, e il vecchio metteva l'ordine un
//       tick dietro a se stesso
//   3 · con due nostri ordini sullo stesso livello vanno sottratti ENTRAMBI
//   4 · il codice usa un insieme solo, in tutti e tre i punti di chiamata
//
// NESSUN ORDINE REALE: `prezzoInCoda` è pura, i book arrivano da file già scritti, nessuna rete.

const fs = require('fs');
const path = require('path');
const { prezzoInCoda } = require('./prezzo-in-coda');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const TICK = 0.01, BANDA = 4.5, MINSIZE = 20;
const regole = (mid) => ({
  readable: true, tick: TICK, maxSpreadCents: BANDA, minSize: MINSIZE, marketId: '0xtest',
  books: { yes: { scoringMid: mid }, no: { scoringMid: +(1 - mid).toFixed(6) } },
});

// I DUE INSIEMI, come li costruivano i due rami prima della correzione.
const VECCHIO_PIAZZAMENTO = (nostri, valutato) => nostri.filter((o) => o.orderId !== valutato.orderId);
const NUOVO_ENTRAMBI = (nostri) => nostri;

const chiedi = (insieme, book, mid, depth, offset) => prezzoInCoda({
  book, side: 'BUY', rules: regole(mid), depth, ownOrders: insieme, offsetCents: offset,
});

console.log('\n══ 1 · SUI BOOK VERI DI ADESSO: UN ORDINE NOSTRO NON IN TESTA ⇒ NESSUN CAMBIAMENTO');
{
  // Lo snapshot vivo di agent34. Se non c'è si dichiara invece di fingere una verifica.
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync('/tmp/clob-live-books.json', 'utf8')); } catch { /* assente */ }
  if (!snap || !snap.markets) {
    ok('snapshot di agent34 disponibile', false, '/tmp/clob-live-books.json non leggibile — verifica NON eseguita');
  } else {
    let provati = 0, identici = 0;
    const divergenti = [];
    for (const [id, m] of Object.entries(snap.markets)) {
      const bids = m.yes && m.yes.levels && m.yes.levels.bids;
      if (!Array.isArray(bids) || bids.length < 3 || !Number.isFinite(m.mid)) continue;
      // Un nostro ordine SOTTO la testa: il caso normale, quello che oggi funziona.
      const nostro = { orderId: 'A', price: bids[2].price, size: Math.min(bids[2].size, 20) };
      const depth = { yes: { bids, asks: (m.yes.levels.asks || []) }, no: { bids: [], asks: [] } };
      const vecchio = chiedi(VECCHIO_PIAZZAMENTO([nostro], nostro), 'yes', m.mid, depth, 2.0);
      const nuovo = chiedi(NUOVO_ENTRAMBI([nostro]), 'yes', m.mid, depth, 2.0);
      provati++;
      if (vecchio.price === nuovo.price && vecchio.bestOther === nuovo.bestOther) identici++;
      else divergenti.push({ id: id.slice(0, 10), v: vecchio.price, n: nuovo.price, best: [vecchio.bestOther, nuovo.bestOther] });
    }
    ok(`provati ${provati} mercati veri dallo snapshot`, provati >= 20, `${provati} mercati`);
    ok('  i due insiemi danno lo STESSO prezzo quando il nostro ordine non è in testa',
      divergenti.length === 0, divergenti.length ? JSON.stringify(divergenti.slice(0, 3)) : `${identici}/${provati} identici`);
  }
}

console.log('\n══ 2 · ED MARKEY, 5 AGOSTO 23:34:38 — DUE NOSTRI ORDINI IN TESTA AL LATO YES');
{
  // Ricostruito dai fatti: mid 0.785, miglior bid 0.77, e su quel livello 96.8 quote NOSTRE
  // (0xc5f8b540 e 0x4a1ad2e6, 48.4 ciascuno). Sotto, concorrenti veri.
  const bids = [
    { price: 0.77, size: 96.8 },   // interamente nostro
    { price: 0.76, size: 70 },
    { price: 0.75, size: 675.82 },
  ];
  const depth = { yes: { bids, asks: [{ price: 0.80, size: 612.5 }] }, no: { bids: [], asks: [] } };
  const A = { orderId: '0xc5f8b540', price: 0.77, size: 48.4 };
  const B = { orderId: '0x4a1ad2e6', price: 0.77, size: 48.4 };
  const nostri = [A, B];

  const vecchio = chiedi(VECCHIO_PIAZZAMENTO(nostri, A), 'yes', 0.785, depth, 2.0);
  const nuovo = chiedi(NUOVO_ENTRAMBI(nostri), 'yes', 0.785, depth, 2.0);

  ok('il VECCHIO insieme vede un concorrente a 0.77…', vecchio.bestOther === 0.77, String(vecchio.bestOther));
  ok('  …che è la NOSTRA gamba gemella, lasciata nel libro', vecchio.bestOther === B.price);
  ok('il NUOVO insieme toglie entrambe le nostre gambe…', nuovo.bestOther === 0.76, 'bestOther=' + String(nuovo.bestOther));
  ok('  …e trova il concorrente VERO a 0.76', nuovo.bestOther === 0.76, String(nuovo.bestOther));
  ok('I DUE PERCORSI RISPONDONO SU DUE LIBRI DIVERSI', vecchio.bestOther !== nuovo.bestOther,
    `vecchio vede ${vecchio.bestOther} · nuovo vede ${nuovo.bestOther}`);
  // In QUESTA geometria entrambi finiscono per rifiutare — un tick dietro esce dalla banda (±2.25¢ da
  // 0.785 ⇒ pavimento 0.7625) — ed è esattamente ciò che l'audit registra: alle 23:34:38 il trigger fu
  // `top-of-book-cancel`, cioè «cancella senza rimpiazzo». Il difetto non è nell'esito qui: è che il
  // rifiuto del vecchio insieme era motivato da un concorrente che non esiste.
  ok('  entrambi rifiutano, come nell audit di quel minuto',
    vecchio.quotabile === false && nuovo.quotabile === false,
    `vecchio ${vecchio.quotabile} · nuovo ${nuovo.quotabile}`);
}

console.log('\n══ 2bis · LA STESSA FORMA UN CENTESIMO PIÙ SOTTO: QUI IL PREZZO CAMBIA DAVVERO');
{
  // Identica geometria, mid 0.770: qui un tick dietro resta dentro la banda per ENTRAMBI gli insiemi
  // (±2.25¢ da 0.770 ⇒ pavimento 0.7475), quindi la divergenza non si ferma al rifiuto e produce due
  // PREZZI diversi. È il caso in cui l'asimmetria costa denaro invece di costare solo una motivazione.
  const bids = [
    { price: 0.77, size: 96.8 },   // le nostre due gambe
    { price: 0.76, size: 70 },     // il concorrente vero
    { price: 0.75, size: 675.82 },
  ];
  const depth = { yes: { bids, asks: [{ price: 0.79, size: 600 }] }, no: { bids: [], asks: [] } };
  const A = { orderId: '0xc5f8b540', price: 0.77, size: 48.4 };
  const B = { orderId: '0x4a1ad2e6', price: 0.77, size: 48.4 };

  const vecchio = chiedi(VECCHIO_PIAZZAMENTO([A, B], A), 'yes', 0.770, depth, 2.0);
  const nuovo = chiedi(NUOVO_ENTRAMBI([A, B]), 'yes', 0.770, depth, 2.0);

  ok('il VECCHIO piazza a 0.76, un tick dietro alla NOSTRA gamba a 0.77', vecchio.price === 0.76,
    `${vecchio.price} (bestOther ${vecchio.bestOther})`);
  ok('  e la gemella resta PRIMA sul libro: «mai primi» è aggirato da noi stessi',
    vecchio.bestOther === B.price);
  ok('il NUOVO piazza a 0.75, un tick dietro al CONCORRENTE a 0.76', nuovo.price === 0.75,
    `${nuovo.price} (bestOther ${nuovo.bestOther})`);
  ok('i due prezzi divergono di un tick intero', Math.abs(vecchio.price - nuovo.price) - TICK < 1e-9
    && vecchio.price !== nuovo.price, `${vecchio.price} vs ${nuovo.price}`);
}

console.log('\n══ 3 · DUE NOSTRI ORDINI SULLO STESSO LIVELLO VANNO SOTTRATTI ENTRAMBI');
{
  // Il livello 0.77 porta 96.8 quote, tutte nostre. Sottraendone una sola resta un residuo di 48.4 che
  // si presenta come «un altro partecipante» — che è noi, con un'altra faccia.
  const bids = [{ price: 0.77, size: 96.8 }, { price: 0.74, size: 500 }];
  const depth = { yes: { bids, asks: [] }, no: { bids: [], asks: [] } };
  const A = { orderId: 'A', price: 0.77, size: 48.4 };
  const B = { orderId: 'B', price: 0.77, size: 48.4 };
  const una = chiedi([A], 'yes', 0.785, depth, 2.0);
  const due = chiedi([A, B], 'yes', 0.785, depth, 2.0);
  ok('sottraendone UNA sola il livello sopravvive come «altrui»', una.bestOther === 0.77, String(una.bestOther));
  ok('sottraendole ENTRAMBE il livello sparisce', due.bestOther === 0.74, String(due.bestOther));
  ok('  e il concorrente cambia di conseguenza', una.bestOther !== due.bestOther, `${una.bestOther} → ${due.bestOther}`);
}

console.log('\n══ 4 · NEL CODICE L INSIEME È UNO SOLO, IN TUTTI I PUNTI DI CHIAMATA');
{
  const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  ok('è calcolato una volta e ha un nome',
    /const nostriSulLato = owned\.filter\(\(x\) => x\.book === order\.book\);/.test(src));
  const usi = (src.match(/ownOrders: nostriSulLato/g) || []).length;
  ok('  e lo usano ALMENO i due rami storici (decisione e piazzamento)', usi >= 2, `${usi} usi`);
  // ── PERCHÉ «ALMENO» E NON «ESATTAMENTE» (6 agosto 2026) ────────────────────────────────────────
  // L'assert chiedeva esattamente 2. Col veto di profilo i consumatori sono diventati TRE: decisione,
  // piazzamento e la valutazione del percorso Safe/Risk — che riceve lo stesso insieme perché deve
  // sottrarre i nostri ordini esattamente come gli altri due. È un RAFFORZAMENTO della simmetria, non
  // una sua rottura: un numero esatto avrebbe punito l'aggiunta di un terzo consumatore corretto.
  // Ciò che va difeso resta che l'insieme sia UNO, ed è quello che l'assert sopra verifica.
  ok('  e il terzo consumatore è il veto di profilo', usi >= 3,
    `${usi} usi: decisione, piazzamento, veto di profilo`);
  ok('  il ramo del piazzamento non esclude più l ordine valutato',
    !/o\.orderId !== order\.orderId/.test(src), 'filtro rimosso');
  ok('  e nemmeno la previsione dentro decideReprice',
    !/nostriAlNetto/.test(src), 'filtro rimosso');
}

console.log(`\nsimmetria di ownOrders: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
