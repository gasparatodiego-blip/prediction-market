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
    // Could not read the venue → we do NOT know what is resting and cancelled nothing. Report the failure.
    return { venue, ok: false, error: open.error || 'listOpenOrders failed', cancelled: 0, venueOpenBefore: null, simulated, markets: [] };
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
      results.push({ venue, ok: false, error: (e && e.message) || String(e), cancelled: 0, venueOpenBefore: null, markets: [] });
    }
  }
  return results;
}

module.exports = { cancelAllOrders, cancelVenueOrders, buildCancelAdapter, countCancelled, notionalResiduoUsd, CONFIGURED_VENUES };
