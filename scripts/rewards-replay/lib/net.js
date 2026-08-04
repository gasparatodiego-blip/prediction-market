'use strict';
// scripts/rewards-replay/lib/net.js — NET = gross reward while resting − adverse-selection cost (Phase 3).
//
// GROSS reward reuses the ceiling's scoring READ-ONLY (scripts/rewards-ceiling/lib/curve.shareForCapital):
// our pool share = ourSize/(ourSize + competitorQ), our own order in the denominator, capacity bounded by
// the competition. The competition here is the JOURNAL's OBSERVED in-band qualifying depth (the limiting
// side, in shares) — the journal carries the depth-in-band SIZE, not the S-weighted Qmin the live-book
// scoreBook produced, so this gross is a size-pro-rata using real observed depth (stated, not hidden).
// The pot is the REAL published pot (Gamma, via scripts/rewards-ceiling/lib/gamma), matched by conditionId.
//
// COST is the realised adverse selection: the sum of the (signed, negative = loss) markout dollars of the
// fills that resting produced, at each horizon. NET = gross + Σmarkout (so a negative markout REDUCES net).
// Everything is a WINDOW total; annualising is the caller's decision and is REFUSED under 48h.

const { shareForCapital, capitalToQualify } = require('../../rewards-ceiling/lib/curve');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function median(xs) {
  const a = xs.filter(fin).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor((a.length - 1) / 2);
  return a.length % 2 ? a[m] : (a[m] + a[m + 1]) / 2;
}

/**
 * Per-market gross/cost/net using EACH MARKET'S OWN OBSERVED WINDOW.
 *
 * OBSERVED-WINDOW CORRECTION: agent34's rotating 60-market subscription means most markets are observed for
 * only part of the collection span. The reward pot is a $/day RATE, so grossPerDay = pot·share needs no
 * window; but the realised adverse-selection cost was observed only during the span we actually watched the
 * market, so it must be amortised over THAT span — costPerDay = adverse / observedSpanDays — not spread thin
 * over the global window (which under-counts cost and inflates net). netPerDay = grossPerDay − costPerDay is
 * the honest go-forward daily rate. Window totals (…Window) use the market's own span too, not a global one.
 *
 * @param {Map} byMarket    journal rows per market (each carries tsMs)
 * @param {Array} markouts  markoutForFill results
 * @param {Map} potByCond   conditionId → published daily pot ($)
 * @param {object} cfg       { sizeUsd, wsOnly } — windowHours is no longer used for gross (each market's own
 *                           observed span is used); it is accepted and ignored for backward compatibility.
 * @returns { rows:[...], aggregate:{...}, excluded:{noPot,noDepth} }
 */
function computeNet(byMarket, markouts, potByCond, cfg) {
  // minSizeByMarket: conditionId → the venue's published min_incentive_size (shares). OPTIONAL — a caller
  // that does not supply it keeps the previous arithmetic exactly (shareForCapital applies no gate), so no
  // existing backtest output moves silently. A caller that does supply it gets the venue's real rule: a
  // per-side size below the market's minimum is not scored, so its gross is 0, not a fraction of the pot.
  // `pairCostUsd` — il costo di una coppia di share (una per lato). Assente ⇒ l'aritmetica storica,
  // byte per byte: il backtest e la pipeline del ceiling non si muovono. Presente ⇒ le share per lato
  // sono `capitale / costo della coppia`, che è ciò che il capitale compra davvero quando ENTRAMBI i
  // lati vanno pagati in collaterale. Vedi la nota estesa in rewards-ceiling/lib/curve.shareForCapital.
  const { sizeUsd, wsOnly, minSizeByMarket = null, pairCostUsd = null } = cfg;
  const usaCoppia = typeof pairCostUsd === 'number' && Number.isFinite(pairCostUsd) && pairCostUsd > 0;
  const capitalTotal = 2 * sizeUsd; // both sides
  const moByMarket = new Map();
  for (const m of markouts) {
    if (!moByMarket.has(m.marketId)) moByMarket.set(m.marketId, []);
    moByMarket.get(m.marketId).push(m);
  }
  const rows = [];
  const excluded = { noPot: 0, noDepth: 0 };
  for (const [marketId, jrows] of byMarket.entries()) {
    const src = wsOnly ? jrows.filter((r) => r.src === 'ws') : jrows;
    const pot = potByCond.get(marketId);
    if (!fin(pot)) { excluded.noPot++; continue; } // pot unknown → exclude, never default
    // limiting observed in-band depth (shares) = min(bid,ask) per sample, median over the window.
    const limDepth = median(src.map((r) => (fin(r.bidDepthInBand) && fin(r.askDepthInBand)) ? Math.min(r.bidDepthInBand, r.askDepthInBand) : null));
    const mid = median(src.map((r) => r.adjMid));
    if (!fin(limDepth) || !fin(mid)) { excluded.noDepth++; continue; }
    // observed span for THIS market (first→last sample). Cost is amortised over this, not the global window.
    const spanHours = src.length >= 2 ? (src[src.length - 1].tsMs - src[0].tsMs) / 3_600_000 : 0;
    const spanDays = spanHours / 24;
    const minSize = minSizeByMarket ? minSizeByMarket.get(marketId) : undefined;
    const share = shareForCapital(limDepth, mid, capitalTotal, minSize, pairCostUsd); // ceiling scoring, venue min applied
    // WHY this row scores zero, when it does. `share === 0` with a positive pot and positive depth is the
    // under-the-minimum case, and it travels with the capital that would fix it — a refusal the operator
    // cannot act on is only half a refusal.
    // LE SHARE PER LATO, con la stessa regola che ha appena deciso il punteggio. Se questa riga e
    // shareForCapital divergessero, il piano mostrerebbe una size che non e quella con cui e stato
    // classificato — ed e esattamente il difetto che il costo della coppia esiste per chiudere.
    const sizePerSideShares = usaCoppia
      ? capitalTotal / pairCostUsd
      : (capitalTotal / 2) / Math.max(0.01, Math.min(0.99, mid));
    const belowVenueMinSize = fin(minSize) && minSize > 0 && sizePerSideShares < minSize;
    const grossPerDay = pot * share;                            // $/day rate — window-independent
    const grossWindow = grossPerDay * spanDays;                 // over the market's OWN observed span
    const mos = moByMarket.get(marketId) || [];
    const costWindowAt = {}, netWindowAt = {}, costPerDayAt = {}, netPerDayAt = {}, missingAt = {};
    for (const h of ['1m', '5m', '30m']) {
      // Per-fill markout at this horizon; a fill with no sample (beyond window / null) is UNKNOWN, never 0.
      const perFill = mos.map((m) => (m.horizons[h] && fin(m.horizons[h].usd) ? m.horizons[h].usd : null));
      const computable = perFill.filter((v) => v != null);
      missingAt[h] = perFill.length - computable.length; // fills excluded from this horizon, counted
      let adverse; // realised adverse-selection LOSS ($) over the observed span, floored ≥ 0
      if (mos.length === 0) adverse = 0;                 // no fills → zero realised cost (KNOWN, not unknown)
      else if (computable.length === 0) adverse = null;  // fills but NONE has a horizon sample → cost UNKNOWN
      else adverse = Math.max(0, -computable.reduce((s, x) => s + x, 0)); // favorable markout unrealised → not booked
      costWindowAt[h] = adverse;                         // null ⇒ "—", never a defaulted 0
      netWindowAt[h] = adverse == null ? null : grossWindow - adverse;             // ≤ grossWindow
      // per-day rates: amortise the observed adverse cost over the OBSERVED span (unknown if span is 0).
      costPerDayAt[h] = (adverse == null || !(spanDays > 0)) ? null : adverse / spanDays;
      netPerDayAt[h] = costPerDayAt[h] == null ? null : grossPerDay - costPerDayAt[h]; // ≤ grossPerDay
    }
    rows.push({
      marketId, pot, share, limDepthShares: limDepth, mid, spanHours, grossPerDay, grossWindow,
      fills: mos.length, costWindow: costWindowAt, netWindow: netWindowAt, costPerDay: costPerDayAt,
      netPerDay: netPerDayAt, missing: missingAt,
      // the venue minimum as it applied to THIS row (null when the caller did not supply one)
      minSizeShares: fin(minSize) ? minSize : null,
      sizePerSideShares,
      belowVenueMinSize,
      capitalToQualifyUsd: belowVenueMinSize ? capitalToQualify(mid, minSize, pairCostUsd) : null,
    });
  }
  // aggregate — a market whose net is UNKNOWN at a horizon is excluded from that horizon's totals AND
  // counted (unknownNet), never defaulted. net ≤ gross is preserved at the aggregate (each included net_i ≤
  // gross_i, and excluded markets still add to gross), so no basis can make aggregate net exceed gross.
  const H = ['1m', '5m', '30m'];
  const z = () => ({ '1m': 0, '5m': 0, '30m': 0 });
  const agg = {
    grossWindow: 0, grossPerDay: 0, fills: 0,
    costWindow: z(), netWindow: z(), costPerDay: z(), netPerDay: z(), unknownNet: z(), markets: rows.length,
  };
  for (const r of rows) {
    agg.grossWindow += r.grossWindow; agg.grossPerDay += r.grossPerDay; agg.fills += r.fills;
    for (const h of H) {
      if (r.netWindow[h] == null || r.netPerDay[h] == null) { agg.unknownNet[h]++; continue; } // excluded + counted
      agg.costWindow[h] += r.costWindow[h]; agg.netWindow[h] += r.netWindow[h];
      agg.costPerDay[h] += r.costPerDay[h]; agg.netPerDay[h] += r.netPerDay[h];
    }
  }
  return { rows, aggregate: agg, excluded };
}

module.exports = { computeNet, median };
