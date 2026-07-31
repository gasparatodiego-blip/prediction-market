'use strict';
// lib/safety/reconcile-fills.js — periodic reconciliation of SENT orders against VENUE TRUTH into the
// fill ledger (lib/safety/fills.js). This is what keeps openNotionalUsd / realisedDailyPnlUsd honest: an
// order whose fill status we never confirmed must be RESOLVED by asking the venue, not assumed.
//
// HOW IT RUNS / HOW OFTEN: agent35-maker calls reconcileOnce() from its loop, THROTTLED to at most once per
// RECONCILE_INTERVAL_MS (default 60s) — independent of the 3s quote tick. It reads the operator's resting
// orders from the venue (adapter.listOpenOrders → per-order size_matched, the same size_matched truth
// lib/maker/reconcile.js already trusts) and optionally the public /trades feed, and appends confirmed
// fills. In the DISARMED build the adapter's reads are shadow (canWrite=false → no network), so
// reconcileOnce resolves nothing and records nothing — it is wired and proven, dormant until arming.
//
// THREE HONEST OUTCOMES per unresolved sent order (never a fourth "assume it filled and fabricate a fill"):
//   • CONFIRMED FILLED (size_matched grew, or /trades shows a matching fill) → append the CONFIRMED delta as
//     a fill (partial recorded as partial; incremental so repeated runs never double-count).
//   • CONFIRMED ZERO-FILL (venue reached, order gone from open orders AND /trades shows nothing) → nofill.
//   • UNCONFIRMABLE (venue unreachable, or order vanished with no /trades cross-check) → leave UNKNOWN.
//     Record NOTHING — the order stays counted at full notional by computeExposure (the safe direction).
//     We NEVER fabricate a fill to "resolve" an ambiguous order.

const { readFills, recordFill, recordNoFill } = require('./fills');

const RECONCILE_INTERVAL_MS = Number(process.env.SAFETY_RECONCILE_INTERVAL_MS || 60_000);

// Sum of already-recorded confirmed filled size per idempotencyKey (so partial fills accumulate exactly
// once across repeated reconciliations — reconcile records only the DELTA).
function recordedFilledByKey(ledgerRows) {
  const m = new Map();
  for (const row of ledgerRows) {
    if (row.kind === 'fill' && row.idempotencyKey) m.set(row.idempotencyKey, (m.get(row.idempotencyKey) || 0) + (row.filledSize || 0));
  }
  return m;
}
function resolvedNoFillKeys(ledgerRows) {
  const s = new Set();
  for (const row of ledgerRows) if (row.kind === 'nofill' && row.idempotencyKey) s.add(row.idempotencyKey);
  return s;
}

// Match one of OUR sent orders to a venue open-order by orderId (the precise key we hold from the outcome
// row); fall back to (tokenId, side, ~price) when the venue omits our id.
function findVenueOrder(order, venueOrders, tick) {
  const tol = (tick > 0 ? tick : 0.0001) + 1e-9;
  for (const v of venueOrders) {
    const vid = v.id != null ? String(v.id) : (v.orderID != null ? String(v.orderID) : null);
    if (order.orderId && vid && String(order.orderId) === vid) return v;
  }
  for (const v of venueOrders) {
    const vTok = String(v.asset_id ?? v.token ?? v.tokenID ?? '');
    const vSide = String(v.side || '').toUpperCase();
    if (vTok && vTok === String(order.tokenId || '') && vSide === String(order.side || '').toUpperCase() && Math.abs(parseFloat(v.price) - Number(order.price)) <= tol) return v;
  }
  return null;
}

/**
 * PURE reconciliation planner — decides what to record, given already-fetched venue truth. No I/O, so it is
 * exhaustively unit-testable.
 *
 * @param {object} args
 *   userId
 *   sentOrders   Array<{ idempotencyKey, orderId?, tokenId, side, price, size, notionalUsd, ts }>
 *   ledgerRows   the user's existing fill-ledger rows (for incremental/idempotent recording)
 *   venueReachable  boolean — did the venue read actually succeed? false → everything stays UNKNOWN.
 *   venueOrders  Array of the venue's open orders { id, asset_id, side, price, original_size, size_matched }
 *   venueFills   optional Array of confirmed fills from /trades, matched by tokenId+side (cross-check)
 *   feeResolver  optional (tokenId, price, size) => feeUsd|null (fee SSOT). null → fill stored feeKnown:false.
 *   tick, now, source
 * @returns {{ toRecord:Array, toNoFill:Array, stillUnknown:Array }}
 */
function planReconcile({ userId, sentOrders = [], ledgerRows = [], venueReachable = false, venueOrders = [], venueFills = null, venuePositions = null, feeResolver = null, tick = 0.01, now = Date.now(), source = 'reconcile' } = {}) {
  // Positions indexed by token, for the SECOND opinion required before concluding "never filled".
  // null (the read failed / was not attempted) is deliberately different from an empty array.
  const positionByToken = Array.isArray(venuePositions)
    ? venuePositions.reduce((m, p) => {
      const tok = String(p.asset ?? p.assetId ?? p.asset_id ?? p.tokenId ?? '');
      const size = Math.abs(Number(p.size) || 0);
      if (tok && size > 1e-9) m.set(tok, (m.get(tok) || 0) + size);
      return m;
    }, new Map())
    : null;
  const recorded = recordedFilledByKey(ledgerRows);
  const noFilled = resolvedNoFillKeys(ledgerRows);
  const toRecord = [], toNoFill = [], stillUnknown = [];

  for (const o of sentOrders) {
    if (!o || !o.idempotencyKey) continue;
    if (noFilled.has(o.idempotencyKey)) continue; // already resolved zero-fill
    if (!venueReachable) { stillUnknown.push({ idempotencyKey: o.idempotencyKey, reason: 'venue-unreachable' }); continue; }

    const vo = findVenueOrder(o, venueOrders, tick);
    const already = recorded.get(o.idempotencyKey) || 0;

    if (vo) {
      // The order is (still) resting — size_matched is the venue's confirmed cumulative filled size.
      const matched = parseFloat(vo.size_matched ?? vo.sizeMatched ?? 0) || 0;
      const delta = matched - already;
      if (delta > 1e-9) {
        const price = Number(o.price);
        toRecord.push(mkFill(o, delta, price, feeResolver, now, source + ':size_matched'));
      }
      // else: seen resting, no new fill — leave unresolved (still counted at full notional, safe).
      continue;
    }

    // Order NOT in open orders: it either fully filled or was cancelled. Only a POSITIVE /trades confirmation
    // lets us record a fill; a confirmed absence lets us record a no-fill; otherwise it stays UNKNOWN.
    if (Array.isArray(venueFills)) {
      const matchedFills = venueFills.filter(f => String(f.tokenId ?? f.asset ?? '') === String(o.tokenId || '') && String(f.side || '').toUpperCase() === String(o.side || '').toUpperCase());
      const totalFilled = matchedFills.reduce((s, f) => s + (Number(f.size) || 0), 0);
      const delta = totalFilled - already;
      if (delta > 1e-9) {
        // Volume-weighted executable fill price from the venue's own trade records.
        const vwap = matchedFills.reduce((s, f) => s + (Number(f.price) || 0) * (Number(f.size) || 0), 0) / (totalFilled || 1);
        toRecord.push(mkFill(o, delta, vwap, feeResolver, now, source + ':trades'));
      } else if (already <= 1e-9 && positionByToken === null) {
        // TWO INDEPENDENT VENUE READS MUST AGREE BEFORE WE CALL AN ORDER UNFILLED. Without the positions
        // read we have only /trades, and /trades is NOT instantaneous: on 2026-07-31 a hand order on the
        // NO leg filled, /positions showed the 50 shares immediately, and /trades still returned an EMPTY
        // list. On that evidence this branch recorded a no-fill for an order that had genuinely filled —
        // which UNDERSTATES exposure, the one direction fills.js exists to prevent. The cap gate then read
        // $0.00 against a real $24.25 position.
        stillUnknown.push({ idempotencyKey: o.idempotencyKey, reason: 'no-positions-crosscheck' });
      } else if (already <= 1e-9 && positionByToken.has(String(o.tokenId || ''))) {
        // THE TWO SOURCES DISAGREE: no trades, but a position exists on this very token. That is exactly
        // the lag above. Resolve NOTHING — the order keeps counting at full notional (the safe direction)
        // until /trades catches up and the next pass can decide from positive evidence.
        stillUnknown.push({ idempotencyKey: o.idempotencyKey, reason: 'positions-contradict-no-trades' });
      } else if (already <= 1e-9) {
        // CARRY THE IDENTITY. recordNoFill stores userId/venue verbatim and readFills FILTERS BY userId
        // (`if (userId && row.userId !== userId) continue`), so a row written without one is appended and
        // then never read back — the order stays "unresolved" forever and keeps counting at full notional.
        // mkFill above has always propagated these from the sent order; this branch did not, and the bug
        // was invisible because the branch is unreachable unless the caller supplies `venueFills` (which
        // reconcileOnce never has). Found by the operator-reset sequence, whose final check re-reads the
        // cap gate and refused to report success while the exposure had not actually moved.
        toNoFill.push({
          userId: o.userId || null,
          venue: o.venue || 'polymarket',
          idempotencyKey: o.idempotencyKey,
          orderId: o.orderId || null,
          source: source + ':gone-and-no-trades',
          ts: now,
          reason: 'gone-and-no-trades',
        });
      }
      continue;
    }
    // No /trades cross-check available → cannot confirm filled vs cancelled → stay UNKNOWN (never fabricate).
    stillUnknown.push({ idempotencyKey: o.idempotencyKey, reason: 'gone-no-crosscheck' });
  }

  return { toRecord, toNoFill, stillUnknown };
}

function mkFill(o, filledSize, filledPrice, feeResolver, now, source) {
  let feeUsd = null;
  if (typeof feeResolver === 'function') { try { feeUsd = feeResolver(o.tokenId, filledPrice, filledSize); } catch { feeUsd = null; } }
  return { userId: o.userId || null, venue: o.venue || 'polymarket', tokenId: o.tokenId, market: o.market || o.tokenId,
    side: o.side, filledSize, filledPrice, feeUsd, source, orderId: o.orderId || null, idempotencyKey: o.idempotencyKey, ts: now };
}

/**
 * Execute a reconciliation plan against the ledger (append the confirmed fills / no-fills). Returns counts.
 * Kept separate from planReconcile so the planner stays pure and the writer is a thin, audited I/O step.
 */
function applyReconcile(plan, deps = {}) {
  let fills = 0, nofills = 0;
  for (const f of plan.toRecord) { const r = recordFill(f, deps); if (r.recorded) fills++; }
  for (const n of plan.toNoFill) { const r = recordNoFill(n, deps); if (r.recorded) nofills++; }
  return { fills, nofills, stillUnknown: plan.stillUnknown.length };
}

/**
 * One reconciliation pass driven by an adapter's READ surface. Best-effort and side-effect-safe: any read
 * failure is treated as venue-unreachable (orders stay UNKNOWN, nothing fabricated). Never places or cancels.
 *
 * @param {object} args
 *   userId, sentOrders, adapter (maker adapter — listOpenOrders/getPositions READS only), feeResolver, now, source
 * @returns {{ ran:boolean, fills, nofills, stillUnknown }}
 */
async function reconcileOnce({ userId, sentOrders = [], adapter, feeResolver = null, now = Date.now(), source = 'agent35-reconcile' } = {}, deps = {}) {
  const ledger = readFills({ userId }, deps);
  if (!ledger.ok) return { ran: false, reason: 'ledger-unreadable', fills: 0, nofills: 0, stillUnknown: 0 };
  let venueReachable = false, venueOrders = [];
  if (adapter && typeof adapter.listOpenOrders === 'function') {
    try {
      const res = await adapter.listOpenOrders();
      // A SHADOW read (disarmed: off/paper) returns { simulated:true } and reaches NO venue → not truth.
      if (res && res.ok && res.simulated !== true) { venueReachable = true; venueOrders = Array.isArray(res.orders) ? res.orders : []; }
    } catch { venueReachable = false; }
  }
  // The positions read is the SECOND opinion the no-fill conclusion now requires. Best-effort: an adapter
  // without getPositions, or a failing read, leaves venuePositions null — and the planner then refuses to
  // conclude "unfilled" at all, rather than concluding it on one source.
  let venuePositions = null;
  if (adapter && typeof adapter.getPositions === 'function') {
    try {
      const pr = await adapter.getPositions();
      if (pr && pr.ok && pr.simulated !== true && Array.isArray(pr.positions)) venuePositions = pr.positions;
    } catch { venuePositions = null; }
  }
  const plan = planReconcile({ userId, sentOrders, ledgerRows: ledger.rows, venueReachable, venueOrders, venuePositions, feeResolver, now, source });
  const applied = applyReconcile(plan, deps);
  return { ran: true, venueReachable, ...applied };
}

module.exports = { planReconcile, applyReconcile, reconcileOnce, findVenueOrder, recordedFilledByKey, RECONCILE_INTERVAL_MS };
