'use strict';
// lib/maker/order-ttl.js — venue-native GTD order-expiry helper (the ONLY protection that
// survives host death). Pure, no I/O, node-testable.
//
// WHY THIS EXISTS — a resting order on the Polymarket CLOB survives a PM2 crash, a VPS reboot,
// and a network partition. A dead process does NOT cancel its orders. A same-host watchdog
// therefore cannot protect against host-level failure. Only a venue-enforced expiration does.
//
// PRIMARY-SOURCE CONSTANTS (docs.polymarket.com, verified 2026-07-24 — record the URLs, not memory):
//   • Order carries a signed `expiration` field, uint256 UNIX SECONDS, part of the EIP-712 struct.
//     - https://docs.polymarket.com/trading/orders/create
//     - https://docs.polymarket.com/developers/CLOB/orders/create-order
//     Confirmed in the ACTUALLY-INSTALLED client: @polymarket/clob-client-v2 UserOrderV2.expiration
//     (unix seconds) and the signed NewOrderV2 struct carries `expiration: string`. OrderType has GTD.
//     (Note: an older project memory claimed v2 "dropped expiration" from the struct — that is WRONG
//      for the installed v2 SDK; expiration is present and signed. This module is the corrected fact.)
//   • GTD orders "expire one minute before their stated expiration as a security threshold."
//   • "the expiration must be at least 3 minutes in the future — orders expiring sooner are rejected."
//   • "To set an effective lifetime of N seconds, use `now + 60 + N`."
//
// CONSEQUENCE (state this loudly): because the venue floor is 3 minutes (180s stated) and the order
// expires 60s early, the SHORTEST native effective lifetime the venue will accept is 120s. A desired
// TTL below that CANNOT be expressed natively — we clamp UP to the venue floor and flag it, and never
// send an expiration the venue would reject. Sub-floor freshness (e.g. a 60s refresh) must come from
// the maker's own cancel/replace cadence, NOT from the native expiry.

// Primary-source venue constants — change ONLY if Polymarket publishes new values.
const VENUE_GTD_MIN_FUTURE_SEC = 180;    // "at least 3 minutes in the future"
const SECURITY_DECREMENT_SEC = 60;       // "expire one minute before their stated expiration"

// Minimum native effective lifetime the venue can honour: floor(180) minus the 60s early decrement.
const MIN_EFFECTIVE_TTL_SEC = VENUE_GTD_MIN_FUTURE_SEC - SECURITY_DECREMENT_SEC; // 120

/**
 * Compute the signed GTD `expiration` (unix seconds) for an order placed now with the desired TTL.
 * @param {number} nowMs   Date.now() at placement time.
 * @param {number} ttlSeconds  desired effective lifetime in seconds.
 * @returns {{orderType:'GTC'|'GTD', expiration:number, expirationIso:string|null,
 *            requestedTtlSeconds:number, effectiveTtlSeconds:number|null,
 *            clampedToVenueFloor:boolean, venueFloorSeconds:number, securityDecrementSeconds:number}}
 */
function computeGtdExpiration(nowMs, ttlSeconds) {
  const nowSec = Math.floor(Number(nowMs) / 1000);
  // ttl <= 0 means "no native expiry" (GTC). We never do this on the maker path, but be explicit.
  if (!(ttlSeconds > 0)) {
    return {
      orderType: 'GTC', expiration: 0, expirationIso: null,
      requestedTtlSeconds: Number(ttlSeconds) || 0, effectiveTtlSeconds: null,
      clampedToVenueFloor: false, venueFloorSeconds: VENUE_GTD_MIN_FUTURE_SEC,
      securityDecrementSeconds: SECURITY_DECREMENT_SEC,
    };
  }
  // Formula from primary docs: stated = now + 60 + N (accounts for the 60s early-expiry decrement).
  const statedRequested = nowSec + SECURITY_DECREMENT_SEC + ttlSeconds;
  const venueFloorStated = nowSec + VENUE_GTD_MIN_FUTURE_SEC;
  const clamped = statedRequested < venueFloorStated;
  const stated = clamped ? venueFloorStated : statedRequested;
  const effectiveTtlSeconds = stated - SECURITY_DECREMENT_SEC - nowSec; // when it actually expires, from now
  return {
    orderType: 'GTD',
    expiration: stated,
    expirationIso: new Date(stated * 1000).toISOString(),
    requestedTtlSeconds: ttlSeconds,
    effectiveTtlSeconds,
    clampedToVenueFloor: clamped,
    venueFloorSeconds: VENUE_GTD_MIN_FUTURE_SEC,
    securityDecrementSeconds: SECURITY_DECREMENT_SEC,
  };
}

/**
 * Startup assertion: a native TTL that is <= the refresh loop guarantees permanent gaps in the book
 * (the order expires before the maker re-quotes it); a TTL longer than the refresh guarantees the
 * native expiry only ever cleans up orphans, never the live quote set. TTL MUST exceed the refresh.
 * @returns {{ok:boolean, reason:string}}
 */
function checkTtlVsRefresh({ ttlSeconds, refreshIntervalMs }) {
  const ttlMs = Number(ttlSeconds) * 1000;
  const refreshMs = Number(refreshIntervalMs);
  if (!(ttlSeconds > 0)) {
    return { ok: false, reason: `MAKER_ORDER_TTL_SECONDS must be > 0 (got ${ttlSeconds}); the maker requires a native venue expiry on every order.` };
  }
  if (!(ttlMs > refreshMs)) {
    return {
      ok: false,
      reason: `MAKER_ORDER_TTL_SECONDS=${ttlSeconds}s (${ttlMs}ms) is <= the refresh interval ${refreshMs}ms. `
        + `A TTL <= the refresh loop guarantees permanent gaps in the book (orders expire before the next re-quote). `
        + `Set MAKER_ORDER_TTL_SECONDS strictly greater than the refresh interval.`,
    };
  }
  return { ok: true, reason: `ttl ${ttlSeconds}s (${ttlMs}ms) > refresh ${refreshMs}ms` };
}

module.exports = {
  computeGtdExpiration,
  checkTtlVsRefresh,
  VENUE_GTD_MIN_FUTURE_SEC,
  SECURITY_DECREMENT_SEC,
  MIN_EFFECTIVE_TTL_SEC,
};
