'use strict';
// scripts/rewards-replay/lib/fills.js — SYNTHETIC FILL RECONSTRUCTION (Phase 1).
//
// A follow-the-mid maker rests, each sample, a BUY at (adjMid − offset) and a SELL at (adjMid + offset),
// tick-snapped, `sizeUsd` per side. Between consecutive samples we INFER a fill when the book trades
// THROUGH the resting level:
//   • BUY at p  filled when the NEXT sample's bestAsk ≤ p  (a seller crossed down to our bid)
//   • SELL at p filled when the NEXT sample's bestBid ≥ p  (a buyer lifted up to our ask)
//
// ⚠ INFERENCE LIMIT — STATED, NOT WORKED AROUND. The journal samples every ~45s, so a fill is INFERRED
// from a level crossing BETWEEN two samples, never observed on the tape. This OVER-detects a price that
// touched our level and immediately left (a fill that would have reverted), and entirely MISSES round
// trips that open and close inside one 45s interval. Neither direction can be quantified precisely
// without tick data — so this caveat is attached to every inferred-fill count downstream.
//
// snapToTick is a local copy of the trivial tick-snap (same semantics as lib/reward-price-row /
// lib/maker/quote-plan) so this module is self-contained; nothing under lib/ or scripts/rewards-ceiling/
// is modified.

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

function snapToTick(price, tick) {
  if (!(tick > 0) || !fin(price)) return null;
  const dp = (String(tick).split('.')[1] || '').length;
  let s = Number((Math.round(price / tick) * tick).toFixed(dp));
  const lo = Number(tick.toFixed(dp)), hi = Number((1 - tick).toFixed(dp));
  if (s < lo) s = lo; if (s > hi) s = hi;
  return s;
}

/**
 * Reconstruct fills for one market's ts-sorted rows.
 * @param {Array} rows          journal rows for one market (ascending ts)
 * @param {object} cfg          { offsetCents, sizeUsd, maxInventoryUsd }
 * @returns { fills:[...], excluded:{count,reasons{}}, capped:number, placedIntervals:number }
 */
function reconstructMarketFills(rows, cfg) {
  const { offsetCents, sizeUsd, maxInventoryUsd } = cfg;
  const fills = [];
  const reasons = {};
  let excluded = 0, capped = 0, placedIntervals = 0;
  let inventoryShares = 0; // signed net inventory (shares)

  const excl = (why) => { excluded++; reasons[why] = (reasons[why] || 0) + 1; };

  for (let i = 0; i < rows.length - 1; i++) {
    const t = rows[i], n = rows[i + 1];
    // A row with a null needed for placement/crossing is EXCLUDED (never defaulted).
    if (!fin(t.adjMid) || !fin(t.tick)) { excl('placement null (adjMid/tick)'); continue; }
    if (!fin(n.bestAsk) || !fin(n.bestBid)) { excl('crossing null (bestAsk/bestBid)'); continue; }
    placedIntervals++;
    const price = clampPrice(t.adjMid);
    const sizeShares = sizeUsd > 0 ? sizeUsd / price : 0;
    const maxInvShares = maxInventoryUsd > 0 ? maxInventoryUsd / price : Infinity;
    const bidPrice = snapToTick(t.adjMid - offsetCents / 100, t.tick);
    const askPrice = snapToTick(t.adjMid + offsetCents / 100, t.tick);
    const inBandBid = fin(t.bandLow) && fin(t.bandHigh) ? (bidPrice >= t.bandLow - 1e-9 && bidPrice <= t.bandHigh + 1e-9) : null;
    const inBandAsk = fin(t.bandLow) && fin(t.bandHigh) ? (askPrice >= t.bandLow - 1e-9 && askPrice <= t.bandHigh + 1e-9) : null;

    // BUY fill: ask fell to/below our bid. Skip if it would breach the long inventory cap (order pulled).
    if (bidPrice != null && n.bestAsk <= bidPrice + 1e-12) {
      if (inventoryShares + sizeShares > maxInvShares + 1e-9) { capped++; }
      else {
        inventoryShares += sizeShares;
        fills.push({ marketId: t.marketId, side: 'buy', tsMs: n.tsMs, ts: n.ts, price: bidPrice, sizeShares,
          adjMidFill: fin(n.adjMid) ? n.adjMid : null, src: n.src, inBand: inBandBid });
      }
    }
    // SELL fill: bid rose to/above our ask. Skip if it would breach the short inventory cap.
    if (askPrice != null && n.bestBid >= askPrice - 1e-12) {
      if (inventoryShares - sizeShares < -maxInvShares - 1e-9) { capped++; }
      else {
        inventoryShares -= sizeShares;
        fills.push({ marketId: t.marketId, side: 'sell', tsMs: n.tsMs, ts: n.ts, price: askPrice, sizeShares,
          adjMidFill: fin(n.adjMid) ? n.adjMid : null, src: n.src, inBand: inBandAsk });
      }
    }
  }
  return { fills, excluded: { count: excluded, reasons }, capped, placedIntervals };
}

/** Reconstruct fills across all markets in a loaded journal. */
function reconstructFills(byMarket, cfg) {
  const all = [];
  const reasons = {};
  let excluded = 0, capped = 0, placedIntervals = 0;
  for (const rows of byMarket.values()) {
    const r = reconstructMarketFills(rows, cfg);
    all.push(...r.fills);
    excluded += r.excluded.count; capped += r.capped; placedIntervals += r.placedIntervals;
    for (const [k, v] of Object.entries(r.excluded.reasons)) reasons[k] = (reasons[k] || 0) + v;
  }
  return { fills: all, excluded: { count: excluded, reasons }, capped, placedIntervals };
}

module.exports = { reconstructFills, reconstructMarketFills, snapToTick, clampPrice };
