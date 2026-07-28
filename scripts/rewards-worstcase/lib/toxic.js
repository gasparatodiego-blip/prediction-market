'use strict';
// scripts/rewards-worstcase/lib/toxic.js — PHASE 3: the two net-negative "toxic" markets at full weight.
// Computes their damage if an operator (or an allocator on a different day) HELD them, and gathers the
// ex-ante observable properties to test — honestly, over TWO points — whether anything could have excluded
// them in advance. Reuses the shipped per-market math read-only. Replay, not P&L.

const { perMarketNetAtSize, marketMeta } = require('../../../lib/rewards/allocator');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Resolve full conditionIds from prefixes, present in the journal. */
function resolveToxic(byMarket, prefixes) {
  const out = [];
  for (const mid of byMarket.keys()) if (prefixes.some((p) => mid.startsWith(p))) out.push(mid);
  return out;
}

/** Fraction of a good day's net that a (negative) toxic net erases: |min(0,toxicNet)| / goodNet. */
function fractionErased(toxicNetPerDay, goodNetPerDay) {
  if (!(fin(toxicNetPerDay) && fin(goodNetPerDay) && goodNetPerDay > 0)) return null;
  return Math.max(0, -toxicNetPerDay) / goodNetPerDay;
}

/** Full per-market view (net at a size + ex-ante observable properties) for one market. */
function marketView(mid, D, sizeUsd, meta) {
  const rows = D.byMarket.get(mid) || [];
  const trades = (D.marketTokens.get(mid) && D.tapeByToken.get(D.marketTokens.get(mid))) || [];
  const r = perMarketNetAtSize(mid, rows, trades, D.potByCond, { offsetCents: 1, sizeUsd, maxInventoryUsd: 5000 });
  const mm = marketMeta(rows);
  const snap = meta && meta.byCond ? meta.byCond[mid] : null;
  return {
    marketId: mid, sizeUsd,
    grossPerDay: r.grossPerDay, costPerDay: r.costPerDay5m, netPerDay: r.netPerDay5m, fills: r.fills,
    // ex-ante observable properties (readable BEFORE any fill)
    pot: D.potByCond.get(mid) ?? null,
    maxSpreadCents: snap ? snap.maxSpread ?? null : null,
    minSize: snap ? snap.minSize ?? null : null,
    depthShares: mm.depthShares, mid: mm.mid, tick: mm.tick, spanHours: mm.spanHours,
    question: snap ? snap.q ?? null : null,
  };
}

module.exports = { resolveToxic, fractionErased, marketView };
