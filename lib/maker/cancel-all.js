'use strict';
// lib/maker/cancel-all.js — cancel EVERY open maker order on every configured venue.
//
// CANCEL-SCOPED ONLY. This module imports the cancel-only Polymarket adapter (address-only signer,
// structurally cannot sign an order → cannot place) and NOTHING from the order-placement module
// (lib/venues/polymarket-clob-maker/*). It is the single "STOP" primitive shared by BOTH the dead-man
// watchdog (agent37) and the manual kill switch (/api/maker/cancel). The one thing those two must be
// able to do is stop orders — never start them — so their entire reachable surface is this file.
//
// DISARMED BUILD: no real cancel credentials are wired here (arming is a separate reviewed change, like
// the news-guard cancel adapter). Without an injected credsProvider we build the adapter in dryRun mode:
// it makes ZERO network calls and loads NO credentials, so calling cancelAllOrders() right now is safe —
// it reports "0 cancelled (dry-run/disarmed)" honestly. When armed, a real credsProvider is injected here.

const { createCancelOnlyAdapter } = require('../venues/polymarket-clob/adapter');
// CHI POSSIEDE UN ORDINE. Modulo senza piazzamento (verificato: il suo albero non tocca
// lib/venues/polymarket-clob-maker/*), quindi importarlo qui non allarga di un millimetro la superficie
// di questo file — che resta l'unica cosa raggiungibile dal guardiano e dal pulsante di kill.
const { attributeOrder, manualIdempotencyKeys } = require('./attribuzione-ordini');

// The only venues with a cancel surface today. (The CEX adapters are verify-only; no cancel path exists.)
const CONFIGURED_VENUES = Object.freeze(['polymarket']);

// Count venue-reported cancellations from a cancelMarketOrders response. The CLOB returns
// { canceled: [...ids], not_canceled: {...} }. Returns null (UNKNOWN — never a guessed 0) when the venue
// acknowledged the call but did not return a countable list, so callers never present a fabricated count.
function countCancelled(res) {
  if (!res || res.ok === false) return 0;                 // failed call cancelled nothing
  if (res.noop === true) return 0;                        // idempotent "nothing resting" → 0 is real
  const r = res.response || res;
  if (Array.isArray(r.canceled)) return r.canceled.length;
  if (Array.isArray(r.cancelled)) return r.cancelled.length;
  if (Array.isArray(r.orders)) return r.orders.length;
  return null;                                            // acknowledged but uncountable → unknown
}

// Build a cancel-only adapter for a venue. LIVE whenever a real credsProvider is supplied; otherwise
// dryRun (no network, no creds). Cancel is not gated on liveVerified — a cancel can only REDUCE exposure,
// so credential PRESENCE is the trigger, and simulated:true is reachable only when creds are genuinely
// absent (no provider passed).
function buildCancelAdapter(venue, { credsProvider } = {}) {
  if (!CONFIGURED_VENUES.includes(venue)) return null;
  return createCancelOnlyAdapter(typeof credsProvider === 'function' ? { credsProvider } : { dryRun: true });
}

// ── QUANTO CAPITALE STAVA IMPEGNANDO CIÒ CHE STIAMO PER TOGLIERE ────────────────────────────────────
// Si calcola PRIMA di cancellare, sugli ordini che il venue ha appena elencato: dopo la cancellazione
// quel dato non esiste più da nessuna parte. Serve a chi legge l'avviso in dashboard — «9 ordini
// cancellati» non dice se sono $12 o $663, e la seconda cifra è quella che decide se alzarsi.
//
// I NOMI DEI CAMPI SONO QUELLI DEL VENUE, gli stessi che legge listManualOrders: `price`,
// `original_size`/`size`, `size_matched`. Si conta la size RESIDUA (originale meno eseguita), perché la
// parte già eseguita non è capitale che torna libero — è una posizione, e segue la sua strada.
//
// FAIL-HONEST: un ordine i cui numeri non si leggono NON vale zero, rende `null` l'intero totale. Un
// «$0.00 tornati liberi» accanto a nove ordini cancellati sarebbe una bugia più costosa del silenzio.
function notionalResiduoUsd(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  // `Number(null)` è 0 e `Number('')` è 0: due valori ASSENTI che si travestono da numero valido. Qui
  // un campo assente deve restare NaN, altrimenti un ordine senza prezzo varrebbe zero dollari e il
  // totale sarebbe più basso del vero — cioè l'errore nella direzione che tranquillizza.
  const n = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  let usd = 0;
  for (const o of orders) {
    const price = n(o && o.price);
    const size = n(o && (o.original_size ?? o.originalSize ?? o.size));
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    // `size_matched` ASSENTE significa «niente eseguito», ed è normale. `size_matched` PRESENTE ma
    // illeggibile è un'altra cosa: non sappiamo quanta size sia residua, quindi non sappiamo il totale.
    const grezzoMatched = o && (o.size_matched ?? o.sizeMatched);
    const matched = grezzoMatched === null || grezzoMatched === undefined ? 0 : n(grezzoMatched);
    if (!Number.isFinite(matched)) return null;
    usd += price * Math.max(0, size - matched);
  }
  return +usd.toFixed(2);
}

// Cancel every open order on one venue: read the venue's open orders (venue truth), then cancel each
// market's resting orders. Never claims success on a failed read/cancel — a partial failure is reported
// as such, with the exact error. Returns venue-reported figures only.
async function cancelVenueOrders(venue, opts = {}) {
  // opts.buildAdapter lets a test inject a spy cancel-only adapter to PROVE the sweep is wired to the real
  // cancelMarketOrders call path (not a simulated stub) without touching a live venue. Default: the real one.
  const adapter = (typeof opts.buildAdapter === 'function' ? opts.buildAdapter : buildCancelAdapter)(venue, opts);
  if (!adapter) return { venue, ok: false, error: `no cancel adapter configured for venue '${venue}'`, cancelled: 0, venueOpenBefore: null, markets: [] };

  const open = await adapter.listOpenOrders(); // all markets for this user
  const simulated = !!open.simulated || !!adapter.dryRun;
  if (open.ok === false) {
    // ⚠ NON SI SA, E `0` NON E' «NON SI SA». Qui c'era `cancelled: 0`: chi legge il referto trova un
    //   numero accanto a un `ok:false` e il numero e' quello che si guarda — «cancellati 0» si legge
    //   come «non c'era niente da cancellare», che e' l'unica cosa che il KILL non deve mai poter dire
    //   quando NON HA LETTO. Adesso e' `null`, e `letturaFallita` lo dichiara per nome.
    //   La causa e la forma della risposta arrivano dall'adapter (v. `lib/venues/risposta-venue.js`):
    //   servono a distinguere «il venue ha rifiutato» da «il venue ha risposto qualcosa di nuovo».
    return { venue, ok: false, error: open.error || 'listOpenOrders failed', cancelled: null, letturaFallita: true,
      causa: open.causa || null, status: open.status != null ? open.status : null, forma: open.forma || null,
      venueOpenBefore: null, simulated, markets: [], notionalUsd: null };
  }
  const orders = Array.isArray(open.orders) ? open.orders : [];
  const venueOpenBefore = Number.isFinite(open.count) ? open.count : orders.length;
  const marketIds = [...new Set(orders.map((o) => o && (o.market || o.marketId || o.condition_id || o.conditionId)).filter(Boolean))];

  // Il controvalore per mercato, fotografato PRIMA di cancellare (dopo non è più ricostruibile).
  const perMarket = new Map(marketIds.map((m) => [m, []]));
  for (const o of orders) {
    const m = o && (o.market || o.marketId || o.condition_id || o.conditionId);
    if (m && perMarket.has(m)) perMarket.get(m).push(o);
  }

  let cancelled = 0;
  let anyError = null;
  const markets = [];
  for (const m of marketIds) {
    const r = await adapter.cancelMarketOrders(m);
    const n = countCancelled(r);
    if (n != null) cancelled += n;
    markets.push({
      market: m, cancelled: n, ok: r.ok !== false, error: r.ok === false ? r.error : null,
      openBefore: (perMarket.get(m) || []).length,
      notionalUsd: notionalResiduoUsd(perMarket.get(m) || []),
    });
    if (r.ok === false) anyError = r.error;
  }
  return {
    venue, ok: anyError == null, error: anyError, cancelled, venueOpenBefore, simulated, markets,
    // Il capitale che i libri stavano impegnando un istante prima della cancellazione. `null` = non
    // leggibile per almeno un ordine, mai uno zero di comodo.
    notionalUsd: notionalResiduoUsd(orders),
  };
}

// ── LA CORSIA DI OGNI ORDINE ────────────────────────────────────────────────────────────────────────
// Due sole corsie, e sono quelle che hanno due motori diversi:
//   'manuale'  — pannello, watcher di banda, uscita automatica, tracking: tutto ciò che vive in agent40;
//   'agent35'  — il motore automatico.
// Un ordine che il registro non sa attribuire è 'sconosciuto', e NON è nessuna delle due: una
// cancellazione mirata non lo tocca mai. È la differenza fra «non è mio» e «è dell'altro», ed è la
// distinzione che il 6 agosto non esisteva.
function corsiaDi(order, manualKeys) {
  const src = attributeOrder(order, manualKeys);
  if (src === 'manual-ui') return 'manuale';
  if (src === 'agent35') return 'agent35';
  return 'sconosciuto';
}

/**
 * Cancella SOLO gli ordini di una corsia, uno per uno, per orderId.
 *
 * ═══ PERCHÉ NON RIUSA `cancelMarketOrders` ════════════════════════════════════════════════════════
 * Quella chiamata cancella TUTTO ciò che riposa su un mercato, di chiunque sia. Va benissimo per la
 * spazzata totale — dove è proprio l'intento — ed è lo strumento sbagliato per una mirata: basterebbe
 * un mercato che ospita ordini di entrambi i motori perché una cancellazione «solo di agent35» portasse
 * via anche le gambe del pannello. Qui si cancella per ID, quindi l'insieme cancellato è esattamente
 * l'insieme attribuito.
 *
 * ═══ COSA NON TOCCA, DETTO INVECE CHE SOTTINTESO ══════════════════════════════════════════════════
 * Gli ordini delle altre corsie e quelli 'sconosciuto' restano dove sono, ed escono in `skipped` con il
 * loro proprietario: chi legge il referto vede cosa è stato lasciato e perché, invece di dover dedurre
 * un insieme da una differenza di conteggi.
 *
 * @param {'manuale'|'agent35'} corsia
 */
async function cancelLaneOrders(corsia, opts = {}) {
  const venue = opts.venue || 'polymarket';
  const adapter = (typeof opts.buildAdapter === 'function' ? opts.buildAdapter : buildCancelAdapter)(venue, opts);
  if (!adapter) return { venue, corsia, ok: false, error: `no cancel adapter configured for venue '${venue}'`, cancelled: 0, venueOpenBefore: null, markets: [], skipped: [], notionalUsd: null };

  const open = await adapter.listOpenOrders();
  const simulated = !!open.simulated || !!adapter.dryRun;
  if (open.ok === false) {
    // `null`, non `0` — stessa ragione della gemella qui sopra: non abbiamo letto, quindi non sappiamo.
    return { venue, corsia, ok: false, error: open.error || 'listOpenOrders failed', cancelled: null, letturaFallita: true,
      causa: open.causa || null, status: open.status != null ? open.status : null, forma: open.forma || null,
      venueOpenBefore: null, simulated, markets: [], skipped: [], notionalUsd: null };
  }
  const orders = Array.isArray(open.orders) ? open.orders : [];
  const venueOpenBefore = Number.isFinite(open.count) ? open.count : orders.length;

  const manualKeys = (typeof opts.manualKeys === 'function' ? opts.manualKeys : manualIdempotencyKeys)();
  const miei = [];
  const skipped = [];
  for (const o of orders) {
    const c = corsiaDi(o, manualKeys);
    if (c === corsia) miei.push(o);
    else skipped.push({ orderId: String(o.id || o.orderID || o.order_id || ''), corsia: c });
  }

  let cancelled = 0;
  let anyError = null;
  const perMarket = new Map();
  for (const o of miei) {
    const id = String(o.id || o.orderID || o.order_id || '');
    const m = (o.market || o.marketId || o.condition_id || o.conditionId) || null;
    let r;
    try { r = await adapter.cancelOrder(id); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    // `noop:true` = l'ordine non c'era più (già cancellato o eseguito). Non è un fallimento, ma NON è
    // nemmeno una cancellazione: contarlo gonfierebbe il referto con ordini che non abbiamo tolto noi.
    const tolto = r && r.ok !== false && r.noop !== true;
    if (tolto) cancelled += 1;
    if (r && r.ok === false) anyError = r.error || 'cancel fallito';
    if (!perMarket.has(m)) perMarket.set(m, { market: m, cancelled: 0, ok: true, error: null, openBefore: 0, orders: [] });
    const rec = perMarket.get(m);
    rec.openBefore += 1;
    if (tolto) rec.cancelled += 1;
    if (r && r.ok === false) { rec.ok = false; rec.error = r.error || 'cancel fallito'; }
    rec.orders.push(o);
  }
  const markets = [...perMarket.values()].map((rec) => ({
    market: rec.market, cancelled: rec.cancelled, ok: rec.ok, error: rec.error,
    openBefore: rec.openBefore, notionalUsd: notionalResiduoUsd(rec.orders),
  }));

  return {
    venue, corsia, ok: anyError == null, error: anyError, cancelled, venueOpenBefore, simulated, markets,
    notionalUsd: notionalResiduoUsd(miei),
    // Cosa è stato LASCIATO, e di chi era. Un guardiano che cancella una parte del libro deve poter
    // dire quale parte non ha toccato — altrimenti «5 cancellati» su nove ordini è muto.
    skipped,
  };
}

/**
 * Cancel ALL open orders on EVERY configured venue.
 * @param {object} opts
 *   venues         string[] — venues to sweep (default: all configured).
 *   credsProviders { [venue]: async () => ({creds, address}) } — the ONE cancel credsProvider per venue
 *                  (lib/maker/cancel-creds-provider). Present → live cancel; absent → dry-run (simulated).
 * @returns Array<{ venue, ok, error, cancelled, venueOpenBefore, simulated, markets }>
 */
async function cancelAllOrders({ venues = CONFIGURED_VENUES, credsProviders = {}, buildAdapter } = {}) {
  const results = [];
  for (const venue of venues) {
    try {
      results.push(await cancelVenueOrders(venue, { credsProvider: credsProviders[venue], buildAdapter }));
    } catch (e) {
      // `cancelled: null` e non `0`: un'eccezione qui significa che non sappiamo cosa sia stato tolto.
      results.push({ venue, ok: false, error: (e && e.message) || String(e), cancelled: null, letturaFallita: true, venueOpenBefore: null, markets: [] });
    }
  }
  return results;
}

/**
 * Cancella la corsia indicata su OGNI venue configurato. Gemella di `cancelAllOrders`, stessa forma di
 * ritorno, stesso adapter di sola cancellazione — cambia solo l'insieme che tocca.
 */
async function cancelLaneOrdersAllVenues(corsia, { venues = CONFIGURED_VENUES, credsProviders = {}, buildAdapter, manualKeys } = {}) {
  const results = [];
  for (const venue of venues) {
    try {
      results.push(await cancelLaneOrders(corsia, { venue, credsProvider: credsProviders[venue], buildAdapter, manualKeys }));
    } catch (e) {
      results.push({ venue, corsia, ok: false, error: (e && e.message) || String(e), cancelled: null, letturaFallita: true, venueOpenBefore: null, markets: [], skipped: [], notionalUsd: null });
    }
  }
  return results;
}

module.exports = {
  cancelAllOrders, cancelVenueOrders, buildCancelAdapter, countCancelled, notionalResiduoUsd,
  cancelLaneOrders, cancelLaneOrdersAllVenues, corsiaDi, CONFIGURED_VENUES,
};
