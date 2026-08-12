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
/**
 * IL BOOK MENO NOI — la scala dei soli livelli ALTRUI, dal migliore in giù.
 *
 * ═══ PERCHE' ESISTE COME FUNZIONE A SE' ═══════════════════════════════════════════════════════════
 * La sottrazione dei nostri ordini e' il cuore di «mai primi»: se sbagliasse, il motore inseguirebbe se
 * stesso. Da quando esiste anche la protezione di profondita' — che deve sommare le share DAVANTI a un
 * prezzo, e quindi ha bisogno di TUTTA la scala e non del solo primo livello — quella sottrazione
 * servirebbe in due posti. Scritta due volte sarebbe due posti dove sbagliarla, e le due risposte
 * potrebbero divergere: «il migliore altrui» e «quanto c'e' davanti» direbbero cose incoerenti sullo
 * stesso book. Quindi si sottrae QUI, una volta sola, e `bestOtherBid` legge la testa di questa scala.
 *
 * @returns {{readable, levels: Array<{price,size}>|null, alone, reason}}  ordinata per prezzo DECRESCENTE
 */
function othersLadder({ levels, ownOrders = [], tick } = {}) {
  // UNA LISTA VUOTA NON E' UNA LISTA ASSENTE, e qui la differenza decide il comportamento:
  //   `levels` non e' un array  ⇒ il feed non ha pubblicato nulla. Non si sa. Si torna all'offset fisso.
  //   `levels` e' [] (o resta [] tolti i nostri) ⇒ il feed HA parlato e dice che su questo lato non c'e'
  //     nessuno. E' il caso «siamo soli», che ha un ripiego suo e si scioglie da se'.
  // Trattarli allo stesso modo farebbe ripiegare su «soli» ogni volta che il feed singhiozza.
  // ── DUE ASSENZE DIVERSE, DUE FRASI DIVERSE ───────────────────────────────────────────────────
  // Fino al 6 agosto 2026 uscivano con la stessa frase: «il feed non pubblica i livelli di questo
  // book». Quella frase accusa il feed, e per un'intera diagnosi ha mandato a cercare un guasto dei
  // dati che non esisteva: il feed pubblicava, era il chiamante a non passare la scala (auto-reprice
  // leggeva `d.bookLevels`, proprieta' che `decideReprice` non ha mai restituito). Un messaggio che
  // punta il dito nella direzione sbagliata costa piu' di un messaggio generico.
  //   `undefined`/`null` ⇒ NESSUNO HA PASSATO NULLA. E' un errore di cablaggio interno.
  //   qualunque altro non-array ⇒ il feed ha risposto con qualcosa che non e' una scala.
  if (levels === null || levels === undefined) {
    return { readable: false, levels: null, alone: false,
      reason: 'il chiamante non ha passato la scala del book (errore di cablaggio interno, non un problema di feed)' };
  }
  if (!Array.isArray(levels)) {
    return { readable: false, levels: null, alone: false, reason: 'il feed non ha pubblicato i livelli di questo book' };
  }
  if (!fin(tick) || tick <= 0) {
    return { readable: false, levels: null, alone: false, reason: 'tick del venue non leggibile' };
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
    return { readable: true, levels: [], alone: true,
      reason: 'tolti i nostri ordini non resta nessun altro su questo lato del book' };
  }
  rimasti.sort((a, b) => b.price - a.price);
  return { readable: true, levels: rimasti, alone: false, reason: null };
}

/**
 * IL MIGLIOR BID ALTRUI su questo book — cioè la testa del book meno noi.
 *
 * @param {Array<{price:number|string,size:number|string}>} levels  i BID pubblicati dal feed
 * @param {Array<{price:number,size:number}>} ownOrders             i NOSTRI ordini a riposo su questo book
 * @returns {{readable:boolean, price:number|null, size:number|null, alone:boolean, levels:number, reason:string|null}}
 *   `alone:true` significa: il book esiste, e tolti i nostri ordini non resta nessuno. È diverso da
 *   `readable:false`, che significa: il book non si è letto. Il primo è un fatto, il secondo un'assenza.
 */
function bestOtherBid({ levels, ownOrders = [], tick } = {}) {
  const L = othersLadder({ levels, ownOrders, tick });
  if (!L.readable) return { readable: false, price: null, size: null, alone: false, levels: 0, reason: L.reason };
  if (L.alone) return { readable: true, price: null, size: null, alone: true, levels: 0, reason: L.reason };
  return { readable: true, price: L.levels[0].price, size: L.levels[0].size, alone: false, levels: L.levels.length, reason: null };
}

/**
 * QUANTE SHARE ALTRUI STANNO DAVANTI a un prezzo candidato, su una scala gia' depurata dai nostri.
 *
 * «Davanti» = STRETTAMENTE meglio. Un livello allo STESSO prezzo non e' davanti: e' accanto, e la
 * priorita' fra pari e' temporale, non di prezzo. Contarlo come protezione significherebbe credersi
 * coperti da share che verrebbero eseguite insieme alle nostre.
 *
 * La scala e' sempre in spazio BID (per la vendita il chiamante ha gia' specchiato), quindi «meglio»
 * e' «piu' alto» e una sola aritmetica serve i due lati.
 */
function depthAheadOf(ladder, price) {
  if (!Array.isArray(ladder) || !fin(price)) return null;
  let tot = 0;
  for (const l of ladder) {
    if (!l || !fin(l.price) || !fin(l.size)) continue;
    if (l.price > price + EPS) tot += l.size;
  }
  return +tot.toFixed(6);
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
 * ═══ LA PROTEZIONE DI PROFONDITÀ — ASSENTE PER DIFETTO ════════════════════════════════════════════
 * `depthMultiple` (N) chiede di arretrare finché davanti non c'è almeno N × la propria size in share
 * ALTRUI. Senza il parametro — o con N ≤ 0, o senza `ownSize`, o senza scala leggibile — questa
 * funzione si comporta ESATTAMENTE come prima: un tick dietro, punto. È la condizione di default in
 * produzione, e va accesa per mercato.
 *
 * Un quinto esito si aggiunge ai quattro:
 *   behind-best-depth        arretrato oltre il minimo per profondità, dentro banda.
 *
 * @param {number|null} bestOther   il miglior bid ALTRUI, o null se siamo soli
 * @param {number} fallbackOffsetCents  l'offset del tracking di questo mercato (già scelto dall'operatore)
 * @param {number|null} depthMultiple   N — quante volte la propria size deve esserci davanti. null/0 ⇒ spenta
 * @param {number|null} ownSize         la size che si sta per piazzare, in share
 * @param {Array|null} ladder           la scala ALTRUI (da `othersLadder`), in spazio BID
 */
function planBehindBest({ bestOther, tick, scoringMid, bandRadiusCents, fallbackOffsetCents,
  depthMultiple = null, ownSize = null, ladder = null } = {}) {
  // La protezione si accende solo se TUTTI gli ingredienti ci sono. Un N configurato senza size, o
  // senza una scala leggibile, non deve produrre un arretramento inventato: si torna al minimo, che è
  // il comportamento di sempre e non ha mai bisogno di dati in più per essere corretto.
  const depthOn = fin(depthMultiple) && depthMultiple > 0
    && fin(ownSize) && ownSize > 0
    && Array.isArray(ladder) && ladder.length > 0;
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
    // ══ SOLI SUL LATO: SI VA AL BORDO ESTERNO DELLA BANDA ═══════════════════════════════════════════
    // Decisione dell'operatore, 12 agosto 2026. Prima si ripiegava su un offset configurato dal mid
    // (`FALLBACK_OFFSET_CENTS`), agganciato al bordo solo se cadeva fuori. Adesso il bordo esterno NON
    // è un ripiego: è il bersaglio.
    //
    // ═══ IL MOTIVO, E NON È «EVITARE LA PRIMA POSIZIONE» ═══════════════════════════════════════════
    // Senza concorrenti si è in cima al libro PER FORZA: non c'è nessuno dietro cui accodarsi, e la
    // regola «mai primo» qui non descrive niente. L'obiettivo è un altro — stare al prezzo PEGGIORE
    // che resta premiante, così il fill è improbabile e il reward matura comunque. Il reward si paga
    // sugli ordini a riposo, quindi un ordine che non viene eseguito è un ordine che ha funzionato.
    //
    // ═══ QUAL È IL BORDO ESTERNO, E PERCHÉ È `b.lo` ════════════════════════════════════════════════
    // Questa funzione ragiona sempre nello spazio BID (per le vendite `prezzo-in-coda` specchia i
    // prezzi prima di chiamarla). Nello spazio bid il prezzo più lontano dal mid è il più BASSO, cioè
    // il bordo inferiore della banda: comprare più a buon mercato possibile restando premianti. Dopo
    // lo specchio, sulle vendite, lo stesso `b.lo` diventa il prezzo più ALTO — vendere più caro
    // possibile restando premianti. Una regola sola, due letture corrette.
    //
    // ═══ SE QUEL PREZZO NON È VALIDO NON SI QUOTA, coerente con «mai primo» ════════════════════════
    // `bordoAmmesso: false`: se il bordo cade fuori dai limiti del libro non si aggancia niente e non
    // si ripiega su un prezzo più vicino al mid. Una banda che non contiene prezzi validi è già
    // rifiutata sopra da `bandBounds` (che pretende `lo < hi` stretto).
    //
    // ═══ E LA PROTEZIONE DI PROFONDITÀ CONTINUA A NON APPLICARSI ═══════════════════════════════════
    // Non c'è nessuno davanti, quindi la profondità davanti è zero a QUALUNQUE prezzo e la soglia non
    // sarebbe mai raggiunta. Il bordo esterno è già il punto più arretrato possibile.
    void fallbackOffsetCents;   // non più usato qui: il bordo non dipende da un offset configurato
    return finalize(b.lo, 'fallback-alone-bordo-esterno',
      `siamo gli unici su questo lato: nessuno dietro cui accodarsi, quindi si va al BORDO ESTERNO della`
      + ` banda premiante (${p2c(b.lo)}¢ su [${p2c(b.lo)}¢–${p2c(b.hi)}¢], mid ${p2c(scoringMid)}¢) — il prezzo`
      + ` più lontano dal mid che matura ancora reward, così il fill è improbabile e il premio no.`
      + ' Appena ricompare un concorrente si torna a un tick dietro.',
      false);
  }

  // ── C'È UN CONCORRENTE ─────────────────────────────────────────────────────────────────────────
  // Il bordo NON è ammesso. O si sta dietro dentro banda, o non si quota.
  //
  // IL MINIMO viene valutato per primo, e da solo: se un tick dietro è già fuori banda, questo lato
  // non si quota — priorità (c), il comportamento di sempre. La profondità non entra nemmeno in
  // discussione, perché non esiste un prezzo ammesso da cui arretrare.
  const minRaw = bestOther - tick;
  const minPrice = snap(minRaw, tick);
  const minFuoriBanda = !fin(minPrice) || minPrice < b.lo - EPS || minPrice > b.hi + EPS;
  const perche = (p) => `un tick dietro il miglior bid altrui (${p2c(bestOther)}¢) ⇒ ${p2c(p)}¢`;
  if (minFuoriBanda || !depthOn) {
    return finalize(minRaw, 'behind-best', perche(minPrice), false);
  }

  // ── LA PROTEZIONE DI PROFONDITÀ ────────────────────────────────────────────────────────────────
  // Si arretra di tick finché davanti non c'è almeno `depthMultiple × ownSize` share ALTRUI, oppure
  // finché il tick successivo uscirebbe dalla banda premiante.
  //
  // PERCHÉ RELATIVA ALLA PROPRIA SIZE e non un numero di livelli o di share. Contare i livelli non
  // protegge: su tick 0,001 i livelli sono fittissimi e la terza posizione può avere davanti 20 share.
  // Un numero fisso di share non è trasportabile: sugli stessi mercati vivi il primo livello va da 20
  // share a 1192. Quello che protegge è quanto deve essere GROSSO un ordine aggressivo per arrivare
  // fino a noi, ed è per costruzione una quantità relativa alla nostra size.
  //
  // LA BANDA VINCE — priorità (b). Se soddisfare la soglia richiedesse di uscire, ci si ferma
  // all'ultimo tick ancora premiante e si accetta una profondità inferiore: non si esce MAI dalla
  // banda per questa regola. Il verdetto dice quale delle due condizioni ha fermato l'arretramento.
  //
  // «MAI PRIMI» RESTA INTATTO — priorità (a). Si parte da un tick dietro e ci si allontana soltanto:
  // ogni prezzo esplorato è ≤ il minimo, quindi non c'è nessun percorso per cui questa regola possa
  // riportare l'ordine in cima. È garantito dalla direzione della camminata, non da un controllo.
  const soglia = depthMultiple * ownSize;
  let prezzo = minPrice;
  let davanti = depthAheadOf(ladder, prezzo);
  let fermatoDa = davanti != null && davanti + EPS >= soglia ? 'soglia' : null;
  let passi = 0;
  // Il tetto di iterazioni è la larghezza della banda in tick: oltre non si può andare comunque, ed
  // evita che una scala malformata produca un ciclo.
  const maxPassi = Math.max(1, Math.ceil((b.hi - b.lo) / tick) + 1);
  while (fermatoDa == null && passi < maxPassi) {
    const next = snap(prezzo - tick, tick);
    if (!fin(next) || next < b.lo - EPS) { fermatoDa = 'bordo-banda'; break; }
    prezzo = next;
    passi++;
    davanti = depthAheadOf(ladder, prezzo);
    if (davanti != null && davanti + EPS >= soglia) fermatoDa = 'soglia';
  }
  if (fermatoDa == null) fermatoDa = 'bordo-banda';

  const arretrato = passi > 0;
  // TRE ESITI, non due, e confonderli è la differenza fra «sono protetto» e «non ho potuto proteggermi»:
  //   arretrato + soglia        ci si è spostati e la soglia è soddisfatta;
  //   arretrato + bordo-banda   ci si è spostati quanto la banda permetteva, protezione INFERIORE alla soglia;
  //   fermo + bordo-banda       non ci si è potuti spostare affatto — il minimo È già il bordo. Qui dire
  //                             «non serve arretrare» sarebbe falso: serve, e non si può.
  const soddisfatta = davanti != null && davanti + EPS >= soglia;
  const coda = `davanti ci sono ${davanti} share altrui contro una soglia di ${soglia} (${depthMultiple}× la size ${ownSize})`;
  const res = finalize(prezzo, arretrato ? 'behind-best-depth' : 'behind-best',
    arretrato
      ? `${perche(minPrice)}, poi arretrato di ${passi} tick fino a ${p2c(prezzo)}¢ per profondità: ${coda} — `
        + (fermatoDa === 'soglia'
          ? 'soglia raggiunta.'
          : `fermato dal bordo della banda premiante [${p2c(b.lo)}¢–${p2c(b.hi)}¢], che vince sulla profondità: si accetta una protezione inferiore invece di uscire.`)
      : (soddisfatta
        ? `${perche(minPrice)} — ${coda}: la soglia è già soddisfatta al minimo, non serve arretrare.`
        : `${perche(minPrice)} — ${coda}: la soglia NON è soddisfatta, ma il tick successivo uscirebbe dalla `
          + `banda premiante [${p2c(b.lo)}¢–${p2c(b.hi)}¢] e la banda vince: si resta al minimo con una protezione inferiore a quella chiesta.`),
    false);
  // I numeri della decisione viaggiano col verdetto, così il log non deve ricalcolarli né dedurli dal testo.
  return res.ok
    ? { ...res, depth: { applied: true, ticksBack: passi, minPrice, depthAhead: davanti, required: +soglia.toFixed(6), stoppedBy: fermatoDa, multiple: depthMultiple, ownSize } }
    : res;
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

module.exports = { FALLBACK_OFFSET_CENTS, snap, othersLadder, bestOtherBid, depthAheadOf, bandBounds, planBehindBest, followNeedsMove };
