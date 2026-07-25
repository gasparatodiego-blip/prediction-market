'use strict';
// lib/reward-layers.js — the SINGLE source of truth for how many distinct price LAYERS fit inside a
// Polymarket reward band, and at what tick-snapped price each one sits.
//
// LAYERING, not queue position. Polymarket's liquidity-reward formula scores an order by its
// distance from the (size-adjusted) mid and its size — NOT by FIFO priority at a price. A "layer" is
// therefore one distinct resting price within [bandLow, bandHigh]; several layers = several prices per
// side. This module computes nothing about queue order and must never be used to reason about it.
//
// The sampler (agent34, Phase 2) and the panel (Phase 5+) both import THIS — neither reimplements the
// geometry. Given a market's real bandLow, bandHigh and tick it returns:
//   • maxUsablePerSide = floor(band_half_width / tick) — the hard cap on layers, at 1-tick spacing.
//   • the tick-snapped price at each layer index, per side, nearest-mid first, within the band.
// Adjacent indices that tick-snap to the same price are MERGED (deduped), never emitted twice.

/** Snap a raw price onto the venue tick grid (nearest multiple of tick). */
function snapToTick(price, tick) {
  return Math.round(price / tick) * tick;
}

/** Round to 6 dp to kill binary-float dust (prices are cents; 6dp is exact enough and matches the
 *  agent34 band rounding). */
function r6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * @param {number} bandLow   lower reward-band bound (executable price, e.g. 0.6375)
 * @param {number} bandHigh  upper reward-band bound (e.g. 0.6825)
 * @param {number} tick      venue tick size (e.g. 0.01)
 * @param {object} [opts]
 * @param {number} [opts.spacingTicks=1]  ticks BETWEEN adjacent layers (Phase-3 spacing control)
 * @param {number} [opts.maxLayers=Infinity]  operator-requested cap on layers per side
 * @returns {{ maxUsablePerSide:number, spacingTicks:number, center:(number|null),
 *            bid:Array<{index:number,price:number}>, ask:Array<{index:number,price:number}>,
 *            count:number }}
 *   maxUsablePerSide is the absolute cap (floor(half_width/tick)); `count` is how many layers per
 *   side actually fit at the requested spacing/cap; bid/ask carry the snapped prices nearest-mid first.
 *   Everything is [] / 0 when the inputs are not a usable band — never a guessed default.
 */
function rewardLayers(bandLow, bandHigh, tick, opts = {}) {
  const spacingTicks = Math.max(1, Math.floor(Number(opts.spacingTicks) || 1));
  const maxLayers = Number.isFinite(opts.maxLayers) ? Math.max(0, Math.floor(opts.maxLayers)) : Infinity;

  const ok = [bandLow, bandHigh, tick].every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!ok || tick <= 0 || bandHigh <= bandLow) {
    return { maxUsablePerSide: 0, spacingTicks, center: null, bid: [], ask: [], count: 0 };
  }

  const halfWidth = (bandHigh - bandLow) / 2;
  const center = (bandLow + bandHigh) / 2; // the TRUE (size-adjusted) mid — NOT snapped to the grid
  const EPS = tick * 1e-9;

  // The hard cap: how many whole ticks fit in the half-width. band exactly one tick each side → 1.
  const maxUsablePerSide = Math.max(0, Math.floor((halfWidth + EPS) / tick));

  // A layer is a real tick-GRID price within the band, on one side of the true mid. Layer 1 is the grid
  // price NEAREST the mid on that side — the highest-reward placement — never a price derived by snapping
  // the mid itself (that would drop the near-mid layer when the mid sits off the grid, e.g. 0.835).
  // Bid side: grid prices strictly below the mid, descending. Ask side: strictly above, ascending.
  const bidStart = Math.floor((center - EPS) / tick) * tick; // nearest grid price < mid
  const askStart = Math.ceil((center + EPS) / tick) * tick;  // nearest grid price > mid
  const buildSide = (start, dir /* -1 bid, +1 ask */) => {
    const out = [];
    const seen = new Set();
    for (let step = 0; step <= 100000; step++) {
      const price = r6(snapToTick(start + dir * step * spacingTicks * tick, tick));
      if (dir < 0 && price < bandLow - EPS) break;
      if (dir > 0 && price > bandHigh + EPS) break;
      const key = price.toFixed(8);
      if (!seen.has(key)) {          // MERGE: two indices that snap to the same price collapse to one
        seen.add(key);
        out.push({ index: out.length + 1, price });
      }
      if (out.length >= Math.min(maxLayers, maxUsablePerSide)) break;
    }
    return out;
  };

  const bid = buildSide(bidStart, -1);
  const ask = buildSide(askStart, +1);
  return {
    maxUsablePerSide,
    spacingTicks,
    center,
    bid,
    ask,
    count: Math.max(bid.length, ask.length),
  };
}

/**
 * Per-level qualifying resting depth at each reward layer, reusing the SAME geometry as rewardLayers.
 * For each layer index it records the bid-side price + qualifying size resting there, and the ask-side
 * price + size. This is the multi-level analogue of agent34's aggregate inBandDepth.
 *
 * NULL DISCIPLINE: a side whose order array is null/undefined (the book side was not readable) yields
 * `null` for that side's size at every level — never 0, never dropped. A side that IS present but has
 * no orders at a layer price yields a real 0 (a genuine observation that nothing rests there). The
 * level's index is always kept.
 *
 * @param {Array<{price:number,size:number}>|null} bids  full book bids (price desc) or null if unreadable
 * @param {Array<{price:number,size:number}>|null} asks  full book asks (price asc) or null if unreadable
 * @param {number} bandLow @param {number} bandHigh @param {number} tick
 * @param {number} minSize  the qualifying size cutoff the reward scoring uses (orders below are ignored)
 * @returns {Array<{index:number,bidPrice:(number|null),bidSizeAtLevel:(number|null),askPrice:(number|null),askSizeAtLevel:(number|null)}>}
 */
function levelsInBand(bids, asks, bandLow, bandHigh, tick, minSize) {
  const { bid, ask } = rewardLayers(bandLow, bandHigh, tick);
  const cutoff = minSize > 0 ? minSize : 0;
  const eps = tick * 1e-6;
  const sizeAt = (orders, price) => {
    if (orders == null) return null;                       // side unreadable → null, never defaulted to 0
    let s = 0;
    for (const o of orders) {
      if (o && Math.abs(o.price - price) < eps && o.size >= cutoff) s += o.size;
    }
    return Math.round(s * 1e4) / 1e4;                       // book present → real qualifying size (0 if none)
  };
  const len = Math.max(bid.length, ask.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const bp = bid[i] ? bid[i].price : null;
    const ap = ask[i] ? ask[i].price : null;
    out.push({
      index: i + 1,
      bidPrice: bp,
      bidSizeAtLevel: bp == null ? null : sizeAt(bids, bp),
      askPrice: ap,
      askSizeAtLevel: ap == null ? null : sizeAt(asks, ap),
    });
  }
  return out;
}

module.exports = { rewardLayers, snapToTick, levelsInBand };
