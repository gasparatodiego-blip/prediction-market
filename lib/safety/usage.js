'use strict';
// lib/safety/usage.js — the MEASURED usage snapshot the risk limits evaluate against. Read from durable
// storage at the placement chokepoint, never from the request.
//
// All three inputs are now REAL (the exposure/loss stubs that hardcoded null — and so kept the exposure and
// daily-loss limits permanently failing closed — are gone):
//   • ordersInWindow      — this user's placement INTENT rows in the last windowMs (execution-audit trail).
//   • openNotionalUsd      — confirmed open exposure from the fill-truth ledger (lib/safety/fills.js):
//                            confirmed fills − confirmed closes, PLUS any UNKNOWN sent order at full notional.
//   • realisedDailyPnlUsd  — realised P&L for the UTC calendar day from the same ledger (realised only).
//
// FAIL CLOSED, everywhere (absent ≠ unreadable):
//   • audit trail UNREADABLE → all three null → every limit fails closed.
//   • fill ledger UNREADABLE  → openNotionalUsd / realisedDailyPnlUsd null → those two limits fail closed.
//   • fill ledger ABSENT      → no fills yet → exposure 0, realised loss 0 → the limits ARM and permit a
//                               within-cap order. That is the honest default, not a fabricated zero.
//
// CHOKEPOINT VALUATION: readUsage is SYNCHRONOUS (no network on the placement path), so it cannot fetch a
// live book to mark positions. It therefore values open positions at their ENTRY-notional FLOOR — which
// never understates a deployed position — and lets an async reconciler/reporter do executable bid/ask
// marking (computeExposure accepts a `marks` map; proven in the selfcheck). Flooring at entry notional is
// the safe direction: an armed engine can only be MORE restricted, never less.

const { queryByUser } = require('./execution-audit');
const { readVenuePositions } = require('./venue-positions-snapshot');
const { computeExposure, computeRealisedDailyPnl } = require('./fills');

// The orders that reached the venue = every INTENT row (an intent is written only AFTER all gates pass and
// immediately before the send; a gate refusal writes no intent). Each is a possibly-live order until the
// fill ledger resolves it — so it is a `sentOrder` for exposure (UNKNOWN → counted at full notional).
function sentOrdersFromAudit(rows) {
  const outcomeByKey = new Map();
  for (const r of rows) if (r.kind === 'outcome' && r.idempotencyKey) outcomeByKey.set(r.idempotencyKey, r);
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'intent' || !r.idempotencyKey) continue;
    const oc = outcomeByKey.get(r.idempotencyKey);
    out.push({
      idempotencyKey: r.idempotencyKey,
      notionalUsd: r.notionalUsd,
      ts: r.ts,
      userId: r.userId || null,
      venue: r.venue || null,
      tokenId: r.market != null ? String(r.market) : null,
      side: r.side || null,
      price: r.price,
      size: r.size,
      orderId: oc && oc.orderId != null ? String(oc.orderId) : null,
    });
  }
  return out;
}

/**
 * @param {{userId:string, now?:number, windowMs?:number, marks?:object}} args
 * @returns {{openNotionalUsd:(number|null), ordersInWindow:(number|null), realisedDailyPnlUsd:(number|null), sentOrders?:Array}}
 */
function readUsage({ userId, now = Date.now(), windowMs = 60_000, marks = null, venuePositions = undefined }, deps = {}) {
  // ── rate (ordersInWindow) + the sent-order set both come from the audit trail. One read. ──
  let windowRows, allRows;
  try {
    windowRows = queryByUser({ userId, fromTs: now - windowMs, toTs: now }, deps);
    allRows = queryByUser({ userId, fromTs: 0, toTs: now }, deps);
  } catch (_e) {
    // Trail unreadable → we can bound nothing → every limit fails closed on a non-finite value.
    return { openNotionalUsd: null, ordersInWindow: null, realisedDailyPnlUsd: null };
  }
  const ordersInWindow = windowRows.filter(r => r.kind === 'intent').length;
  const sentOrders = sentOrdersFromAudit(allRows);

  // ── open exposure from the fill ledger (fail closed on unreadable/unbounded-unknown). ──
  // ── LE POSIZIONI VERE ENTRANO NEL TETTO ────────────────────────────────────────────────────────
  // Lo snapshot lo deposita agent40 sul suo throttle di 60s, dalla STESSA lettura che usa l'uscita
  // automatica: non e' una terza fonte di verita'. Qui si legge da disco — `readUsage` e' sincrona e sta
  // sul percorso caldo di ogni piazzamento, e un gate che dipende dalla latenza della rete e' un gate
  // che qualcuno prima o poi disattiva.
  //
  // Il chiamante puo' passarle esplicitamente (i test lo fanno); altrimenti si leggono dallo snapshot.
  const vp = venuePositions !== undefined ? venuePositions : readVenuePositions(deps);
  const exp = computeExposure({ userId, now, sentOrders, marks, venuePositions: vp }, deps);
  const openNotionalUsd = exp.ok ? exp.openNotionalUsd : null;

  // ── realised daily P&L (UTC day) from the same ledger (fail closed on unreadable). ──
  const pnl = computeRealisedDailyPnl({ userId, now }, deps);
  const realisedDailyPnlUsd = pnl.ok ? pnl.realisedPnlUsd : null;

  return {
    openNotionalUsd, ordersInWindow, realisedDailyPnlUsd, sentOrders,
    // `readable:false` NON e' «nessuna posizione»: e' «non ho guardato». Chi impone un tetto deve poter
    // distinguere le due cose — vedi evaluateLimits, che sul secondo caso rifiuta.
    venuePositions: exp.ok ? exp.venuePositions : { readable: false, count: 0, addedUsd: 0, reason: 'ledger illeggibile' },
  };
}

module.exports = { readUsage, sentOrdersFromAudit };
