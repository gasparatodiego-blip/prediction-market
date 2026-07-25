'use strict';
// lib/reward-layered.js — the SINGLE shared path for LAYERED (multi-price) reward quoting: turn an
// operator's per-market layer configuration into a concrete per-layer plan, then (Phase 4) score each
// layer against history-preferred / live-fallback depth, then (Phase 5) cap each layer by its own depth
// and reconcile capital. The panel (Phase 6) and scripts/rewards-{ceiling,replay} (Phase 7) all import
// THIS — none reimplements the geometry (lib/reward-layers), the quadratic (lib/rewardScore) or the
// venue guards (lib/maker/venue-rules).
//
// LAYERING, never queue position: a layer is a distinct resting PRICE within the reward band. The reward
// is scored by distance-from-mid and size, not FIFO priority.

const { rewardLayers } = require('./reward-layers');
const { validateQuotePair } = require('./maker/venue-rules');
const { scoreOrder, qMin, quadraticUserShare } = require('./rewardScore');

// Polymarket rewards only score orders whose price sits within [0.10, 0.90]; a layer priced in the
// tails earns nothing. Evaluated PER LAYER (a near-tail market can have inner layers that score and
// outer layers that fall in the tail), never as one blanket per-market flag.
const TAIL_LO = 0.10;
const TAIL_HI = 0.90;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function r4(x) { return Math.round(x * 1e4) / 1e4; }

/**
 * Size split across layers. Default EQUAL; the shape is an array of weights that sum to 1, so a future
 * front-loaded / back-loaded profile is a drop-in replacement (pass opts.weights).
 * @returns {number[]} length n, sums to 1 (empty when n<=0)
 */
function layerSizeSplit(n, opts = {}) {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (Array.isArray(opts.weights) && opts.weights.length === count) {
    const sum = opts.weights.reduce((a, w) => a + (fin(w) && w > 0 ? w : 0), 0);
    if (sum > 0) return opts.weights.map((w) => (fin(w) && w > 0 ? w : 0) / sum);
  }
  return Array.from({ length: count }, () => 1 / count); // equal split (default)
}

function inTail(price) {
  return !fin(price) || price < TAIL_LO - 1e-12 || price > TAIL_HI + 1e-12;
}

/**
 * Build the concrete per-layer plan for one market at an operator configuration.
 * @param {object} args
 *   rewardScore   { mid, maxSpreadCents, minSize, competitorQ, poolDay, ... } (feed row) — mid/maxSpread/minSize used here
 *   tick          venue tick
 *   bandLow,bandHigh  reward band bounds (from the feed / agent34)
 *   perSideSizeUsd    the operator's TOTAL size committed PER SIDE (dollars)
 *   numLayers     requested layers per side (clamped to the real usable count, never higher)
 *   spacingTicks  ticks between adjacent layers (default 1)
 *   sizeWeights   optional custom split weights (default equal)
 * @returns {{ maxUsablePerSide, numLayers, spacingTicks, perSideSizeUsd, sizeSplitMode,
 *            layers: Array<object> }}
 */
function computeLayeredPlan(args = {}) {
  const rs = args.rewardScore || {};
  const mid = fin(rs.mid) ? rs.mid : null;
  const maxSpreadCents = fin(rs.maxSpreadCents) ? rs.maxSpreadCents : null;
  const minSize = fin(rs.minSize) ? rs.minSize : null;
  const tick = fin(args.tick) ? args.tick : null;
  const bandLow = fin(args.bandLow) ? args.bandLow : null;
  const bandHigh = fin(args.bandHigh) ? args.bandHigh : null;
  const perSideSizeUsd = fin(args.perSideSizeUsd) && args.perSideSizeUsd > 0 ? args.perSideSizeUsd : null;
  const spacingTicks = Math.max(1, Math.floor(Number(args.spacingTicks) || 1));

  const geom = rewardLayers(bandLow, bandHigh, tick, { spacingTicks, maxLayers: args.numLayers });
  const maxUsablePerSide = geom.maxUsablePerSide;
  // Clamp the request to what the band actually fits — never offer more than the geometry allows.
  const requested = fin(args.numLayers) ? Math.max(0, Math.floor(args.numLayers)) : maxUsablePerSide;
  const numLayers = Math.min(requested, geom.bid.length, geom.ask.length);

  const empty = {
    maxUsablePerSide, numLayers: 0, spacingTicks, perSideSizeUsd,
    sizeSplitMode: 'equal', layers: [],
  };
  if (numLayers <= 0 || mid == null || maxSpreadCents == null || minSize == null || tick == null) {
    return empty;
  }

  const weights = layerSizeSplit(numLayers, { weights: args.sizeWeights });
  const rules = { tick, scoringMid: mid, maxSpreadCents, minSize };

  const layers = [];
  for (let i = 0; i < numLayers; i++) {
    const bidPrice = geom.bid[i] ? geom.bid[i].price : null;
    const askPrice = geom.ask[i] ? geom.ask[i].price : null;
    const sizeUsd = perSideSizeUsd != null ? r4(perSideSizeUsd * weights[i]) : null;
    // Per-side shares are sized at each leg's own price so the dollar budget round-trips exactly.
    const bidShares = sizeUsd != null && fin(bidPrice) && bidPrice > 0 ? r4(sizeUsd / bidPrice) : null;
    const askShares = sizeUsd != null && fin(askPrice) && askPrice > 0 ? r4(sizeUsd / askPrice) : null;

    // Tails: each leg priced in [0.10, 0.90]? a leg in the tail earns nothing (per layer).
    const bidTail = inTail(bidPrice);
    const askTail = inTail(askPrice);
    const tailZero = bidTail || askTail; // the two-sided reward needs BOTH legs out of the tail

    // Tick-snap + band + min-size + BUY-NO/SELL-YES two-sided collapse — the existing shared guard.
    const verdict = validateQuotePair(
      rules,
      { side: 'BUY', price: bidPrice, size: bidShares },
      { side: 'SELL', price: askPrice, size: askShares },
    );

    layers.push({
      index: i + 1,
      bidPrice, askPrice,
      distanceBidC: fin(bidPrice) && mid != null ? r4(Math.abs(mid - bidPrice) * 100) : null,
      distanceAskC: fin(askPrice) && mid != null ? r4(Math.abs(askPrice - mid) * 100) : null,
      sizeUsd, bidShares, askShares,
      tailZero, bidTail, askTail,
      // collapse guard verdict (both/degraded/weakerSide) — the two-sided score collapses to the weaker leg
      degraded: verdict.degraded,
      weakerSide: verdict.weakerSide,
      quoteValid: verdict.valid && !tailZero,
      note: tailZero
        ? `livello nella coda del book (prezzo fuori [${TAIL_LO}, ${TAIL_HI}]) — nessun premio su questo livello`
        : verdict.note,
    });
  }

  return {
    maxUsablePerSide, numLayers, spacingTicks, perSideSizeUsd,
    sizeSplitMode: Array.isArray(args.sizeWeights) ? 'custom' : 'equal',
    layers,
  };
}

/** Plain-Italian disclosure of which depth a layer's estimate used — never present history and a live
 *  read identically to the reader. */
function depthSourceLabel(depthSource) {
  if (!depthSource || !depthSource.kind) return null;
  if (depthSource.kind === 'storico') {
    const h = fin(depthSource.hours) ? depthSource.hours : null;
    return h != null ? `stima da storico ${h}h` : 'stima da storico';
  }
  if (depthSource.kind === 'live') return 'stima da lettura live';
  return null;
}

/**
 * Score each layer of a plan INDEPENDENTLY with the published quadratic, our own order added to THAT
 * layer's own depth, then sum into a per-market total. Pure — the panel (client) and ceiling/replay
 * (server) both call this; the depth is resolved upstream (history-preferred, live fallback) and passed
 * in so this stays deterministic.
 *
 * @param {object} args
 *   plan          the Phase-3 plan from computeLayeredPlan
 *   perLevelDepth aligned to plan.layers (by index): [{ bidSizeAtLevel, askSizeAtLevel } | null]
 *   rewardScore   { mid, maxSpreadCents, minSize, poolDay }
 *   depthSource   { kind:'storico'|'live', hours? } — disclosed on every row
 * @returns {{ layers, totalDailyUsd, rawTotalDailyUsd, poolCapped, poolDay, anyDepthUnreadable, depthSource, depthSourceLabel }}
 */
function scoreLayeredPlan(args = {}) {
  const plan = args.plan || { layers: [] };
  const rs = args.rewardScore || {};
  const depthSource = args.depthSource || null;
  const perLevelDepth = Array.isArray(args.perLevelDepth) ? args.perLevelDepth : [];
  const mid = fin(rs.mid) ? rs.mid : null;
  const maxSpreadCents = fin(rs.maxSpreadCents) ? rs.maxSpreadCents : null;
  const v = maxSpreadCents != null ? maxSpreadCents / 2 : null;
  const minSize = fin(rs.minSize) ? rs.minSize : null;
  const poolDay = fin(rs.poolDay) ? rs.poolDay : null;
  const srcLabel = depthSourceLabel(depthSource);

  const layers = plan.layers.map((L, i) => {
    const depth = perLevelDepth[i] || null;
    const bidSize = depth && fin(depth.bidSizeAtLevel) ? depth.bidSizeAtLevel : null; // null → unreadable, fail closed
    const askSize = depth && fin(depth.askSizeAtLevel) ? depth.askSizeAtLevel : null;
    const base = { ...L, depthSource, depthSourceLabel: srcLabel, bidDepth: bidSize, askDepth: askSize };

    // A tail layer earns nothing — a real 0, disclosed, never a "—".
    if (L.tailZero) return { ...base, competitorQ: 0, share: 0, dailyUsd: 0 };
    // FAIL CLOSED: any input we cannot read → no estimate ("—"), never a guessed one.
    if (!fin(bidSize) || !fin(askSize) || mid == null || v == null || minSize == null || !fin(L.sizeUsd)) {
      return { ...base, competitorQ: null, share: null, dailyUsd: null };
    }
    // competitor Q AT THIS LAYER: the resting depth at the layer's own bid/ask prices, scored by each
    // side's own distance-from-mid, coupled via qMin exactly as the whole-book competitorQ is built.
    const scoredBid = scoreOrder(L.distanceBidC, v) * bidSize;
    const scoredAsk = scoreOrder(L.distanceAskC, v) * askSize;
    const competitorQ = qMin(scoredBid, scoredAsk, mid);
    // Our order at this layer. quadraticUserShare scores at ONE distance; use the weaker (larger) side —
    // qMin picks the weaker leg, so this never overstates the reward.
    const dist = Math.max(L.distanceBidC, L.distanceAskC);
    const share = quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, L.sizeUsd, dist);
    const dailyUsd = (share != null && poolDay != null) ? poolDay * share : null;
    return { ...base, competitorQ: r4(competitorQ), share: share != null ? +share.toFixed(6) : null, dailyUsd: dailyUsd != null ? r4(dailyUsd) : null };
  });

  const rawTotal = layers.reduce((a, l) => a + (fin(l.dailyUsd) ? l.dailyUsd : 0), 0);
  // Honest ceiling: the sum of independent per-layer shares can exceed 1 pool; you can never earn more
  // than the market's whole daily pool, so cap the total at poolDay and say when the cap binds.
  const poolCapped = poolDay != null && rawTotal > poolDay + 1e-9;
  const totalDailyUsd = poolDay != null ? Math.min(rawTotal, poolDay) : rawTotal;
  const anyDepthUnreadable = layers.some((l) => l.dailyUsd == null && !l.tailZero);

  return {
    layers,
    totalDailyUsd: r4(totalDailyUsd),
    rawTotalDailyUsd: r4(rawTotal),
    poolCapped,
    poolDay,
    anyDepthUnreadable,
    depthSource,
    depthSourceLabel: srcLabel,
  };
}

module.exports = { computeLayeredPlan, scoreLayeredPlan, layerSizeSplit, depthSourceLabel, TAIL_LO, TAIL_HI };
