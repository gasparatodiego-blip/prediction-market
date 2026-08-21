'use strict';
// lib/rewardScore-denominatore.test.js — IL DENOMINATORE DEL PUNTEGGIO È IL COSTO DELLA COPPIA.
//
// ═══ IL DIFETTO CHE QUESTO TEST DIFENDE (D1, 21 agosto 2026) ═════════════════════════════════════
// `lib/rewardScore.js` convertiva capitale→share dividendo per il MID (`capital / price`), mentre il
// percorso che piazza divide per il COSTO DELLA COPPIA (`lib/rewards/size-da-capitale.sharePerLato`).
// Due formule per la stessa domanda: il reperto D1.
//
// ═══ PERCHÉ IL COSTO DELLA COPPIA È IL DENOMINATORE GIUSTO — dalla formula del VENUE ════════════
// Il venue scora SHARE: `Q = Σ S(v,s)·size_i`. Non conosce il capitale. La domanda è quindi soltanto
// «quante share compra C dollari nella posa che la funzione dichiara di modellare», e la funzione
// dichiara una posa BILATERALE SIMMETRICA a distanza `s` («All scenarios assume the user posts
// symmetrically on BOTH sides at the same distance»). Quella posa costa, per share:
//
//     bid YES a (mid − s/100)                                        → mid − s/100
//   + ask YES a (mid + s/100), finanziato comprando NO a 1−(mid+s/100) → 1 − mid − s/100
//   ────────────────────────────────────────────────────────────────────────────────
//   = 1 − 2s/100        ⇐ IL MID SI CANCELLA
//
// `capital/mid` è invece la size di una posa UNILATERALE che spende tutto sulla gamba YES: finanzia
// UN lato e poi ne scora DUE (`qMin(Qu,Qu,mid)`). Su un mid fuori da [0,10 · 0,90] il venue PRETENDE
// il bilaterale, quindi quella posa varrebbe ZERO — ed è proprio dove l'errore era massimo (10,0×
// misurato sul mercato «1 Fed rate cut», mid 0,095).
//
// ⚠ IL TEST MORDE SUL CALCOLO, NON SU UNA COSTANTE: non cerca stringhe nel sorgente, non conta
// occorrenze. Verifica una PROPRIETÀ — il punteggio di una posa simmetrica non dipende dal mid — e
// la verifica invertendo l'algebra per riottenere la size e confrontarla con la funzione SSOT.

const assert = require('assert');
const RS = require('./rewardScore');
const SDC = require('./rewards/size-da-capitale');
const { raggioBandaCents } = require('./banda-premiante');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const vicino = (a, b, eps, m) => { assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps,
  `${m} — atteso ${b}, ottenuto ${a} (tolleranza ${eps})`); n++; };
// ⚠ TOLLERANZA RELATIVA PER LE SIZE, E IL MOTIVO E' NEL CODICE, non nella comodita': la quota esce da
// `parseFloat(share.toFixed(6))`, cioè arrotondata a sei decimali. Invertirla per riottenere la size
// riporta indietro quell'arrotondamento amplificato — su una quota di 0,0255 sono ~2·10⁻⁵ relativi.
// 10⁻⁴ resta cinque ordini di grandezza sotto l'errore che il test deve prendere (il vecchio
// denominatore sbagliava di 10×, cioè 10⁺¹ relativo): la soglia non ammorbidisce niente.
const vicinoRel = (a, b, rel, m) => { assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.abs(b) * rel,
  `${m} — atteso ${b}, ottenuto ${a} (tolleranza relativa ${rel})`); n++; };

const V = 4.5, MINSIZE = 50, POOL = 100, Q = 10000, CAP = 1000;
const qc = (mid) => ({ Qmin: Q, mid });
/** Il costo della coppia per una posa simmetrica a `s` centesimi. Scritto QUI a mano di proposito:
 *  se il test importasse la funzione della produzione, un errore condiviso passerebbe inosservato. */
const coppiaA = (s) => 1 - 2 * (s / 100);
/** La size che il punteggio implica, ricavata invertendo `share = Qu/(Qu+Q)` con `Qu = S·size`. */
function sizeImplicita(share, s_cents) {
  const S = RS.scoreOrder(s_cents, raggioBandaCents(V));
  const Qu = (share * Q) / (1 - share);
  return Qu / S;
}

// ── ① LA PROPRIETÀ CENTRALE: A PARITÀ DI TUTTO IL RESTO, IL MID NON CAMBIA IL PUNTEGGIO ─────────
// Due mercati identici per banda, minSize, concorrenza e montepremi, e mid lontanissimi. Una posa
// simmetrica costa `1 − 2s/100` su entrambi, quindi compra le STESSE share e prende la STESSA quota.
// Sul sorgente non corretto le size stanno in rapporto 10:1 e questa asserzione cade.
{
  const a = RS.estimateCapitalLevelRange(qc(0.05), V, MINSIZE, POOL, CAP);
  const b = RS.estimateCapitalLevelRange(qc(0.50), V, MINSIZE, POOL, CAP);
  vicino(a.typical.share, b.typical.share, 1e-9,
    '① il punteggio tipico deve essere identico a mid 0,05 e a mid 0,50');
  vicino(a.typical.grossRewardDay, b.typical.grossRewardDay, 1e-9,
    '① il reward giornaliero deve essere identico ai due mid');
  vicino(a.low.share, b.low.share, 1e-9, '① idem sulla posa esterna');
  vicino(a.high.share, b.high.share, 1e-9, '① idem sulla posa vicina al mid');
}

// ── ② IL DENOMINATORE È QUELLO DELLA SSOT, VERIFICATO INVERTENDO L'ALGEBRA ───────────────────────
// Si ricava la size dal punteggio prodotto e la si confronta con `sharePerLato`, cioè la funzione che
// il PIAZZAMENTO usa. Non si confronta una costante: si confronta un numero calcolato.
{
  const mid = 0.37;
  const r = RS.estimateCapitalLevelRange(qc(mid), V, MINSIZE, POOL, CAP);
  const sTip = raggioBandaCents(V) / 2;
  const attesa = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppiaA(sTip) }).shares;
  vicinoRel(sizeImplicita(r.typical.share, sTip), attesa, 1e-4,
    '② la size implicita nel punteggio deve coincidere con sharePerLato(capitale, costoCoppia)');
  ok(Math.abs(sizeImplicita(r.typical.share, sTip) - CAP / mid) > 1,
    '② e NON deve coincidere con capitale/mid, che è la formula sbagliata');
}

// ── ③ IL CASO IN CUI MID E COSTO DELLA COPPIA DIVERGONO MOLTO ───────────────────────────────────
// mid 0,03 contro un costo della coppia di 0,955: fattore 31,8×. È il caso che distingue davvero i
// due rami — a mid ≈ 0,5 la vecchia formula sbagliava «solo» di 1,9× e un test lasco lo perdonerebbe.
{
  const mid = 0.03;
  const sTip = raggioBandaCents(V) / 2;
  const r = RS.estimateCapitalLevelRange(qc(mid), V, MINSIZE, POOL, CAP);
  const attesa = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppiaA(sTip) }).shares;
  vicinoRel(sizeImplicita(r.typical.share, sTip), attesa, 1e-4,
    '③ divergenza estrema (mid 0,03 vs coppia 0,955): la size deve restare quella della coppia');
  const rapportoSbagliato = (CAP / mid) / attesa;
  ok(rapportoSbagliato > 30, '③ il caso scelto deve davvero divergere (rapporto > 30×)');
}

// ── ④ `quadraticUserShare` HA LO STESSO DENOMINATORE ────────────────────────────────────────────
// È la funzione che produce `rewardScore.refShare` in `lib/rewards-normalize.js:137`, cioè il numero
// che l'operatore legge come «$/giorno». Aveva lo stesso difetto sulla stessa riga di aritmetica.
{
  const d = raggioBandaCents(V) / 4;
  const a = RS.quadraticUserShare(Q, 0.06, V, MINSIZE, CAP, d);
  const b = RS.quadraticUserShare(Q, 0.60, V, MINSIZE, CAP, d);
  vicino(a, b, 1e-9, '④ quadraticUserShare non deve dipendere dal mid');
  vicinoRel(sizeImplicita(a, d), SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppiaA(d) }).shares, 1e-4,
    '④ e la sua size implicita deve essere quella della coppia');
}

// ── ⑤ L'INVERSA RESTA UN'INVERSA (le righe 135 e 206 si muovono INSIEME) ────────────────────────
// `recoverCompetitorQ` è l'inversa algebrica di `estimateCapitalLevelRange` alla posa tipica. Se una
// delle due cambia denominatore e l'altra no, la Q recuperata è sbagliata **in silenzio** — e da lì
// nasce `refShare`. Questo blocco fallisce su una correzione fatta a metà.
{
  const mid = 0.095;
  const livelli = {};
  for (const C of [500, 5000, 50000]) {
    const r = RS.estimateCapitalLevelRange(qc(mid), V, MINSIZE, POOL, C);
    livelli[String(C)] = { capital: C, share: r.typical.share };
  }
  const rec = RS.recoverCompetitorQ(livelli, mid, V, MINSIZE);
  vicinoRel(rec, Q, 1e-4, '⑤ recoverCompetitorQ deve restituire la Q usata per costruire i livelli');
}

// ── ⑥ LA CURVA RESTA MONOTONA — nessun errore di segno introdotto dalla correzione ──────────────
// Più vicino al mid ⇒ punteggio più alto. Vale in entrambi i mondi: serve a non scambiare una
// correzione del denominatore per un capovolgimento della formula.
{
  const r = RS.estimateCapitalLevelRange(qc(0.42), V, MINSIZE, POOL, CAP);
  ok(r.atMid.share >= r.high.share, '⑥ al mid ≥ posa vicina');
  ok(r.high.share >= r.typical.share, '⑥ posa vicina ≥ posa tipica');
  ok(r.typical.share >= r.low.share, '⑥ posa tipica ≥ posa esterna');
}

// ── ⑦ FALLISCE CHIUSO: UNA POSA NON ESPRIMIBILE VALE ZERO, NON UN NUMERO INVENTATO ─────────────
// A mid 0,01 un bid a 2,25¢ sotto il mid cadrebbe a prezzo NEGATIVO: quella posa simmetrica non
// esiste, e il punteggio onesto è zero. Non si inventa una size clampando il mid a 0,01 — che è
// esattamente ciò che faceva `Math.max(0.01, ...)`.
{
  const r = RS.estimateCapitalLevelRange(qc(0.01), V, MINSIZE, POOL, CAP);
  vicino(r.typical.share, 0, 1e-12, '⑦ posa non esprimibile ⇒ quota 0');
  vicino(r.typical.grossRewardDay, 0, 1e-12, '⑦ posa non esprimibile ⇒ reward 0');
}

// ── ⑧ IL CONFINE DICHIARATO: `flatUserShare` (KALSHI) NON È STATA TOCCATA ───────────────────────
// Kalshi non pubblica né banda né formula: `flatUserShare` rispecchia il modello OSSERVATO di
// agent25 e non la formula quadratica del venue. Cambiarne il denominatore senza una formula a cui
// ancorarsi sarebbe speculativo. L'asserzione fissa il confine, così l'omissione resta una scelta
// leggibile e non una svista.
{
  const a = RS.flatUserShare(1000, 0.10, 100);
  const b = RS.flatUserShare(1000, 0.50, 100);
  ok(a !== b, '⑧ flatUserShare (Kalshi) dipende ANCORA dal mid: confine dichiarato, non corretto qui');
}

console.log(`rewardScore-denominatore: ${n}/${n} verdi, 0 rossi`);
