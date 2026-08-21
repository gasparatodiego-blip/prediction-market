'use strict';
// scripts/ricerca/frontiera-onesta.js — SOLA LETTURA.
//
// LA CORREZIONE CHE CAMBIA IL RISULTATO: il modello precedente metteva l'ordine a 2,5c dal mid
// SEMPRE. Ma su questi mercati lo spread mediano dei candidati migliori e' 6-7c, cioe' PIU' LARGO
// della banda (4,5c): un ordine a 2,5c dal mid sarebbe DAVANTI al miglior bid altrui, e «mai primo
// sul libro» (§4.1 regola 1) lo vieta. Qui il prezzo lo decide `planBehindBest`, LA STESSA funzione
// del piazzamento, chiamata via `verdettoQuotabilita` come fa l'allocatore (allocator.js:596).
//
// Nessuna aritmetica riscritta: banda da `banda-premiante`, coppia da `size-da-capitale`,
// punteggio e qMin da `rewardScore`.
const fs = require('fs'); const path = require('path');
const RS = require('../../lib/rewardScore');
const SDC = require('../../lib/rewards/size-da-capitale');
const { raggioBandaCents } = require('../../lib/banda-premiante');
const { planBehindBest } = require('../../lib/maker/top-of-book');

const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca');
const U = JSON.parse(fs.readFileSync(path.join(OUT, 'universo-premiante.json'), 'utf8'));
const CACHE = JSON.parse(fs.readFileSync(path.join(OUT, 'libri-cache.json'), 'utf8')).libri;
const BOARD = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json'), 'utf8'));
const VISTI = new Set(BOARD.markets.map(m => m.conditionId));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const TETTO_CREDIBILE = 0.60;

/** Il tick, DEDOTTO dai prezzi del libro (nessun endpoint batch per `/tick-size`). Dichiarato come
 *  inferito: se un prezzo qualunque ha la terza cifra decimale, la griglia e' 0,001. */
function tickDedotto(bids, asks) {
  for (const o of [...bids, ...asks]) {
    const s = String(o.price);
    const dot = s.indexOf('.');
    if (dot >= 0 && s.length - dot - 1 >= 3) return 0.001;
  }
  return 0.01;
}
const num = (a) => (a || []).map(o => ({ price: +o.price, size: +o.size })).filter(o => o.price > 0 && o.size > 0);

/**
 * Il premio VERO di un mercato a capitale `C`: prezzo scelto dalla regola del piazzamento, punteggio
 * a QUELLA distanza, quota contro il Q misurato sul libro. `null` quando il mercato non e' quotabile.
 */
function valuta(m, C) {
  const bYes = CACHE[String(m.tokenIds[0])], bNo = CACHE[String(m.tokenIds[1])];
  if (!bYes || !bNo) return null;
  const bids = num(bYes.bids), asks = num(bYes.asks);
  if (!bids.length || !asks.length) return null;
  const bestBid = Math.max(...bids.map(o => o.price));
  const bestAsk = Math.min(...asks.map(o => o.price));
  if (!(bestAsk > bestBid)) return null;
  const tick = tickDedotto(bids, asks);
  const v = raggioBandaCents(m.maxSpread);
  if (v == null) return null;
  // il mid di scoring: la stessa funzione del venue (filtra sotto minSize), via scoreBook
  const sc = RS.scoreBook({ bids: bYes.bids, asks: bYes.asks }, m.maxSpread, m.minSize, (bestBid + bestAsk) / 2);
  const mid = fin(sc.mid) ? sc.mid : (bestBid + bestAsk) / 2;
  const cQ = fin(sc.Qmin) ? sc.Qmin : null;
  if (cQ == null || !(cQ > 0)) return { stato: 'libro-senza-concorrenza-misurata', cQ };
  // ── IL PREZZO, DALLA REGOLA VERA. Lato ask valutato nello spazio specchiato, come quotabilita.js:61
  const specchia = (p) => 1 - p;
  const pb = planBehindBest({ bestOther: bestBid, tick, scoringMid: mid, bandRadiusCents: v });
  const pa = planBehindBest({ bestOther: specchia(bestAsk), tick, scoringMid: specchia(mid), bandRadiusCents: v });
  if (pb.ok !== true || pa.ok !== true) {
    return { stato: pb.quotabile === false || pa.quotabile === false ? 'non-quotabile' : 'ignota',
      cQ, motivo: (pb.reason || pa.reason || '').slice(0, 120) };
  }
  const prezzoBid = pb.price;                 // il nostro BUY YES
  const prezzoAskSpec = pa.price;             // nello spazio specchiato
  const prezzoAsk = specchia(prezzoAskSpec);  // il nostro SELL YES  (= BUY NO a 1-prezzoAsk)
  const dBid = Math.abs(mid - prezzoBid) * 100;
  const dAsk = Math.abs(prezzoAsk - mid) * 100;
  // il costo VERO della coppia: BUY YES a prezzoBid + BUY NO a (1 - prezzoAsk)
  const pairCost = prezzoBid + (1 - prezzoAsk);
  if (!(pairCost > 0)) return null;
  const size = C / pairCost;
  if (size < m.minSize) return { stato: 'sotto-il-minimo-premiante', cQ, sizeServita: m.minSize * pairCost };
  const S = (s) => (s >= v ? 0 : ((v - s) / v) ** 2);
  const Qb = S(dBid) * size, Qa = S(dAsk) * size;
  const Qu = (mid < 0.10 || mid > 0.90) ? Math.min(Qb, Qa) : Math.max(Math.min(Qb, Qa), Math.max(Qb, Qa) / 3);
  if (!(Qu > 0)) return { stato: 'punteggio-zero', cQ, dBid, dAsk, v };
  const shareGrezza = Qu / (Qu + cQ);
  const share = Math.min(TETTO_CREDIBILE, shareGrezza);
  return { stato: 'ok', cQ: +cQ.toFixed(2), mid: +mid.toFixed(4), tick, v,
    dBid: +dBid.toFixed(2), dAsk: +dAsk.toFixed(2), modoBid: pb.mode, modoAsk: pa.mode,
    pairCost: +pairCost.toFixed(4), size: +size.toFixed(1),
    shareGrezza: +shareGrezza.toFixed(5), share: +share.toFixed(5), tettoMorde: shareGrezza > TETTO_CREDIBILE,
    premio: +(m.rate * share).toFixed(4),
    spread: +((bestAsk - bestBid) * 100).toFixed(2) };
}

module.exports = { valuta, U, VISTI, TETTO_CREDIBILE };

if (require.main === module) {
  const CAP = Number(process.argv[2] || 61.25);
  const cand = U.ammissibili.filter(m => m.tokenIds && m.tokenIds.length >= 2 && m.maxSpread > 0);
  const stati = {}; const ok = [];
  for (const m of cand) {
    const r = valuta(m, CAP);
    const st = r ? (r.stato || 'ok') : 'senza-libro';
    stati[st] = (stati[st] || 0) + 1;
    if (r && r.stato === 'ok') ok.push({ ...m, ...r, visto: VISTI.has(m.id) });
  }
  ok.sort((a, b) => b.premio - a.premio);
  console.log(`ammissibili (>=24h, minSize<=50): ${cand.length} · a $${CAP} ciascuno`);
  console.log('esiti:', JSON.stringify(stati));
  console.log('');
  console.log(`I 20 MIGLIORI col PREZZO VERO (planBehindBest), $${CAP} ciascuno:`);
  console.log('premio/g  rate  cQ       share   dBid  dAsk  v    spread modoBid            visto domanda');
  for (const r of ok.slice(0, 20)) console.log(
    ('$' + r.premio.toFixed(3)).padEnd(10), ('$' + r.rate).padEnd(5), String(r.cQ).padEnd(9),
    (100 * r.share).toFixed(2).padStart(5) + '%', String(r.dBid).padStart(5), String(r.dAsk).padStart(5),
    String(r.v).padStart(4), String(r.spread).padStart(6), ' ' + String(r.modoBid).padEnd(18),
    (r.visto ? ' SI  ' : ' no  '), String(r.q).slice(0, 40));
  const s20 = ok.slice(0, 20).reduce((a, r) => a + r.premio, 0);
  const s5 = ok.slice(0, 5).reduce((a, r) => a + r.premio, 0);
  console.log('');
  console.log(`SOMMA 20 migliori: $${s20.toFixed(3)}/g su $${(20 * CAP).toFixed(2)}   ·  5 migliori: $${s5.toFixed(3)}/g su $${(5 * CAP).toFixed(2)}`);
  console.log(`quanti superano $1/g: ${ok.filter(r => r.premio >= 1).length} · $0,10/g: ${ok.filter(r => r.premio >= 0.10).length}`);
  console.log(`dei 20 migliori NON visti dal board: ${ok.slice(0, 20).filter(r => !r.visto).length}/20`);
  console.log(`quante volte morde il tetto di credibilita' 0,60: ${ok.filter(r => r.tettoMorde).length}`);
  fs.writeFileSync(path.join(OUT, 'frontiera-onesta.json'), JSON.stringify({
    lettoAl: new Date().toISOString(), capMercato: CAP, ammissibili: cand.length, stati,
    sommaTop20: +s20.toFixed(4), sommaTop5: +s5.toFixed(4),
    righe: ok.map(r => ({ id: r.id, q: r.q, rate: r.rate, minSize: r.minSize, ore: r.ore, visto: r.visto,
      cQ: r.cQ, mid: r.mid, v: r.v, tick: r.tick, spread: r.spread, dBid: r.dBid, dAsk: r.dAsk,
      modoBid: r.modoBid, modoAsk: r.modoAsk, size: r.size, pairCost: r.pairCost,
      share: r.share, shareGrezza: r.shareGrezza, tettoMorde: r.tettoMorde, premio: r.premio })),
  }, null, 1));
  console.log('\nscritto data/ricerca/frontiera-onesta.json');
}
