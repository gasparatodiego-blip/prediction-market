'use strict';
// lib/maker/top-of-book.js — MAI IN CIMA AL BOOK: dove va un ordine, dato il book vero.
// Aritmetica pura, come mm-quote-math e book-erosion: nessun `fs`, nessuna rete, nessun venue.
//
// ═══ IL CAMBIO DI DOMANDA ════════════════════════════════════════════════════════════════════════════
// Prima il motore chiedeva: «dove sta il mid, e a quanti centesimi da lì mi metto?». L'offset era un
// numero scelto a mano e il book non entrava nella risposta. Adesso chiede: «qual è il miglior prezzo
// che qualcun ALTRO sta offrendo su questo lato, e come mi metto dietro di lui?».
//
// La distanza dal mid smette quindi di essere un parametro e diventa una CONSEGUENZA del book vero.
//
// ═══ PERCHÉ NON SI VUOLE STARE IN CIMA ═══════════════════════════════════════════════════════════════
// Il primo livello del book è il primo a essere eseguito. Per un market maker che vive di premi di
// liquidità, essere eseguiti non è il ricavo: è il COSTO — si finisce con inventario direzionale preso
// esattamente quando il prezzo stava per muoversi contro. Il premio invece si matura RESTANDO sul book
// dentro la banda, e per quello un tick più indietro vale quanto il tick in cima.
// Stare dietro al migliore altrui è quindi la stessa maturazione con meno adverse selection.
//
// ═══ I NOSTRI ORDINI NON SONO «IL MERCATO» ═══════════════════════════════════════════════════════════
// Lo snapshot del book contiene ANCHE i nostri ordini: sono ordini veri, il venue li pubblica come tutti
// gli altri. Se non li si togliesse, il motore inseguirebbe se stesso — vedrebbe il proprio ordine come
// «il migliore», si metterebbe un tick dietro, e al giro dopo rifarebbe la stessa cosa, scendendo di un
// tick a ogni ciclo fino al bordo della banda. Questo modulo li SOTTRAE livello per livello.
//
// ═══ QUANDO I DUE VINCOLI SI CONTRADDICONO ═══════════════════════════════════════════════════════════
// «Un tick dietro il migliore» e «dentro la banda premiante» possono chiedere due cose opposte: se tutti
// gli altri quotano molto lontano dal mid, un tick dietro di loro cade FUORI banda. La regola decisa è
// che vince la BANDA — ci si ferma al suo bordo — e la conseguenza va detta invece che nascosta: in quel
// caso si è davvero in cima al book. È la scelta giusta comunque, perché fuori banda si matura ZERO, e
// non essere in cima a un premio che non esiste non vale niente. Il verdetto porta `onTop:true` proprio
// perché quel caso sia visibile e non vada scambiato per un guasto.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const EPS = 1e-9;
const r6 = (x) => +x.toFixed(6);
const p2c = (p) => +(p * 100).toFixed(4);

/** L'offset di ripiego quando la configurazione non ne porta uno. Non è un parametro di strategia: è il
 *  valore che evita di non avere risposta. Il caso normale è che il tracking di quel mercato abbia già
 *  il suo offset configurato, e quello viene usato — così questo comportamento non introduce nessun
 *  numero nuovo che qualcuno debba scegliere. */
const FALLBACK_OFFSET_CENTS = 1;

function snap(price, tick) {
  if (!fin(price) || !fin(tick) || tick <= 0) return null;
  return +(Math.round(price / tick) * tick).toFixed(10);
}

/**
 * IL MIGLIOR BID ALTRUI su questo book — cioè il book meno noi.
 *
 * @param {Array<{price:number|string,size:number|string}>} levels  i BID pubblicati dal feed
 * @param {Array<{price:number,size:number}>} ownOrders             i NOSTRI ordini a riposo su questo book
 * @returns {{readable:boolean, price:number|null, size:number|null, alone:boolean, levels:number, reason:string|null}}
 *   `alone:true` significa: il book esiste, e tolti i nostri ordini non resta nessuno. È diverso da
 *   `readable:false`, che significa: il book non si è letto. Il primo è un fatto, il secondo un'assenza.
 */
function bestOtherBid({ levels, ownOrders = [], tick } = {}) {
  // UNA LISTA VUOTA NON E' UNA LISTA ASSENTE, e qui la differenza decide il comportamento:
  //   `levels` non e' un array  ⇒ il feed non ha pubblicato nulla. Non si sa. Si torna all'offset fisso.
  //   `levels` e' [] (o resta [] tolti i nostri) ⇒ il feed HA parlato e dice che su questo lato non c'e'
  //     nessuno. E' il caso «siamo soli», che ha un ripiego suo e si scioglie da se'.
  // Trattarli allo stesso modo farebbe ripiegare su «soli» ogni volta che il feed singhiozza.
  if (!Array.isArray(levels)) {
    return { readable: false, price: null, size: null, alone: false, levels: 0, reason: 'il feed non pubblica i livelli di questo book' };
  }
  if (!fin(tick) || tick <= 0) {
    return { readable: false, price: null, size: null, alone: false, levels: 0, reason: 'tick del venue non leggibile' };
  }
  // I nostri, sommati per prezzo: due ordini nostri sullo stesso livello vanno tolti entrambi.
  const mine = new Map();
  for (const o of ownOrders || []) {
    if (!o || !fin(o.price)) continue;
    const sz = fin(o.sizeRemaining) ? o.sizeRemaining : (fin(o.size) ? o.size : null);
    if (!fin(sz) || sz <= 0) continue;
    const k = snap(o.price, tick);
    mine.set(k, (mine.get(k) || 0) + sz);
  }
  const rimasti = [];
  for (const l of levels) {
    if (!l) continue;
    const price = typeof l.price === 'string' ? parseFloat(l.price) : l.price;
    const size = typeof l.size === 'string' ? parseFloat(l.size) : l.size;
    if (!fin(price) || !fin(size) || size <= 0) continue;
    const k = snap(price, tick);
    const nostra = mine.get(k) || 0;
    // Sotto la tolleranza il livello è INTERAMENTE nostro e sparisce. Non si lascia un residuo di
    // arrotondamento a fare da «altro partecipante»: sarebbe noi stessi, con un'altra faccia.
    const altrui = size - nostra;
    if (altrui > 1e-6) rimasti.push({ price: r6(k), size: +altrui.toFixed(6) });
  }
  if (!rimasti.length) {
    return { readable: true, price: null, size: null, alone: true, levels: 0,
      reason: 'tolti i nostri ordini non resta nessun altro su questo lato del book' };
  }
  rimasti.sort((a, b) => b.price - a.price);
  return { readable: true, price: rimasti[0].price, size: rimasti[0].size, alone: false, levels: rimasti.length, reason: null };
}

/**
 * I BORDI DELLA BANDA, agganciati al tick VERSO L'INTERNO.
 *
 * Verso l'interno e non al più vicino: un bordo arrotondato verso l'esterno sarebbe di un tick FUORI
 * dalla banda, cioè un prezzo che matura zero prodotto da una funzione il cui compito è tenerci dentro.
 */
function bandBounds({ scoringMid, bandRadiusCents, tick }) {
  if (!fin(scoringMid) || !fin(bandRadiusCents) || bandRadiusCents <= 0 || !fin(tick) || tick <= 0) {
    return { readable: false, lo: null, hi: null };
  }
  const r = bandRadiusCents / 100;
  const lo = +(Math.ceil((scoringMid - r) / tick - 1e-9) * tick).toFixed(10);
  const hi = +(Math.floor((scoringMid + r) / tick + 1e-9) * tick).toFixed(10);
  // STRETTAMENTE minore. Se dopo l'aggancio i due bordi coincidono, la banda e' piu' stretta di un tick
  // e l'unico prezzo «dentro» e' il mid stesso — che per un ordine in acquisto non e' una quotazione, e'
  // un attraversamento. Meglio dichiarare che non si puo' rispondere che restituire quell'unico prezzo.
  if (!(lo < hi - EPS)) return { readable: false, lo: null, hi: null };
  return { readable: true, lo, hi };
}

/**
 * DOVE VA L'ORDINE su questo lato.
 *
 * ═══ LA PRIORITÀ, DECISA IL 5 AGOSTO 2026 ═════════════════════════════════════════════════════════
 * «MAI PRIMI SUL LIBRO» VINCE SULLA BANDA PREMIANTE. Se un tick dietro il miglior concorrente cade
 * fuori dalla banda, quel lato NON si quota: si rinuncia al mercato invece di prendere la posizione
 * peggiore del libro.
 *
 * Fino a questa data valeva il contrario — si agganciava al bordo premiante e si accettava di stare in
 * cima («meglio primi e premiati che secondi e a zero»). Il ragionamento che l'ha ribaltata: essere
 * primi significa essere i primi a essere eseguiti, e per un'operazione che vive di reward e non di
 * spread l'esecuzione è il costo, non il ricavo. Il reward di un mercato è un numero noto e limitato;
 * il costo di essere il bersaglio di chi sa qualcosa che noi non sappiamo non lo è. Meglio non
 * impegnare capitale che impegnarlo nel posto peggiore.
 *
 * ═══ E VALE SOLO DOVE C'È QUALCUNO DAVANTI ════════════════════════════════════════════════════════
 * La regola parla di «primi rispetto a un concorrente». Quando su quel lato non c'è nessun altro,
 * «primi» non descrive niente: non esiste una coda in cui accodarsi, e rinunciare vorrebbe dire non
 * quotare mai su un libro vuoto — cioè proprio dove la liquidità serve di più e l'adverse selection
 * non ha una controparte informata da cui arrivare. Quindi il ramo `fallback-alone` continua ad
 * agganciarsi al bordo esattamente come prima.
 *
 * Quattro esiti, ciascuno col suo nome:
 *   behind-best              un tick dietro il migliore altrui, dentro banda. È il caso normale.
 *   behind-best-fuori-banda  un tick dietro uscirebbe dalla banda ⇒ NON si quota. `ok:false`.
 *   band-clamped             SOLO da soli: ci si ferma al bordo premiante.
 *   fallback-alone           soli sul lato, offset configurato, dentro banda.
 *
 * @param {number|null} bestOther   il miglior bid ALTRUI, o null se siamo soli
 * @param {number} fallbackOffsetCents  l'offset del tracking di questo mercato (già scelto dall'operatore)
 */
function planBehindBest({ bestOther, tick, scoringMid, bandRadiusCents, fallbackOffsetCents } = {}) {
  // `quotabile` distingue due `ok:false` che il chiamante DEVE trattare diversamente:
  //   null   non si è potuto rispondere (feed muto, banda illeggibile) → il chiamante tiene il suo prezzo
  //   false  si è risposto, e la risposta è «non quotare» → il chiamante rifiuta l'ordine
  // Senza questa distinzione un guasto di lettura verrebbe scambiato per una decisione, o peggio il
  // contrario: una decisione di non quotare verrebbe ignorata come se fosse un dato mancante.
  const out = (extra) => ({ ok: false, price: null, priceCents: null, mode: null, onTop: null, offsetCents: null, reason: null, quotabile: null, ...extra });
  if (!fin(tick) || tick <= 0) return out({ reason: 'tick del venue non leggibile' });
  if (!fin(scoringMid) || scoringMid <= 0 || scoringMid >= 1) return out({ reason: 'mid di scoring non leggibile o fuori da (0,1)' });
  const b = bandBounds({ scoringMid, bandRadiusCents, tick });
  if (!b.readable) {
    // Senza banda non si può garantire il vincolo che questo comportamento deve rispettare. Non si
    // ripiega su «mettiti dove capita»: si dichiara che non si può rispondere.
    return out({ reason: `banda non leggibile o più stretta di un tick (raggio ${bandRadiusCents}¢, tick ${p2c(tick)}¢): il vincolo «dentro banda» non sarebbe garantibile` });
  }

  /**
   * @param {boolean} bordoAmmesso  se il prezzo può essere agganciato al bordo premiante quando cade
   *                                fuori banda. Vero SOLO quando non c'è nessun concorrente: lì
   *                                l'aggancio non ci mette «davanti» a nessuno.
   */
  const finalize = (raw, mode, why, bordoAmmesso) => {
    const price0 = snap(raw, tick);
    if (!fin(price0)) return out({ reason: 'prezzo non calcolabile' });
    const fuori = price0 < b.lo - EPS || price0 > b.hi + EPS;

    // ── IL RIFIUTO, quando c'è qualcuno davanti ────────────────────────────────────────────────
    // Non si aggancia al bordo: agganciare vorrebbe dire risalire fino al livello del concorrente o
    // oltre, cioè esattamente la posizione che questa regola esiste per evitare.
    if (fuori && !bordoAmmesso) {
      return out({
        mode: 'behind-best-fuori-banda', onTop: false, quotabile: false,
        bandLo: b.lo, bandHi: b.hi,
        reason: `un tick dietro il miglior bid altrui (${p2c(bestOther)}¢) darebbe ${p2c(price0)}¢, fuori dalla banda premiante `
          + `[${p2c(b.lo)}¢–${p2c(b.hi)}¢]. Restare in banda vorrebbe dire risalire in CIMA al libro, e questo lato non si quota: `
          + 'meglio non impegnare capitale che impegnarlo nella posizione peggiore del libro.',
      });
    }

    let price = price0;
    let clamped = false;
    if (price < b.lo - EPS) { price = b.lo; clamped = true; }
    if (price > b.hi + EPS) { price = b.hi; clamped = true; }
    if (!(price > 0 && price < 1)) {
      return out({ reason: `il prezzo calcolato (${p2c(price)}¢) cade fuori dai limiti del libro` });
    }
    const onTop = fin(bestOther) ? price >= bestOther - EPS : null;
    const offsetCents = +Math.abs(p2c(scoringMid) - p2c(price)).toFixed(3);
    return {
      ok: true, price, priceCents: p2c(price), quotabile: true,
      mode: clamped ? 'band-clamped' : mode,
      onTop, offsetCents, bandLo: b.lo, bandHi: b.hi,
      reason: clamped
        // Qui `clamped` può valere solo nel ramo «soli sul lato»: il ramo con un concorrente ha già
        // rifiutato sopra. Quindi «in cima» non ha nessuno davanti a cui stare.
        ? `su questo lato non c'è nessun altro e l'offset configurato cadrebbe fuori banda: ci si ferma al bordo premiante ${p2c(price)}¢ (${offsetCents}¢ dal mid)`
        : why,
    };
  };

  if (!fin(bestOther)) {
    const off = fin(fallbackOffsetCents) && fallbackOffsetCents > 0 ? fallbackOffsetCents : FALLBACK_OFFSET_CENTS;
    // SOLI SUL LATO: il bordo è ammesso. Non c'è nessuno davanti, quindi «primi» non descrive niente.
    return finalize(scoringMid - off / 100, 'fallback-alone',
      `siamo gli unici su questo lato: si ripiega sull offset di ${off}¢ dal mid finché non ricompare un altro partecipante`,
      true);
  }
  // C'È UN CONCORRENTE: il bordo NON è ammesso. O si sta dietro dentro banda, o non si quota.
  return finalize(bestOther - tick, 'behind-best',
    `un tick dietro il miglior bid altrui (${p2c(bestOther)}¢) ⇒ ${p2c(snap(bestOther - tick, tick))}¢`,
    false);
}

/**
 * SI SPOSTA L'ORDINE?
 *
 * Il bersaglio adesso si muove con il book, quindi «diverso dal bersaglio» non può bastare: il miglior
 * bid altrui cambia di continuo e si riprezzerebbe a ogni ciclo. La soglia è `minMoveCents`, cioè
 * ESATTAMENTE la soglia di riprezzo che il tracking di quel mercato ha già configurata — nessun
 * parametro nuovo da scegliere, e lo stesso numero continua a voler dire la stessa cosa: «di quanto
 * deve cambiare la situazione perché valga la pena rifare l'ordine».
 */
function followNeedsMove({ restingPrice, targetPrice, minMoveCents, tick } = {}) {
  if (!fin(targetPrice)) return { move: false, deltaCents: null, reason: 'nessun bersaglio calcolabile' };
  if (!fin(restingPrice)) return { move: true, deltaCents: null, reason: 'nessun ordine a riposo su questo lato: lo piazzo' };
  const deltaCents = +Math.abs(p2c(targetPrice) - p2c(restingPrice)).toFixed(4);
  const soglia = fin(minMoveCents) && minMoveCents > 0 ? minMoveCents : (fin(tick) ? p2c(tick) : 0.1);
  if (deltaCents + 1e-9 < soglia) {
    return { move: false, deltaCents, reason: `il bersaglio dettato dal book dista ${deltaCents}¢ dall ordine a riposo, sotto la soglia di ${soglia}¢ — non si tocca` };
  }
  return { move: true, deltaCents, reason: `il book si è spostato: il bersaglio dista ${deltaCents}¢ dall ordine a riposo, oltre la soglia di ${soglia}¢` };
}

module.exports = { FALLBACK_OFFSET_CENTS, snap, bestOtherBid, bandBounds, planBehindBest, followNeedsMove };
