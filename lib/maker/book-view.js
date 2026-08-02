'use strict';
// lib/maker/book-view.js — UNA sola descrizione del book, e UN solo mid da mostrare accanto ad essa.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Il pannello mostrava MID 20.0¢ accanto a BID 21.0¢ e ASK 22.0¢: un mid PIÙ BASSO di entrambi. Non era
// un errore di arrotondamento e non era un caso limite del venue — erano DUE NUMERI DIVERSI messi uno
// accanto all'altro come se fossero lo stesso fatto:
//
//   · `bestBid`/`bestAsk` sono il TOCCO GREZZO del book: il primo livello che esiste, qualunque size abbia.
//   · `mid` era `adjustedMid` (lib/rewardScore.js), cioè il midpoint del book FILTRATO DALLA POLVERE:
//     i livelli sotto `min_incentive_size` vengono scartati perché il programma premi non li vede.
//
// Su un book spesso i due coincidono e nessuno se ne accorge. Su un book sottile — i cicli da 15 minuti
// su cripto sono esattamente quel caso — il primo livello è spesso una briciola da 10 share: il filtro lo
// butta, `adjustedMid` si ancora al primo livello VERO molto più in là, e il mid finisce fuori dal tocco.
//
// Osservato in produzione il 2026-08-02 su «Bitcoin Up or Down - August 1, 7:30PM-7:45PM ET»
// (min_incentive_size = 50):
//     bids grezzi : 0.85 × 10.18 share   ← briciola, sotto la soglia premiante
//                   0.77 × 999 share     ← il primo livello che il programma premi conta davvero
//     bestBid = 0.85   ·   adjustedMid = 0.77
//     → il pannello avrebbe scritto MID 77.0¢ accanto a BID 85.0¢.
//
// C'è di peggio: quando UN SOLO lato sopravvive al filtro, `adjustedMid` restituisce il prezzo di quel
// lato (`if (bestBid) return bestBid.price`). Quel numero non è un midpoint di niente, ma veniva
// etichettato «mid» come tutti gli altri.
//
// ═══ LA REGOLA CHE QUESTO MODULO IMPONE ══════════════════════════════════════════════════════════════
// IL MID MOSTRATO È IL MIDPOINT DEL BOOK CHE GLI STA ACCANTO. Stessa fonte, stesso istante, stessi due
// numeri: `(bestBid + bestAsk) / 2` del tocco che il pannello sta disegnando. Per costruzione non può
// cadere fuori da bid/ask — non perché lo verifichiamo dopo, ma perché è fatto di quei due numeri.
//
// IL MID DI SCORING NON VIENE TOCCATO. `adjustedMid` resta esattamente quello che era: è il numero contro
// cui il venue giudica la banda premiante, ed è quello che `validateQuote`, l'auto-reprice e il motore
// continuano a usare. Cambiarlo sposterebbe dove vengono piazzati ordini veri. Qui viene solo TRASPORTATO
// accanto al mid di visualizzazione e, quando i due divergono, la differenza viene DETTA — che è la cosa
// che mancava. Tre numeri incoerenti senza spiegazione diventano tre numeri coerenti più una nota.
//
// ═══ VINCOLO DI DEPLOY ═══════════════════════════════════════════════════════════════════════════════
// Questo modulo consuma SOLO campi che agent34 scrive già (`levels`, `bestBid`, `bestAsk`, `adjustedMid`,
// `plainMid`, `minSize`, `ageMs`, `live`). Non aggiunge nessun campo al suo output, quindi la correzione
// vive con un restart del solo dashboard: nessun agente va fermato per vederla.

const EPS = 1e-9;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const r6 = (x) => (fin(x) ? +x.toFixed(6) : null);
/** Centesimi, con un decimale — l'unità in cui il pannello parla. */
const toC = (p) => (fin(p) ? +(p * 100).toFixed(4) : null);

// ── IL LADDER ────────────────────────────────────────────────────────────────────────────────────────
/**
 * Livelli grezzi → scala ordinata dal tocco verso l'esterno, con il cumulato.
 *
 * ORDINAMENTO, E PERCHÉ NON CI SI FIDA DELL'INGRESSO. La REST del CLOB (`GET /book`) restituisce i bid in
 * ordine CRESCENTE e gli ask in ordine DECRESCENTE: in entrambi i casi il tocco è l'ULTIMO elemento, non
 * il primo. agent34 invece li consegna già ordinati dal tocco. Prendere `[0]` senza ordinare darebbe il
 * livello più LONTANO dal mid su un percorso e quello più vicino sull'altro — cioè un book capovolto solo
 * per certi mercati. Qui si riordina sempre, e la fonte non deve promettere niente.
 *
 * @param {Array<{price:number|string,size:number|string}>} raw
 * @param {'bids'|'asks'} side
 * @param {{limit?:number}} [opts]
 * @returns {{rows:Array<{price:number,size:number,total:number}>, count:number, shown:number,
 *            truncated:boolean, maxSize:number|null, totalSize:number}}
 */
function buildLadder(raw, side, { limit = 5 } = {}) {
  const arr = Array.isArray(raw) ? raw : [];
  const parsed = [];
  for (const o of arr) {
    if (!o) continue;
    const price = typeof o.price === 'string' ? parseFloat(o.price) : o.price;
    const size = typeof o.size === 'string' ? parseFloat(o.size) : o.size;
    // size 0 = livello cancellato, non un livello con zero contratti. Non compare.
    if (!fin(price) || !fin(size) || size <= 0) continue;
    parsed.push({ price, size });
  }
  // Dal tocco verso l'esterno: i bid scendono, gli ask salgono.
  parsed.sort((a, b) => (side === 'bids' ? b.price - a.price : a.price - b.price));

  const shownRows = parsed.slice(0, Math.max(0, limit));
  let cum = 0;
  const rows = shownRows.map((o) => {
    cum += o.size;
    return { price: r6(o.price), size: +o.size.toFixed(6), total: +cum.toFixed(6) };
  });
  return {
    rows,
    // Quanti livelli ESISTONO davvero, contro quanti se ne mostrano. Il pannello scrive entrambi: una
    // scala di 3 righe su un book che ne ha 3 è un book sottile, su un book che ne ha 40 è una vista
    // troncata, e le due cose non vanno confuse.
    count: parsed.length,
    shown: rows.length,
    truncated: parsed.length > rows.length,
    maxSize: rows.length ? Math.max(...rows.map((r) => r.size)) : null,
    totalSize: +parsed.reduce((s, o) => s + o.size, 0).toFixed(6),
  };
}

// ── IL MID DA MOSTRARE ───────────────────────────────────────────────────────────────────────────────
/**
 * Il midpoint del tocco che gli sta accanto. Nessun ripiego su un'altra fonte, nessun last-trade
 * mascherato da mid: se manca un lato, si dice che manca.
 *
 * @returns {{mid:number|null, kind:'midpoint'|'one-sided-bid'|'one-sided-ask'|'unavailable'}}
 */
function displayMid(bestBid, bestAsk) {
  if (fin(bestBid) && fin(bestAsk)) return { mid: r6((bestBid + bestAsk) / 2), kind: 'midpoint' };
  // UN LATO SOLO NON È UN MIDPOINT, e non viene chiamato così. Il numero è utile (è l'unico prezzo
  // vero che il book esprime) ma porta un'etichetta diversa, e il pannello la mostra.
  if (fin(bestBid)) return { mid: r6(bestBid), kind: 'one-sided-bid' };
  if (fin(bestAsk)) return { mid: r6(bestAsk), kind: 'one-sided-ask' };
  return { mid: null, kind: 'unavailable' };
}

/**
 * Il confronto fra il mid MOSTRATO e il mid di SCORING, e la nota che lo spiega in italiano.
 *
 * `outsideTouch` è la diagnosi esatta del difetto segnalato: il mid di scoring non sta fra bid e ask.
 * Non è un bug del venue — è il filtro anti-polvere che fa il suo lavoro su un book sottile — ma
 * mostrarlo senza dirlo è quello che ha prodotto «MID 20 · BID 21 · ASK 22».
 */
function midCoherence({ mid, midKind, scoringMid, bestBid, bestAsk, minSize, spreadCents }) {
  const outsideTouch = fin(scoringMid)
    && ((fin(bestBid) && scoringMid < bestBid - EPS) || (fin(bestAsk) && scoringMid > bestAsk + EPS));
  const diffC = fin(mid) && fin(scoringMid) ? Math.abs(mid - scoringMid) * 100 : null;
  // ── QUANDO LA DIFFERENZA MERITA UNA NOTA ─────────────────────────────────────────────────────────
  // Il mid mostrato e quello di scoring divergono di qualche millesimo su quasi ogni mercato: il filtro
  // anti-polvere sposta il midpoint di mezzo tick e non cambia nessuna decisione. Avvisare ogni volta
  // riempirebbe il pannello di note vere e inutili — e una nota che compare sempre non viene piu' letta,
  // proprio quando arriva quella che conta. La soglia e' un QUARTO DI CENTESIMO: sotto, la differenza non
  // sposta il bordo di una banda che ha raggio ~2¢; sopra, si', e allora si dice.
  // Il caso `outsideTouch` avvisa SEMPRE, a qualunque distanza: un mid di scoring fuori da bid/ask e' la
  // condizione che ha prodotto la segnalazione, e non e' mai ordinaria amministrazione.
  const MATERIAL_C = 0.25;
  const differs = outsideTouch || (diffC !== null && diffC >= MATERIAL_C);

  const notes = [];
  if (midKind === 'one-sided-bid') {
    notes.push('Solo il lato BID esiste su questo book: il numero mostrato è il miglior bid, non un midpoint.');
  } else if (midKind === 'one-sided-ask') {
    notes.push('Solo il lato ASK esiste su questo book: il numero mostrato è il miglior ask, non un midpoint.');
  }
  if (differs) {
    const why = outsideTouch
      ? `cade FUORI da bid/ask perché i primi livelli del book sono sotto min_incentive_size${fin(minSize) ? ` (${minSize} share)` : ''} e il programma premi non li conta`
      : `è il midpoint del book al netto dei livelli sotto min_incentive_size${fin(minSize) ? ` (${minSize} share)` : ''}`;
    notes.push(
      `La banda premiante NON è misurata su questo mid: il venue la giudica contro il mid di scoring `
      + `${fin(scoringMid) ? `${(scoringMid * 100).toFixed(1)}¢` : 'N/D'}, che ${why}.`,
    );
  }
  // La regola Polymarket che l'utente ha citato: con spread largo l'interfaccia del venue mostra
  // l'ultimo prezzo scambiato al posto del midpoint. Qui il midpoint si mostra sempre — ma si avvisa
  // che il numero visto SUL SITO DEL VENUE può essere un altro, così i due non sembrano in disaccordo.
  if (fin(spreadCents) && spreadCents > 10) {
    notes.push(
      `Spread ampio (${spreadCents.toFixed(1)}¢ > 10¢): qui il mid è sempre il midpoint del book, `
      + `mentre l'interfaccia di Polymarket in questa condizione mostra l'ultimo prezzo scambiato. `
      + 'I due numeri possono non coincidere, e nessuno dei due è sbagliato.',
    );
  }
  return { differs, outsideTouch, diffCents: diffC === null ? null : +diffC.toFixed(3), notes };
}

/**
 * LA VISTA COMPLETA DI UN BOOK, coerente per costruzione: mid, tocco e scala escono tutti dagli STESSI
 * livelli, letti nello STESSO istante. È l'unica funzione che il resto del codice deve chiamare.
 *
 * @param {{levels?:{bids?:Array,asks?:Array}, bestBid?:number|null, bestAsk?:number|null,
 *          scoringMid?:number|null, minSize?:number|null, live?:boolean, ageMs?:number|null,
 *          source?:string|null, lastTradePrice?:number|null, levelCap?:number|null}} input
 * @param {{levels?:number}} [opts]
 */
function bookView(input, { levels = 5 } = {}) {
  const src = input || {};
  const bids = buildLadder(src.levels && src.levels.bids, 'bids', { limit: levels });
  const asks = buildLadder(src.levels && src.levels.asks, 'asks', { limit: levels });

  // IL TOCCO VIENE DALLA SCALA, non dal campo `bestBid` della fonte. Sono lo stesso book, ma il campo
  // separato può essere stato scritto da un evento diverso (il protocollo CLOB manda `best_bid` dentro
  // i `price_change`), e «lo stesso istante» smette di essere vero proprio nel punto in cui conta. La
  // scala è ciò che disegniamo: il mid deve venire da lì. Se la scala è vuota si accetta il campo della
  // fonte, dichiarando che il ladder non c'era.
  const ladderBid = bids.rows.length ? bids.rows[0].price : null;
  const ladderAsk = asks.rows.length ? asks.rows[0].price : null;
  const bestBid = fin(ladderBid) ? ladderBid : (fin(src.bestBid) ? r6(src.bestBid) : null);
  const bestAsk = fin(ladderAsk) ? ladderAsk : (fin(src.bestAsk) ? r6(src.bestAsk) : null);

  const { mid, kind } = displayMid(bestBid, bestAsk);
  const spreadCents = fin(bestBid) && fin(bestAsk) ? +((bestAsk - bestBid) * 100).toFixed(3) : null;
  const scoringMid = fin(src.scoringMid) ? r6(src.scoringMid) : null;
  const coh = midCoherence({
    mid, midKind: kind, scoringMid, bestBid, bestAsk,
    minSize: fin(src.minSize) ? src.minSize : null, spreadCents,
  });

  return {
    bestBid, bestAsk, spreadCents,
    /** Il mid MOSTRATO. Midpoint del tocco qui sopra — mai di un'altra fonte, mai di un altro istante. */
    mid,
    midKind: kind,
    /** Il mid contro cui il VENUE giudica la banda premiante. Invariato: lo usa il piazzamento. */
    scoringMid,
    midDiffersFromScoring: coh.differs,
    scoringMidOutsideTouch: coh.outsideTouch,
    midNotes: coh.notes,
    lastTradePrice: fin(src.lastTradePrice) ? r6(src.lastTradePrice) : null,
    levels: {
      bids: bids.rows, asks: asks.rows,
      bidCount: bids.count, askCount: asks.count,
      bidShown: bids.shown, askShown: asks.shown,
      truncated: bids.truncated || asks.truncated,
      // La barra di profondità si misura sul livello più grosso VISIBILE: normalizzare su un livello
      // fuori scala schiaccerebbe a zero tutte le righe che si stanno guardando.
      maxSize: Math.max(bids.maxSize || 0, asks.maxSize || 0) || null,
      requested: levels,
      /** Il tetto della FONTE. agent34 pubblica al massimo 12 livelli per lato: oltre quello il book
       *  esiste ma non è in questo file, e chiedere 20 righe non le farebbe comparire. */
      sourceCap: fin(src.levelCap) ? src.levelCap : null,
    },
    live: src.live === true,
    ageMs: fin(src.ageMs) ? src.ageMs : null,
    source: src.source ?? null,
  };
}

// ── L'INCROCIO DEL BOOK ──────────────────────────────────────────────────────────────────────────────
/**
 * Un ordine di ACQUISTO incrocia il book quando il suo prezzo raggiunge il miglior ask: verrebbe eseguito
 * subito contro chi vende, quindi sarebbe TAKER e non resterebbe a riposo. Il venue lo rifiuta apertamente
 * quando l'ordine è post-only — è l'errore reale «invalid post-only order: order crosses book».
 *
 * SUL LATO NO NON SI SPECCHIA NIENTE. «BUY NO a q» si giudica contro il miglior ask DEL BOOK NO, che su
 * Polymarket è un book CLOB indipendente con la sua scala. Ricavarlo da `1 − bestBid(YES)` sarebbe
 * un'identità solo su un book perfetto e a spread zero; qui si usa il book vero del lato scelto, e la
 * simmetria viene da sola perché è la stessa funzione applicata ai suoi dati.
 *
 * @param {{price:number, bestAsk:number|null, bestBid:number|null, side?:'BUY'|'SELL'}} q
 */
function crossesBook({ price, bestAsk, bestBid, side = 'BUY' }) {
  if (!fin(price)) return { crosses: false, readable: false, reason: 'prezzo non leggibile' };
  if (side === 'SELL') {
    if (!fin(bestBid)) return { crosses: false, readable: false, reason: 'nessun bid sul book' };
    return {
      crosses: price <= bestBid + EPS, readable: true, edge: bestBid,
      reason: price <= bestBid + EPS
        ? `a ${toC(price)}¢ incroci il bid (${toC(bestBid)}¢)`
        : `a ${toC(price)}¢ resti sopra il bid (${toC(bestBid)}¢)`,
    };
  }
  if (!fin(bestAsk)) return { crosses: false, readable: false, reason: 'nessun ask sul book' };
  return {
    crosses: price >= bestAsk - EPS, readable: true, edge: bestAsk,
    reason: price >= bestAsk - EPS
      ? `a ${toC(price)}¢ incroci l'ask (${toC(bestAsk)}¢)`
      : `a ${toC(price)}¢ resti sotto l'ask (${toC(bestAsk)}¢)`,
  };
}

/**
 * IL VERDETTO SUL PREZZO, in una forma sola per tutti e due i lati. Rosso quando l'ordine non farebbe
 * quello che l'operatore crede (incrocia, quindi esegue subito) o non maturerebbe premi (fuori banda);
 * verde quando resta sul book come maker e dentro la banda.
 *
 * La banda si misura contro `scoringMid` — il mid del VENUE — non contro il mid mostrato: è quello il
 * numero che decide i premi, ed è esattamente la distinzione che questo lavoro rende visibile.
 *
 * @returns {{level:'ok'|'bad'|'unknown', crosses:boolean, outOfBand:boolean|null, messages:string[]}}
 */
function priceVerdict({ price, bestBid, bestAsk, scoringMid, bandRadiusCents, side = 'BUY' }) {
  const messages = [];
  if (!fin(price) || price <= 0 || price >= 1) {
    return { level: 'unknown', crosses: false, outOfBand: null, messages: ['Il prezzo deve stare fra 0 e 1.'] };
  }
  const x = crossesBook({ price, bestAsk, bestBid, side });
  if (x.readable && x.crosses) {
    messages.push(
      `A ${toC(price)}¢ ${side === 'BUY' ? `incroci l'ask (${toC(x.edge)}¢)` : `incroci il bid (${toC(x.edge)}¢)`}`
      + " — l'ordine si eseguirebbe subito, non resterebbe come maker.",
    );
  }

  let outOfBand = null;
  if (fin(scoringMid) && fin(bandRadiusCents) && bandRadiusCents > 0) {
    const dC = Math.abs(price - scoringMid) * 100;
    outOfBand = dC > bandRadiusCents + 1e-6;
    if (outOfBand) {
      messages.push(
        `Fuori dalla banda reward: ${dC.toFixed(2)}¢ dal mid di scoring (${toC(scoringMid)}¢), `
        + `oltre il massimo di ±${bandRadiusCents.toFixed(2)}¢. Un ordine qui NON matura reward.`,
      );
    }
  }

  const bad = (x.readable && x.crosses) || outOfBand === true;
  if (bad) return { level: 'bad', crosses: !!(x.readable && x.crosses), outOfBand, messages };

  // Verde solo se ENTRAMBE le domande hanno avuto una risposta. Un book illeggibile non è un book sicuro.
  if (!x.readable || (fin(bandRadiusCents) && !fin(scoringMid))) {
    return {
      level: 'unknown', crosses: false, outOfBand,
      messages: [x.readable ? 'Mid di scoring non leggibile: la banda non è verificabile.' : `Book non leggibile (${x.reason}): l'incrocio non è verificabile.`],
    };
  }
  const bandTxt = fin(bandRadiusCents) && fin(scoringMid)
    ? ` e dentro la banda reward (${(Math.abs(price - scoringMid) * 100).toFixed(2)}¢ ≤ ±${bandRadiusCents.toFixed(2)}¢)`
    : '';
  return {
    level: 'ok', crosses: false, outOfBand,
    messages: [`A ${toC(price)}¢ l'ordine resta sul book come maker (${side === 'BUY' ? `ask a ${toC(bestAsk)}¢` : `bid a ${toC(bestBid)}¢`})${bandTxt}.`],
  };
}

/**
 * La distanza di un livello dal mid, in centesimi. È la misura su cui lavora il filtro «distanza minima»
 * del pannello, isolata qui perché il test possa verificarla senza aprire un browser.
 */
function distanceCents(price, mid) {
  if (!fin(price) || !fin(mid)) return null;
  return +(Math.abs(price - mid) * 100).toFixed(4);
}

/** Un livello è selezionabile se dista dal mid ALMENO quanto la soglia. Sotto soglia: oscurato e inerte. */
function levelBlocked(price, mid, minDistanceCents) {
  const d = distanceCents(price, mid);
  if (d === null || !fin(minDistanceCents) || minDistanceCents <= 0) return false;
  return d < minDistanceCents - 1e-9;
}

module.exports = {
  buildLadder, displayMid, midCoherence, bookView,
  crossesBook, priceVerdict, distanceCents, levelBlocked,
};
