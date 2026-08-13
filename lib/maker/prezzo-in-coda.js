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
// ═══ IL CONFLITTO CON LA BANDA, E CHI VINCE (deciso il 5 agosto 2026) ══════════════════════════════
// Un tick dietro allontana dal mid. Su un mercato con banda stretta quel tick può portare l'ordine FUORI
// dalla banda premiante, dove matura zero.
//
// VINCE «MAI PRIMI». Se un tick dietro esce dalla banda, quel lato NON SI QUOTA: `planBehindBest`
// restituisce `ok:false` con `mode:'behind-best-fuori-banda'` e `quotabile:false`, e il chiamante
// rifiuta l'ordine invece di piazzarlo al bordo.
//
// Fino a quella data valeva il contrario: si agganciava al bordo e si accettava di stare in cima
// («meglio primi e premiati che secondi e a zero»). Il ragionamento che l'ha ribaltata: il reward di un
// mercato è un numero noto e limitato, il costo di essere il primo a essere eseguito da chi sa qualcosa
// che noi non sappiamo non lo è. Meglio non impegnare capitale che impegnarlo nel posto peggiore.
//
// L'ECCEZIONE, che non è un'eccezione alla regola ma alla sua premessa: quando su quel lato non c'è
// NESSUN altro, «primi» non descrive niente — non esiste una coda in cui accodarsi. Lì il bordo resta
// ammesso (`mode:'band-clamped'`), altrimenti non si quoterebbe mai su un libro vuoto, che è proprio
// dove la liquidità serve di più.
//
// ═══ DUE `ok:false` CHE NON SONO LA STESSA COSA ════════════════════════════════════════════════════
//   quotabile === null    non si è potuto rispondere (feed muto, banda illeggibile, tick assente):
//                         il chiamante tiene il prezzo che aveva.
//   quotabile === false    si è risposto, e la risposta è «non quotare»: il chiamante RIFIUTA.
// Confonderle significherebbe o ignorare una decisione, o trasformare un guasto di lettura in un divieto.
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

const { othersLadder, planBehindBest } = require('./top-of-book');
const { raggioBandaCents } = require('../banda-premiante');

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
function prezzoInCoda({ book, side, rules, depth = null, ownOrders = [], offsetCents = null,
  depthMultiple = null, ownSize = null } = {}) {
  // `quotabile` viaggia insieme al rifiuto: null = non si è potuto rispondere, false = «non quotare».
  const no = (reason, extra = {}) => ({ ok: false, price: null, mode: null, onTop: null, offsetCents: null, reason, bestOther: null, quotabile: null, ...extra });
  if (!rules || rules.readable !== true) return no('regole di venue non leggibili');
  const b = book === 'no' ? (rules.books && rules.books.no) : (rules.books && rules.books.yes);
  if (!b) return no(`nessun dato per il libro ${String(book).toUpperCase()}`);
  const tick = rules.tick;
  const bandRadiusCents = fin(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null;
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

  // La scala ALTRUI si costruisce UNA volta e serve a due domande: chi è il migliore (la testa) e
  // quanto c'è davanti a un prezzo (la somma). Erano due chiamate e due sottrazioni dei nostri ordini;
  // adesso la sottrazione è una sola, quindi le due risposte non possono raccontare due book diversi.
  const L = othersLadder({ levels: livelli, ownOrders: nostri, tick });
  const bo = L.readable && !L.alone
    ? { readable: true, price: L.levels[0].price, alone: false }
    : { readable: L.readable, price: null, alone: L.alone === true };
  const piano = planBehindBest({
    bestOther: bo.readable ? bo.price : null,
    tick, scoringMid: midUsato, bandRadiusCents,
    fallbackOffsetCents: fin(offsetCents) && offsetCents > 0 ? offsetCents : null,
    // La scala è già in spazio BID (specchiata sopra per la vendita), quindi la profondità «davanti»
    // vale per i due lati con la stessa aritmetica — la stessa scelta che questo file fa da sempre.
    depthMultiple, ownSize, ladder: L.readable ? L.levels : null,
  });
  // Il rifiuto del piano si propaga COL SUO NOME: chi chiama deve poter distinguere «non quoto perché
  // sarei primo» da «non so rispondere», e sono due esiti diversi dello stesso `ok:false`.
  if (!piano.ok) {
    return no(piano.reason, {
      mode: piano.mode || null,
      quotabile: piano.quotabile === false ? false : null,
      onTop: piano.onTop === undefined ? null : piano.onTop,
      bestOther: bo.readable ? (vendita ? specchia(bo.price) : bo.price) : null,
    });
  }

  const prezzo = vendita ? specchia(piano.price) : piano.price;
  return {
    ok: true,
    quotabile: true,
    price: +prezzo.toFixed(10),
    mode: piano.mode,
    onTop: piano.onTop,
    offsetCents: piano.offsetCents,
    bestOther: bo.readable ? (vendita ? specchia(bo.price) : bo.price) : null,
    alone: bo.alone === true,
    // I numeri dell'arretramento per profondità, specchiati indietro come il prezzo. `null` quando la
    // protezione non era accesa o non si è applicata — non uno zero, che direbbe «misurata a zero».
    depth: piano.depth
      ? { ...piano.depth, minPrice: vendita ? specchia(piano.depth.minPrice) : piano.depth.minPrice }
      : null,
    reason: vendita ? piano.reason.replace('miglior bid altrui', 'miglior ask altrui') : piano.reason,
  };
}

module.exports = { prezzoInCoda };
