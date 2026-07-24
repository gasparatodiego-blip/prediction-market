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

// Build a cancel-only adapter for a venue. Live only when explicitly armed AND liveVerified AND a real
// credsProvider is supplied; otherwise dryRun (no network, no creds) — the safe default in this build.
function buildCancelAdapter(venue, { armed, liveVerified, credsProvider } = {}) {
  if (!CONFIGURED_VENUES.includes(venue)) return null;
  const canLive = armed === true && liveVerified === true && typeof credsProvider === 'function';
  return createCancelOnlyAdapter(canLive ? { credsProvider } : { dryRun: true });
}

// Cancel every open order on one venue: read the venue's open orders (venue truth), then cancel each
// market's resting orders. Never claims success on a failed read/cancel — a partial failure is reported
// as such, with the exact error. Returns venue-reported figures only.
async function cancelVenueOrders(venue, opts = {}) {
  const adapter = buildCancelAdapter(venue, opts);
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

  let cancelled = 0;
  let anyError = null;
  const markets = [];
  for (const m of marketIds) {
    const r = await adapter.cancelMarketOrders(m);
    const n = countCancelled(r);
    if (n != null) cancelled += n;
    markets.push({ market: m, cancelled: n, ok: r.ok !== false, error: r.ok === false ? r.error : null });
    if (r.ok === false) anyError = r.error;
  }
  return { venue, ok: anyError == null, error: anyError, cancelled, venueOpenBefore, simulated, markets };
}

/**
 * Cancel ALL open orders on EVERY configured venue.
 * @param {object} opts
 *   venues         string[] — venues to sweep (default: all configured).
 *   armed          boolean  — must be true (plus liveVerified + credsProvider) for a real cancel.
 *   liveVerified   boolean
 *   credsProviders { [venue]: async () => ({creds, address}) } — injected only when arming.
 * @returns Array<{ venue, ok, error, cancelled, venueOpenBefore, simulated, markets }>
 */
async function cancelAllOrders({ venues = CONFIGURED_VENUES, armed = false, liveVerified = false, credsProviders = {} } = {}) {
  const results = [];
  for (const venue of venues) {
    try {
      results.push(await cancelVenueOrders(venue, { armed, liveVerified, credsProvider: credsProviders[venue] }));
    } catch (e) {
      results.push({ venue, ok: false, error: (e && e.message) || String(e), cancelled: 0, venueOpenBefore: null, markets: [] });
    }
  }
  return results;
}

module.exports = { cancelAllOrders, cancelVenueOrders, buildCancelAdapter, countCancelled, CONFIGURED_VENUES };
