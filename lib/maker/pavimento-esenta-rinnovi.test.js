'use strict';
// lib/maker/pavimento-esenta-rinnovi.test.js — IL PAVIMENTO NON MURA UN RINNOVO, E NON APRE UN VARCO.
//
// Chiude §5.2 p.21, aperto il 13 agosto 2026 e osservato dal vivo il 16: 34 `anomalia-rinnovo-fermato`
// in 22 minuti su `0xf2b0c93903a1…`, 6 ordini morti per GTD, quel mercato rimasto a GAMBA SINGOLA.
// Il pavimento di profondita' esiste per evitare esposizione direzionale su book sottili, e la stava
// producendo lui.
//
// Si provano i QUATTRO casi che l'operatore ha chiesto, al livello del MOTORE (non del solo modulo
// puro): e' li' che il pavimento morde, ed e' li' che un'esenzione mal cablata diventerebbe un varco.

const assert = require('assert');
const M = require('./motore-unico');
const { provaRinnovo } = require('./esenzione-rinnovo');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

// Un book SOTTILE: due livelli in banda per $12 totali, contro un pavimento di $200. Su un'apertura
// il motore deve rifiutare; su un rinnovo provato deve passare.
const BOOK = [
  { price: 0.66, size: 10 },   // livello 1 — la ricerca parte dal secondo («mai primo»)
  { price: 0.65, size: 10 },   // livello 2 — $6,50
  { price: 0.64, size: 9 },    // livello 3 — $5,76 cumulati $12,26
];
const COMUNE = { side: 'BUY', bookLevels: BOOK, bandBounds: { lo: 0.62, hi: 0.71 },
  ownOrders: [], tick: 0.01, scoringMid: 0.665, bandRadiusCents: 4.5, pavimentoUsd: 200 };

const vivo = (size, price) => ([{ orderId: '0xold', marketId: '0xM', tokenId: 'tokA', side: 'BUY', size, price }]);
const prova = (size, price, vivi) => provaRinnovo({ conditionId: '0xM', tokenId: 'tokA', side: 'BUY', size, price, ordiniVivi: vivi });

console.log('\n════ il pavimento esenta i rinnovi provati ════');

// ── IL PUNTO DI PARTENZA: senza esenzione il pavimento mura ─────────────────────────────────────
const senza = M.trovaLivello(COMUNE);
ok('APERTURA su book sottile: il pavimento RIFIUTA, come deve',
  senza.ok === false && /pavimento/.test(senza.motivo));

// ── ① RINNOVO PURO: stessa size, stesso prezzo ⇒ passa ──────────────────────────────────────────
const r1 = prova(56, 0.65, vivo(56, 0.65));
const con1 = M.trovaLivello({ ...COMUNE, rinnovo: r1 });
ok('① rinnovo provato (stessa size e prezzo): il pavimento NON mura piu\'',
  r1.esente === true && con1.ok === true);
ok('  e il motivo DICHIARA l\'esenzione, non la applica in silenzio',
  /PAVIMENTO ESENTATO/.test(con1.motivo));

// ── ② SIZE IN AUMENTO ⇒ apertura, il pavimento resta ────────────────────────────────────────────
const r2 = prova(57, 0.65, vivo(56, 0.65));
const con2 = M.trovaLivello({ ...COMUNE, rinnovo: r2 });
ok('② size in aumento: NON e\' un rinnovo, il pavimento mura', r2.esente === false && con2.ok === false);

// ── ③ NOZIONALE IN AUMENTO (stessa size, prezzo piu' alto) ⇒ apertura ───────────────────────────
const r3 = prova(56, 0.70, vivo(56, 0.65));
ok('③ nozionale in aumento a size invariata: NON e\' un rinnovo', r3.esente === false);
// ⚠ E LA META' CHE CONTA: anche quando la prova passa, il MOTORE non puo' scegliere un livello piu'
// caro dell'ordine sostituito. Senza questo, l'esenzione varrebbe per piu' capitale a riposo.
const r3b = prova(56, 0.64, vivo(56, 0.64));
const con3b = M.trovaLivello({ ...COMUNE, rinnovo: r3b });
ok('  e il motore non sceglie un livello PIU\' CARO del sostituito (0,65 e 0,66 esclusi)',
  con3b.ok === true && con3b.price <= 0.64 + 1e-9);

// ── ④ FAIL-CLOSED: nessun ordine vivo da rinnovare ⇒ apertura ───────────────────────────────────
const r4 = prova(56, 0.65, []);
const con4 = M.trovaLivello({ ...COMUNE, rinnovo: r4 });
ok('④ nessun ordine vivo: e\' un\'apertura, il pavimento mura', r4.esente === false && con4.ok === false);
const r4b = prova(56, 0.65, null);
ok('  ordini non leggibili: apertura', r4b.esente === false);
const con4c = M.trovaLivello({ ...COMUNE, rinnovo: { esente: 'si' } });
ok('  una dichiarazione truthy ma non `true` non esenta niente', con4c.ok === false);
const con4d = M.trovaLivello({ ...COMUNE, rinnovo: null });
ok('  `rinnovo` assente ⇒ comportamento di prima', con4d.ok === false);

// ── COSA NON E' STATO TOCCATO ───────────────────────────────────────────────────────────────────
// «Mai primo sul libro» vive nella stessa funzione ed e' la ragione per cui la ricerca parte dal
// secondo livello: un'esenzione che lo avesse allentato si vedrebbe qui.
ok('«mai primo sul libro» resta: il livello scelto non e\' il migliore altrui (0,66)',
  con1.price < 0.66 - 1e-9);
const unSolo = M.trovaLivello({
  ...COMUNE, bookLevels: [{ price: 0.66, size: 10 }], rinnovo: r1 });
ok('  e con UN SOLO livello in banda non si quota comunque, esenzione o no',
  unSolo.ok === false && /un solo livello|1 livello/i.test(unSolo.motivo));

console.log(`\npavimento-esenta-rinnovi: ${p} passati, 0 falliti`);
