'use strict';
// lib/maker/reconcile.js — PURE core for continuous reconciliation (Phase 5). The engine's BELIEF about
// what is resting can drift from reality (a post that silently failed, a fill, a cancel that raced). On
// every reconcile we TRUST THE VENUE: diff the desired quote set against what listOpenOrders actually
// reports and emit the minimal set of place/cancel actions, plus detect partial fills.
//
// NEVER assume a post succeeded — a desired quote with no matching venue order is a PLACE, not a
// silently-resting order. A venue order not in the desired set is a CANCEL. This is the poly-maker
// "reconcile with churn tolerance + periodic REST reconcile" pattern (adopted): a quote whose price
// already matches within one tick is left alone (no needless cancel/replace that would drop resting
// time and risk a lost reward sample).

// Match a desired quote to a venue order: same token + side + price within `tickTol` ticks.
function sameQuote(desired, venueOrder, tickTol, tick) {
  if (String(desired.token) !== String(venueOrder.asset_id ?? venueOrder.token ?? venueOrder.tokenID)) return false;
  const vSide = String(venueOrder.side || '').toUpperCase();
  if (vSide !== desired.side) return false;
  const vPrice = parseFloat(venueOrder.price);
  const tol = (tick > 0 ? tick : 0.0001) * (tickTol > 0 ? tickTol : 1) + 1e-9;
  return Math.abs(vPrice - desired.price) <= tol;
}

/**
 * Reconcile desired quotes against the venue's open orders.
 * @param {object} args
 *   desired   Array of postable quotes { token, side, price, size } (from planQuotes, postable only)
 *   venueOrders Array of the venue's open orders { asset_id/side/price/original_size/size_matched, id }
 *   tick      market tick size (for the churn tolerance)
 *   tickTol   how many ticks of price difference is "the same quote" (default 0 → exact tick)
 * @returns { toPlace, toCancel, keep, partialFills }
 */
function reconcile({ desired, venueOrders, tick, tickTol = 0 }) {
  const D = (desired || []).filter(q => q.postable !== false && q.price != null && q.token);
  const V = (venueOrders || []).slice();
  const matchedVenue = new Set();
  const keep = [];
  const partialFills = [];
  const toPlace = [];

  for (const d of D) {
    const idx = V.findIndex((v, i) => !matchedVenue.has(i) && sameQuote(d, v, tickTol, tick));
    if (idx === -1) { toPlace.push(d); continue; }   // engine believed it rested, but the venue disagrees → PLACE
    matchedVenue.add(idx);
    const v = V[idx];
    const orig = parseFloat(v.original_size ?? v.originalSize ?? v.size ?? 0);
    const matched = parseFloat(v.size_matched ?? v.sizeMatched ?? 0);
    if (matched > 0) partialFills.push({ token: d.token, side: d.side, price: d.price, filledShares: matched, remainingShares: Math.max(0, orig - matched), orderId: v.id ?? v.orderID ?? null });
    keep.push({ ...d, orderId: v.id ?? v.orderID ?? null, remainingShares: Math.max(0, orig - matched) });
  }
  // Anything the venue still reports that we didn't want → CANCEL (trust the venue over our belief).
  const toCancel = V.filter((_, i) => !matchedVenue.has(i)).map(v => ({ orderId: v.id ?? v.orderID ?? null, token: v.asset_id ?? v.token ?? null, side: v.side, price: parseFloat(v.price) }));

  return { toPlace, toCancel, keep, partialFills, divergence: toPlace.length + toCancel.length };
}

module.exports = { reconcile, sameQuote };
