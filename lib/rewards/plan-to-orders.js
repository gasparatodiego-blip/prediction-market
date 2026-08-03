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
// delle due copie cambia e l'altra no. Qui c'è una traduzione sola, in JS semplice, che il pannello
// rispecchia riga per riga e che un test àncora al sorgente del pannello (plan-to-orders.test.js): se il
// pannello cambia predicato o campi, il test smette di passare e obbliga ad allinearli.
//
// ═══ LE QUATTRO REGOLE DI ESCLUSIONE, E PERCHÉ NESSUNA È COSMETICA ══════════════════════════════════
//   · ILLEGGIBILE   mid, tick o timestamp assenti: non si sa a che prezzo si starebbe quotando.
//   · STANTIO       il dato più fresco della riga ha più di STALE_S secondi: si quoterebbe su un libro
//                   che non esiste più. È lo stesso limite che il pannello usa per NON contare la riga
//                   nei totali — una riga che non entra nei totali non può entrare negli ordini.
//   · FUORI BANDA   l'offset di difetto cade oltre il raggio della banda reward: scorerebbe zero.
//   · SENZA SIZE    il piano non ha saputo derivare le share per lato (mid nullo o non positivo).
//
// Non c'è una quinta regola nascosta: tutto il resto — kill switch, cap cumulativo, rate limit, proprietà
// manuale, gate per riga — vive più a valle, in bulk-allocate.js, e questo modulo non lo duplica né lo
// anticipa. Qui si decide solo QUALI righe del piano sono candidabili, non se possono essere inviate.

// Lo stesso valore che RewardsAllocatePanel.tsx dichiara come STALE_S. Non è una scelta indipendente:
// è la stessa soglia, e il test la verifica leggendola dal sorgente del pannello.
const STALE_S = 300;

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

/**
 * Le righe eseguibili di un piano, all'offset di difetto che il piano stesso ha calcolato.
 *
 * @param {object} plan   il corpo restituito da planFromCollection
 * @param {object} opts   nowMs (per l'età dei dati), staleSeconds
 * @returns {{rows, scartate, totals}}  righe pronte per bulk-allocate + il registro di CHI è stato
 *          escluso e perché. Le esclusioni sono elencate, mai silenziose: un piano da 5 mercati che ne
 *          esegue 2 deve dire quali 3 sono rimasti fuori, altrimenti sembra un piano da 2.
 */
function planToOrders(plan, opts = {}) {
  const nowMs = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const staleS = fin(opts.staleSeconds) ? opts.staleSeconds : STALE_S;
  const rows = [];
  const scartate = [];

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

    rows.push({
      marketId: r.marketId,
      title: r.name || r.shortId,
      book: 'yes',
      price: c.bid,
      size: Math.round(r.sizePerSideShares * 10) / 10,
    });
  }

  return {
    rows, scartate,
    totals: {
      candidate: ((plan && plan.rows) || []).length,
      eseguibili: rows.length,
      scartate: scartate.length,
      capitaleUsd: +rows.reduce((s, x) => s + x.price * x.size, 0).toFixed(2),
    },
  };
}

module.exports = { planToOrders, rowAt, STALE_S };
