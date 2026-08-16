'use strict';
// lib/maker/uscita-scende-con-la-scala.test.js — L'USCITA GIÀ A LIBRO SCENDE QUANDO LA SCALA CONCEDE.
//
// ═══ IL DIFETTO, TROVATO DALLA MISURA E NON DAL RAGIONAMENTO ═════════════════════════════════════════
// Il 16 agosto 2026 una posizione su FL-27 è rimasta aperta CINQUE ORE. L'ipotesi di partenza era che
// l'orologio della scala si azzerasse a ogni ripiazzamento (§5-bis p.138). **Era sbagliata**, e la
// misura lo ha dimostrato: `data/modalita-chiusura.json` portava `da: 15:20:41Z` — l'istante esatto del
// fill — per tutte e cinque le ore, e la dep `chiusura` era cablata correttamente in agent40.
//
// Il difetto vero: il ramo `already-covered` di `decideClose` RITORNA PRIMA che il prezzo d'uscita
// venga ricalcolato. L'uscita si piazza una volta, al gradino che la scala concedeva in quel momento,
// e non scende MAI più. Nel giornale del 16/08 `urgenzaLivello` compare **una sola volta in cinque
// ore** su quel mercato: la scala non è stata quasi mai valutata, non perché il suo orologio fosse
// sbagliato, ma perché nessuno glielo chiedeva più.
// Vista dal vivo: uscita ferma a 21¢ con carico 20¢ mentre il book scendeva a 16/18. Un ordine appeso
// sopra il mercato non è un'uscita: è una posizione direzionale con un alibi.
//
// ═══ COSA SI DIFENDE ═════════════════════════════════════════════════════════════════════════════════
// Che ogni gradino SCATTI davvero sul prezzo, non solo che la condizione sia vera — è la differenza
// che è costata cinque ore. E che il ramo possa solo ABBASSARE: non deve poter diventare un modo di
// pretendere di più da una posizione che il mercato ha già superato.

const assert = require('assert');
const { decideClose } = require('./auto-close');
const U = require('./urgenza-scoperto');

let p = 0;
const ok = (nome, cond, extra = '') => { assert.ok(cond, `${nome} ${extra}`); p += 1; console.log(`  ✓ ${nome}`); };

const CARICO = 0.20;
const TICK = 0.01;
// `rules` deve avere la forma vera che `decideClose` legge: i due book col loro scoringMid.
const mkRules = (mid) => ({ readable: true, tick: TICK, maxSpreadCents: 4.5,
  tokenId: 'tokY', tokenIdNo: 'tokN',
  books: { yes: { scoringMid: 1 - mid }, no: { scoringMid: mid } } });
const rules = mkRules(0.175);
const posizione = { tokenId: 'tokN', size: 56.82, avgPrice: CARICO };
const uscita = (price) => ([{ orderId: '0xold', side: 'SELL', price, size: 56.82, tokenId: 'tokN' }]);
const scala = (min) => U.livelloUrgenza({ scopertoDaMin: min });

// `scoringMid` scende: il mercato si muove CONTRO la posizione, che è il caso reale.
const decidi = (minuti, prezzoALibro, mid = 0.175) => decideClose({
  position: posizione, restingOrders: uscita(prezzoALibro), rules: mkRules(mid), book: 'no',
  venue: { bestBid: mid - 0.005, bestAsk: mid + 0.005, midPrice: mid },
  urgenza: scala(minuti),
});

console.log('\n════ l\'uscita scende con la scala ════');

// ── GRADINO 0 (< 30 min): nessuna concessione, l'uscita a +1¢ resta ─────────────────────────────
{
  const d = decidi(10, 0.21);
  ok('① gradino 0 a 10 min: l\'uscita a 21¢ non si tocca',
    d.action === 'already-covered', `(action=${d.action})`);
  ok('  e la scala lo conferma: nessuna concessione', scala(10).concessioneTick === 0 && scala(10).profitPct === 1);
}

// ── GRADINO 1 (≥ 30 min): l'uscita può scendere fino al CARICO ⇒ 21¢ → 20¢ ──────────────────────
{
  const d = decidi(35, 0.21);
  ok('② gradino 1 a 35 min: SCATTA — l\'uscita si abbassa', d.action === 'close', `(action=${d.action})`);
  ok('  fino al carico, non oltre', d.price <= CARICO + 1e-9 && d.price >= CARICO - 1e-9,
    `(price=${d.price})`);
  ok('  e dichiara il gradino e il prezzo precedente',
    d.urgenzaLivello === 1 && Math.abs(d.prezzoPrecedente - 0.21) < 1e-9);
  ok('  e porta gli id da cancellare, o resterebbero due ordini',
    Array.isArray(d.cancelOrderIds) && d.cancelOrderIds[0] === '0xold');
}

// ── GRADINO 2 (≥ 60 min): concessione di 1 tick sotto il carico ⇒ 19¢ ───────────────────────────
{
  const d = decidi(80, 0.21);
  // Il mercato è a 17,5¢ con ask 18: l'uscita insegue fin dove viene presa, ma il pavimento della
  // scala (carico − 1 tick = 19¢) la ferma prima. È il punto: due limiti, e vince il più stretto.
  ok('③ gradino 2 a 80 min: SCATTA e scende SOTTO il carico', d.action === 'close' && d.price < CARICO,
    `(price=${d.price})`);
  ok('  fino al pavimento della scala (19¢) e non oltre, anche se l\'ask è più in basso',
    Math.abs(d.price - 0.19) < 1e-9, `(price=${d.price})`);
  ok('  ed è dichiarata PEGGIORATIVA: una perdita non deve essere indistinguibile da un guadagno',
    d.peggiorativa === true && d.profitCents < 0);
}

// ── IL RAMO PUÒ SOLO ABBASSARE ──────────────────────────────────────────────────────────────────
{
  // L'uscita è GIÀ a 19¢ e la scala concederebbe 19¢: non si tocca (nessun churn a parità).
  const d = decidi(80, 0.19);
  ok('④ uscita già al prezzo che la scala concede: non si riprezza', d.action === 'already-covered');
  // L'uscita è a 15¢, sotto ciò che la scala concede: NON si alza.
  const alto = decidi(80, 0.15);
  ok('  e un\'uscita già più bassa NON viene alzata: il ramo riduce e basta',
    alto.action === 'already-covered', `(action=${alto.action})`);
}

// ── IL MERCATO CHE SI MUOVE CONTRO ──────────────────────────────────────────────────────────────
{
  // Stesso gradino, mid molto più basso: il piano deve restare dentro la banda e sopra il pavimento.
  const d = decidi(80, 0.21, 0.10);
  ok('⑤ mercato che scende: la decisione resta calcolabile e non inventa prezzi',
    d.action === 'close' || d.action === 'already-covered' || d.action === 'skip');
  if (d.action === 'close') {
    ok('  e il prezzo non scende mai sotto il pavimento della scala (carico − 1 tick)',
      d.price >= CARICO - TICK - 1e-9, `(price=${d.price})`);
  } else {
    ok('  oppure si astiene invece di vendere a un prezzo fuori regola', true);
  }
}

// ── ANCORA MANCANTE ⇒ GRADINO 0, e l'uscita resta dov'è ─────────────────────────────────────────
{
  const d = decideClose({ position: posizione, restingOrders: uscita(0.21), rules, book: 'no',
    venue: { bestBid: 0.17, bestAsk: 0.18, midPrice: 0.175 }, urgenza: U.livelloUrgenza({ scopertoDaMin: null }) });
  ok('⑥ orologio non leggibile ⇒ nessuna concessione, uscita invariata',
    d.action === 'already-covered');
  ok('  perché non si paga contro un dato che non si è letto',
    U.livelloUrgenza({ scopertoDaMin: null }).concessioneTick === 0);
}

// ── SENZA `urgenza` IL COMPORTAMENTO È QUELLO DI PRIMA ──────────────────────────────────────────
{
  const d = decideClose({ position: posizione, restingOrders: uscita(0.21), rules, book: 'no',
    venue: { bestBid: 0.17, bestAsk: 0.18, midPrice: 0.175 } });
  ok('⑦ dep `urgenza` non iniettata ⇒ nessun cambiamento di comportamento',
    d.action === 'already-covered');
}

console.log(`\nuscita-scende-con-la-scala: ${p} passati, 0 falliti`);
