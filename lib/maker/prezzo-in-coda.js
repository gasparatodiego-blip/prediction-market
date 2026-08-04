'use strict';
// lib/maker/prezzo-in-coda.js — MAI PRIMI SUL LIBRO: UN TICK DIETRO A CHI C'È GIÀ.
//
// ═══ PERCHÉ ════════════════════════════════════════════════════════════════════════════════════════
// Stare in cima al book significa essere i primi a essere eseguiti. Per un maker che vive di reward e
// non di spread, l'esecuzione è il costo, non il ricavo: la posizione va poi chiusa, e nel frattempo il
// mercato può muoversi. Un tick dietro al miglior prezzo altrui si matura lo stesso reward — la banda
// premiante è larga, il punteggio dentro di essa cambia poco fra un tick e l'altro — e si lascia che sia
// qualcun altro a incassare il flusso aggressivo.
//
// La regola esisteva già, scritta e testata in lib/maker/top-of-book.js, ma era collegata SOLO al motore
// di tracking a due lati, che oggi governa zero mercati. Questo modulo la porta dove gli ordini si
// piazzano davvero, senza riscriverla: `bestOtherBid` e `planBehindBest` sono le stesse funzioni.
//
// ═══ IL CONFLITTO CON LA BANDA, E CHI VINCE ════════════════════════════════════════════════════════
// Un tick dietro allontana dal mid. Su un mercato con banda stretta quel tick può portare l'ordine FUORI
// dalla banda premiante, dove matura zero. `planBehindBest` risolve già il conflitto e lo risolve nel
// verso giusto: aggancia il prezzo al bordo premiante e lo dichiara (`mode:'band-clamped'`,
// `onTop:true`). LA BANDA VINCE. Meglio primi e premiati che secondi e a zero.
//
// ═══ LA VENDITA, SENZA UNA SECONDA ARITMETICA ══════════════════════════════════════════════════════
// `planBehindBest` ragiona su un BID: «dietro» vuol dire più in basso. Per un ASK «dietro» vuol dire più
// in alto, e la tentazione sarebbe scrivere una seconda funzione col segno girato — cioè un secondo
// posto dove sbagliare.
//
// Non serve: un ASK a p è un BID a 1−p nello spazio specchiato. Si specchiano i livelli e il mid, si
// chiama la STESSA funzione, si specchia indietro il risultato. Una sola aritmetica, due lati.
//
// ═══ QUANDO NON SI APPLICA ═════════════════════════════════════════════════════════════════════════
// Alla chiusura FORZATA a mercato (uscita fuori banda o oltre le 24 ore). Quella deve eseguire, non
// quotare: attraversa lo spread di proposito e ha già la sua dichiarazione esplicita. Chi la piazza non
// passa da qui.

const { bestOtherBid, planBehindBest } = require('./top-of-book');

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const specchia = (p) => +(1 - p).toFixed(10);

/**
 * Il prezzo maker per un lato, un tick dietro al miglior prezzo ALTRUI.
 *
 * @param {object} args
 *   book        'yes'|'no' — su quale libro si posa l'ordine
 *   side        'BUY'|'SELL'
 *   rules       resolveMarketRules() shape: tick, maxSpreadCents, books.{yes,no}.scoringMid
 *   depth       resolveMarketDepth() shape: {yes:{bids,asks}, no:{bids,asks}}
 *   ownOrders   i NOSTRI ordini a riposo su questo book (per non inseguire noi stessi)
 *   offsetCents il ripiego quando su questo lato non c'è nessun altro
 * @returns {{ok, price, mode, onTop, offsetCents, reason, bestOther}}
 *          `ok:false` ⇒ il chiamante tiene il prezzo che aveva. Questo modulo non lo sostituisce mai
 *          con un valore di comodo: o sa rispondere, o si tira indietro dichiarandolo.
 */
function prezzoInCoda({ book, side, rules, depth = null, ownOrders = [], offsetCents = null } = {}) {
  const no = (reason) => ({ ok: false, price: null, mode: null, onTop: null, offsetCents: null, reason, bestOther: null });
  if (!rules || rules.readable !== true) return no('regole di venue non leggibili');
  const b = book === 'no' ? (rules.books && rules.books.no) : (rules.books && rules.books.yes);
  if (!b) return no(`nessun dato per il libro ${String(book).toUpperCase()}`);
  const tick = rules.tick;
  const bandRadiusCents = fin(rules.maxSpreadCents) ? rules.maxSpreadCents / 2 : null;
  const scoringMid = b.scoringMid;
  if (!fin(scoringMid) || !fin(tick) || tick <= 0) return no('mid di scoring o tick non leggibili');

  const vendita = String(side).toUpperCase() === 'SELL';
  // I livelli arrivano dal chiamante (resolveMarketDepth), non da `rules`: quel ritorno finisce nel JSON
  // del pannello e non deve portarsi dietro una scala di profondita' a ogni schermata. Questo modulo
  // resta puro — nessun file, nessuna rete.
  const lato = depth ? (book === 'no' ? depth.no : depth.yes) : null;
  const scala = lato && Array.isArray(vendita ? lato.asks : lato.bids)
    ? (vendita ? lato.asks : lato.bids)
    : null;
  if (!Array.isArray(scala)) return no(`il feed non pubblica i livelli ${vendita ? 'ask' : 'bid'} di questo libro`);

  // ── LO SPECCHIO, per riusare l'aritmetica del BID anche in vendita ─────────────────────────────
  const livelli = vendita
    ? scala.map((l) => ({ price: specchia(Number(l.price)), size: Number(l.size) })).filter((l) => fin(l.price) && fin(l.size))
    : scala;
  const nostri = vendita
    ? (ownOrders || []).map((o) => ({ ...o, price: fin(Number(o.price)) ? specchia(Number(o.price)) : null }))
    : ownOrders;
  const midUsato = vendita ? specchia(scoringMid) : scoringMid;

  const bo = bestOtherBid({ levels: livelli, ownOrders: nostri, tick });
  const piano = planBehindBest({
    bestOther: bo.readable ? bo.price : null,
    tick, scoringMid: midUsato, bandRadiusCents,
    fallbackOffsetCents: fin(offsetCents) && offsetCents > 0 ? offsetCents : null,
  });
  if (!piano.ok) return no(piano.reason);

  const prezzo = vendita ? specchia(piano.price) : piano.price;
  return {
    ok: true,
    price: +prezzo.toFixed(10),
    mode: piano.mode,
    onTop: piano.onTop,
    offsetCents: piano.offsetCents,
    bestOther: bo.readable ? (vendita ? specchia(bo.price) : bo.price) : null,
    alone: bo.alone === true,
    reason: vendita ? piano.reason.replace('miglior bid altrui', 'miglior ask altrui') : piano.reason,
  };
}

module.exports = { prezzoInCoda };
