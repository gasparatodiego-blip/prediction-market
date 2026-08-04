'use strict';
// lib/rewards/plan-to-orders.js — DA PIANO A RIGHE ESEGUIBILI, FUORI DAL BROWSER.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Le righe che «2 · Conferma ed esegui» manda a /api/maker/manual/bulk-allocate non arrivano dal server:
// le costruisce il pannello, in `bulkRows`, dai dati che il piano ha già restituito. Finché a premere il
// bottone c'è una persona davanti a una tabella, va benissimo.
//
// Il riallocatore periodico non ha una tabella davanti. Ha bisogno della STESSA trasformazione senza un
// browser che la esegua — e la cosa da NON fare era lasciarla scritta due volte in due posti, dove una
// delle due copie cambia e l'altra no. Qui c'è una traduzione sola, in JS semplice, che un test àncora al
// sorgente del pannello (plan-to-orders.test.js) per i predicati che i due condividono.
//
// ═══ DUE GAMBE, NON UNA — E PERCHÉ NON ERA UN DETTAGLIO ═════════════════════════════════════════════
// Fino a questa revisione questo modulo emetteva UNA riga per mercato: un BUY sul libro YES al bid. Il
// modello di reward che decide quanto vale quel mercato (lib/rewardScore.js) implementa però la formula
// ufficiale, che è a DUE lati:
//
//     Q_min (mid ∈ [0.10, 0.90]):  max(min(Q_bids, Q_asks), max(Q_bids/3, Q_asks/3))
//     Q_min (mid fuori dal range): min(Q_bids, Q_asks)      ← deve essere a due lati
//
// Con un lato solo, `Q_asks` vale zero. Fuori dal range [0.10, 0.90] questo rende `Q_min = 0`, cioè
// reward ESATTAMENTE ZERO — non ridotto: zero. Dentro il range resta il termine `Q_bids/3`, cioè un
// terzo. Misurato sul piano del 4 agosto 2026: $45,49/g su $57,95/g promessi — il 78,5% — stava su tre
// mercati con mid 0,055 / 0,065 / 0,097, tutti fuori dal range, tutti a zero reale.
//
// ═══ COME SI QUOTA IL LATO ASK SENZA POSSEDERE NIENTE ═══════════════════════════════════════════════
// Vendere YES a mid+d richiede di AVERE le share di YES. Comprare NO a 1−(mid+d) no: costa collaterale,
// e sul libro YES appare esattamente come un ask a mid+d. È il meccanismo che il motore di market making
// di questo repo già usa (lib/maker/mm-quote-math.planQuotes) e che manual-order.js documenta così:
// «un ordine NO a q È un ordine YES a 1 − q, quindi il mid di scoring del libro NO è 1 − mid».
//
// Questo modulo NON ha una seconda aritmetica: chiama `planQuotes`, la stessa funzione del motore.
//
// ═══ QUANTE SHARE PER LATO, DATO IL CAPITALE ════════════════════════════════════════════════════════
// Le due gambe costano  Q·p_yes + Q·p_no = Q·(1 − 2d)  — dove d è l'offset — perché comprare YES a p e
// NO a 1−p è comprare una coppia che vale $1. Quindi, dato il capitale C della riga:
//
//     Q = C / (p_yes + p_no)
//
// che è anche la size che MASSIMIZZA min(Q_bids, Q_asks) a parità di capitale: share uguali sui due lati
// battono dollari uguali, e la differenza è enorme sui mercati lontani da 50¢.
//
// DUE CONSEGUENZE DA DIRE AD ALTA VOCE, perché nessuna delle due è ovvia:
//
//   1. IL TETTO DEL 30% È RISPETTATO PER COSTRUZIONE. La somma delle due gambe è ESATTAMENTE C, non 2·C:
//      il capitale della riga non viene raddoppiato, viene diviso. Non c'è nessun percorso in cui le due
//      gambe insieme superino il tetto per mercato.
//
//   2. IL PIANO PROMETTE PIÙ SHARE DI QUANTE IL CAPITALE NE COMPRI, sui mercati lontani da 50¢. Il
//      modello calcola `sizePerSideShares = (C/2) / mid`, cioè assume che il lato ask costi quanto il
//      lato bid — vero solo a mid ≈ 0,50, dove infatti i due numeri coincidono. A mid 0,055 il modello
//      assume 1772 share per lato; il capitale ne compra 199. Il rapporto è 2·mid/(1−2d).
//      Questo modulo NON inventa share che il capitale non compra: piazza quelle vere e le dichiara.
//      La correzione del MODELLO (che sceglierebbe altri mercati) è una decisione separata.
//
// ═══ LE REGOLE DI ESCLUSIONE, E PERCHÉ NESSUNA È COSMETICA ══════════════════════════════════════════
//   · ILLEGGIBILE   mid, tick o timestamp assenti: non si sa a che prezzo si starebbe quotando.
//   · STANTIO       il dato più fresco della riga ha più di STALE_S secondi: si quoterebbe su un libro
//                   che non esiste più. È lo stesso limite che il pannello usa per NON contare la riga
//                   nei totali — una riga che non entra nei totali non può entrare negli ordini.
//   · FUORI BANDA   l'offset di difetto cade oltre il raggio della banda reward: scorerebbe zero.
//   · SENZA SIZE    il piano non ha saputo derivare le share per lato (mid nullo o non positivo).
//   · GAMBA-IMPOSSIBILE  uno dei due lati non è piazzabile (prezzo fuori da (0,1) dopo l'aggancio al
//                   tick) o cadrebbe fuori banda. UN LATO SOLO NON SI PIAZZA MAI: renderebbe zero sui
//                   mercati fuori range e un terzo sugli altri, con il capitale comunque impegnato.
//   · SOTTO-MINIMO  le share che il capitale compra stanno sotto la size minima premiante del venue: il
//                   venue non assegnerebbe punteggio, quindi sarebbe capitale fermo per definizione.
//
// Non c'è una regola nascosta: tutto il resto — kill switch, cap cumulativo, rate limit, proprietà
// manuale, gate per riga — vive più a valle, in bulk-allocate.js, e questo modulo non lo duplica né lo
// anticipa. Qui si decide solo QUALI righe del piano sono candidabili, non se possono essere inviate.

// Lo stesso valore che RewardsAllocatePanel.tsx dichiara come STALE_S. Non è una scelta indipendente:
// è la stessa soglia, e il test la verifica leggendola dal sorgente del pannello.
const STALE_S = 300;

// L'aritmetica dei due lati è quella del motore di market making, non una copia.
const { planQuotes } = require('../maker/mm-quote-math');

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Ricalcola una riga del piano all'offset dato, dai soli dati che il piano ha già restituito.
 * Rispecchia `rowAt` del pannello: nessuna aritmetica di tick reimplementata: bid/ask/fills/costo sono
 * già stati arrotondati alla griglia lato server, uno per ogni tick selezionabile.
 */
function rowAt(r, offsetTicks) {
  const ft = (r.fillsByTick || []).find((x) => x.tick === offsetTicks) || null;
  const offsetCents = fin(r.tick) ? offsetTicks * r.tick * 100 : null;
  const bandKnown = r.maxSpreadCents != null;
  const inBand = bandKnown && offsetCents != null ? offsetCents <= r.maxSpreadCents / 2 + 1e-9 : null;
  // Due regole del venue azzerano la riga: FUORI BANDA non scora, e SOTTO LA SIZE MINIMA non scora.
  const gross = r.grossInBandPerDay == null ? null : (r.belowVenueMinSize ? 0 : (inBand === false ? 0 : r.grossInBandPerDay));
  return { offsetTicks, offsetCents, bid: ft ? ft.bid : null, ask: ft ? ft.ask : null, inBand, bandKnown, gross };
}

/** Le share, troncate al decimo. TRONCATE e non arrotondate: arrotondare per eccesso farebbe superare
 *  il capitale della riga, e il tetto per mercato non deve poter essere sforato per un arrotondamento. */
function troncaShare(q) {
  if (!fin(q) || q <= 0) return 0;
  return Math.floor(q * 10) / 10;
}

/**
 * LE DUE GAMBE DI UNA RIGA SOLA, all'offset dato. Pura: nessun file, nessuna rete, nessun `Date.now()`
 * implicito. È la funzione che il pannello «Ottimizza» importa e che `planToOrders` usa per ogni riga —
 * UNA sola costruzione delle gambe, quindi il bottone manuale e il riallocatore automatico non possono
 * più mandare al venue due cose diverse. Prima erano due copie in due linguaggi, e una delle due (il
 * pannello) era rimasta a un lato solo.
 *
 * @returns {{rows: Array|null, scarto: {motivo, dettaglio}|null, coppia: object|null}}
 *          `rows` valorizzato ⇒ due righe pronte; `scarto` valorizzato ⇒ il mercato non è eseguibile e
 *          il motivo è dichiarato. Non esiste un terzo esito e non esiste il ritorno di UNA riga sola.
 */
function gambeDiUnaRiga(r, offsetTicks) {
  const rif = { marketId: r.marketId, title: r.name || r.shortId || null };
  const no = (motivo, dettaglio) => ({ rows: null, coppia: null, scarto: { ...rif, motivo, dettaglio } });

  const offsetCents = fin(r.tick) ? offsetTicks * r.tick * 100 : null;
  const bandRadiusCents = fin(r.maxSpreadCents) ? r.maxSpreadCents / 2 : null;
  const q = planQuotes({ mid: r.mid, offsetCents, tick: r.tick, bandRadiusCents });
  const gambe = [q.yes, q.no];

  const impossibile = gambe.find((g) => !g || g.placeable !== true);
  if (impossibile) {
    return no('gamba-impossibile',
      `${impossibile.reason || (q.reason || 'lato non piazzabile')} — un lato solo renderebbe zero fuori dal range [0,10-0,90] e un terzo dentro, quindi non si piazza nessuno dei due`);
  }
  // La banda vale per ENTRAMBI: il lato NO dista dal SUO mid quanto il lato YES dal suo, quindi in
  // pratica o sono dentro tutti e due o nessuno — ma lo si verifica invece di darlo per scontato.
  const fuori = gambe.find((g) => g.inBand === false);
  if (fuori) {
    return no('gamba-fuori-banda', `il lato ${fuori.book.toUpperCase()} riposa fuori dal raggio premiante: ${fuori.bandNote}`);
  }

  // ── LE SHARE CHE IL CAPITALE COMPRA DAVVERO, uguali sui due lati ────────────────────────────────
  const capitale = fin(r.capital) && r.capital > 0 ? r.capital : null;
  if (capitale == null) return no('senza-capitale', 'il piano non assegna capitale a questa riga');

  const sommaPrezzi = q.yes.price + q.no.price;
  const shares = troncaShare(capitale / sommaPrezzi);
  if (shares <= 0) {
    return no('capitale-insufficiente',
      `$${capitale} non comprano nemmeno un decimo di share sui due lati (${q.yes.price} + ${q.no.price} = ${sommaPrezzi.toFixed(4)}/coppia)`);
  }

  // ── LA SIZE MINIMA PREMIANTE DEL VENUE ──────────────────────────────────────────────────────────
  // Sotto min_incentive_size il venue non assegna punteggio: quel lato varrebbe zero, e con Q_min a due
  // lati un lato a zero azzera anche l'altro. Il capitale resterebbe impegnato per niente.
  const minSize = fin(r.minSizeShares) && r.minSizeShares > 0 ? r.minSizeShares : null;
  if (minSize != null && shares < minSize) {
    return no('sotto-size-minima',
      `$${capitale} comprano ${shares} share per lato, sotto il minimo premiante del venue (${minSize}): a due lati un lato sotto minimo azzera anche l'altro`);
  }

  const notionalYes = +(q.yes.price * shares).toFixed(4);
  const notionalNo = +(q.no.price * shares).toFixed(4);
  return {
    scarto: null,
    coppia: {
      marketId: r.marketId, title: rif.title, shares,
      prezzoYes: q.yes.price, prezzoNo: q.no.price,
      offsetCents, capitalePianoUsd: capitale,
      capitaleImpegnatoUsd: +(notionalYes + notionalNo).toFixed(2),
      // Quante share il PIANO credeva di poter comprare per lato, contro quelle vere. Col modello di
      // sizing corretto il rapporto è ~1; se si allontana, il modello e la realtà stanno divergendo.
      sharePiano: r.sizePerSideShares, shareReali: shares,
      rapportoSize: fin(r.sizePerSideShares) && r.sizePerSideShares > 0 ? +(shares / r.sizePerSideShares).toFixed(4) : null,
    },
    rows: gambe.map((g) => ({
      marketId: r.marketId,
      title: r.name || r.shortId,
      book: g.book,           // 'yes' | 'no'
      side: 'BUY',            // entrambe le gambe sono acquisti: nessun inventario richiesto
      price: g.price,
      size: shares,
      // L'appartenenza alla coppia viaggia con la riga: è ciò che permette a bulk-allocate di non
      // piazzare mai una gamba senza l'altra, e alla riconciliazione di non contare due mercati.
      coppia: r.marketId,
      gamba: g.book,
      // MAI PRIMI SUL LIBRO. Il prezzo qui e' mid − offset, calcolato senza guardare la coda perche' il
      // piano non ha il book. Chi piazza ce l'ha: dichiarando `inCoda`, placeManualOrder lo sposta un
      // tick dietro al miglior prezzo altrui e riporta lo spostamento. Se la banda non lo consente,
      // vince la banda e restiamo premianti — vedi lib/maker/prezzo-in-coda.js.
      inCoda: true,
    })),
  };
}

/**
 * Le righe eseguibili di un piano — DUE per mercato, all'offset di difetto che il piano ha calcolato.
 *
 * @param {object} plan   il corpo restituito da planFromCollection
 * @param {object} opts   nowMs (per l'età dei dati), staleSeconds
 * @returns {{rows, scartate, coppie, totals}}  righe pronte per bulk-allocate + il registro di CHI è
 *          stato escluso e perché. Le esclusioni sono elencate, mai silenziose: un piano da 5 mercati
 *          che ne esegue 2 deve dire quali 3 sono rimasti fuori, altrimenti sembra un piano da 2.
 *
 *          Ogni riga porta `coppia` (il marketId) e `gamba` ('yes'|'no'): sono ciò che permette a
 *          bulk-allocate di trattare le due gambe come una cosa sola e di non lasciarne mai una da sola.
 */
function planToOrders(plan, opts = {}) {
  const nowMs = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const staleS = fin(opts.staleSeconds) ? opts.staleSeconds : STALE_S;
  const rows = [];
  const scartate = [];
  const coppie = [];

  for (const r of (plan && plan.rows) || []) {
    const c = rowAt(r, r.computedDefaultOffsetTicks);
    const ageS = fin(r.newestTsMs) ? Math.max(0, (nowMs - r.newestTsMs) / 1000) : null;
    const unreadable = r.mid == null || r.tick == null || r.newestTsMs == null;
    const stale = !unreadable && ageS != null && ageS > staleS;
    const rif = { marketId: r.marketId, title: r.name || r.shortId || null };

    if (unreadable) { scartate.push({ ...rif, motivo: 'illeggibile', dettaglio: 'mid, tick o timestamp assenti nel piano' }); continue; }
    if (stale) { scartate.push({ ...rif, motivo: 'stantio', dettaglio: `dato vecchio di ${Math.round(ageS)}s (limite ${staleS}s)` }); continue; }
    if (c.inBand === false) { scartate.push({ ...rif, motivo: 'fuori-banda', dettaglio: `offset ${c.offsetCents}¢ oltre il raggio della banda` }); continue; }
    if (c.bid == null) { scartate.push({ ...rif, motivo: 'senza-bid', dettaglio: 'nessun bid calcolabile al tick di difetto' }); continue; }
    if (r.sizePerSideShares == null) { scartate.push({ ...rif, motivo: 'senza-size', dettaglio: 'share per lato non derivabili' }); continue; }

    // ── I DUE LATI, con la STESSA funzione che usa il pannello ────────────────────────────────────
    const g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks);
    if (g.scarto) { scartate.push(g.scarto); continue; }
    coppie.push(g.coppia);
    rows.push(...g.rows);
  }

  return {
    rows, scartate, coppie,
    totals: {
      candidate: ((plan && plan.rows) || []).length,
      eseguibili: coppie.length,          // MERCATI eseguibili, non righe: due righe sono un mercato
      righe: rows.length,
      scartate: scartate.length,
      capitaleUsd: +rows.reduce((s, x) => s + x.price * x.size, 0).toFixed(2),
    },
  };
}

module.exports = { planToOrders, gambeDiUnaRiga, rowAt, troncaShare, STALE_S };
