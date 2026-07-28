'use strict';
// scripts/rewards-worstcase/lib/daily.js — decompose an allocation's net into per-CALENDAR-DAY realised net
// over the observed window: gross accrues by span-overlap, cost is that day's real adverse fills. Also the
// worst single fill and per-market tails. Reuses the shipped fill/markout reconstruction read-only.
// Replay, not P&L. The window is ~2 days / 11 fills — a TINY daily sample; callers must say so.

const { reconstructTapeFillsForMarket } = require('../../rewards-replay/lib/tape');
const { markoutForFill } = require('../../rewards-replay/lib/markout');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// Calendar-day segments of [first,last] (UTC), each with its hours — for span-proportional gross accrual.
function dayOverlaps(first, last) {
  const out = [];
  let t = first;
  while (t < last) {
    const dayStart = Date.parse(new Date(t).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const dayEnd = dayStart + 86_400_000;
    const segEnd = Math.min(last, dayEnd);
    out.push({ dayKey: new Date(dayStart).toISOString().slice(0, 10), hours: (segEnd - t) / 3_600_000 });
    t = dayEnd;
  }
  return out;
}

/** mean, median, stdev, min, max of a numeric array (population stdev). Empty → nulls. */
function stats(xs) {
  const a = xs.filter(fin).sort((p, q) => p - q);
  if (!a.length) return { n: 0, mean: null, median: null, stdev: null, min: null, max: null };
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length;
  return { n: a.length, mean, median: a[Math.floor((a.length - 1) / 2)], stdev: Math.sqrt(variance), min: a[0], max: a[a.length - 1] };
}

/**
 * Per-calendar-day realised net for an allocation, plus the worst single fill and per-market net tails.
 * @param allocation [{ marketId, sizeUsd, grossPerDay, netPerDay5m|net5m, fills }]
 * @returns { days:[{dayKey, gross, adverse, net}], daily: stats, worstFill, worstMarket, bestMarket }
 */
function dailyNet(allocation, byMarket, marketTokens, tapeByToken, cfg = {}) {
  const { offsetCents = 1, maxInventoryUsd = 5000 } = cfg;
  const byDay = new Map(); // dayKey -> { gross, adverse }
  const bump = (dk, field, v) => { if (!byDay.has(dk)) byDay.set(dk, { gross: 0, adverse: 0 }); byDay.get(dk)[field] += v; };
  let worstFill = null;

  for (const a of allocation) {
    const rows = byMarket.get(a.marketId) || [];
    if (!rows.length || !fin(a.grossPerDay)) continue;
    // gross accrues over the observed span, proportional to each day's overlap hours
    for (const seg of dayOverlaps(rows[0].tsMs, rows[rows.length - 1].tsMs)) bump(seg.dayKey, 'gross', a.grossPerDay * seg.hours / 24);
    // cost = real adverse fills, bucketed by the fill's day (favorable markout floored to 0, never booked)
    const trades = (marketTokens.get(a.marketId) && tapeByToken.get(marketTokens.get(a.marketId))) || [];
    const fills = reconstructTapeFillsForMarket(rows, trades, { offsetCents, sizeUsd: a.sizeUsd, maxInventoryUsd }).fills;
    for (const f of fills) {
      const h5 = markoutForFill(f, rows).horizons['5m'];
      if (!h5 || !fin(h5.usd)) continue;
      bump(new Date(f.tsMs).toISOString().slice(0, 10), 'adverse', Math.max(0, -h5.usd));
      if (worstFill == null || h5.usd < worstFill.usd) worstFill = { marketId: a.marketId, usd: h5.usd, cents: h5.cents, tsMs: f.tsMs };
    }
  }

  const days = [...byDay.entries()].map(([dayKey, v]) => ({ dayKey, gross: v.gross, adverse: v.adverse, net: v.gross - v.adverse }))
    .sort((x, y) => x.dayKey.localeCompare(y.dayKey));
  const perMarketNet = allocation.map((a) => ({ marketId: a.marketId, net: fin(a.netPerDay5m) ? a.netPerDay5m : (fin(a.net5m) ? a.net5m : null) })).filter((r) => r.net != null);
  const worstMarket = perMarketNet.reduce((w, r) => (w == null || r.net < w.net ? r : w), null);
  const bestMarket = perMarketNet.reduce((b, r) => (b == null || r.net > b.net ? r : b), null);

  return { days, daily: stats(days.map((d) => d.net)), worstFill, worstMarket, bestMarket };
}

module.exports = { dailyNet, dayOverlaps, stats };
