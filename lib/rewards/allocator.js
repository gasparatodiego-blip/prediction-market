'use strict';
// lib/rewards/allocator.js — the ONE capital allocator, imported by BOTH the backtest
// (scripts/rewards-replay/allocate-run.js) and the UI (/dashboard/liquidity-rewards/allocate).
//
// It re-exports the measured knapsack allocator from scripts/rewards-replay/lib/allocate
// (perMarketNetCurve / knapsack / allocateBudget) — NEVER a second implementation, so the page and the
// backtest can never disagree — and adds a UI-facing planAllocation() that runs allocateBudget at the
// operator's capital and normalises each chosen market for display: allocated capital, per-side size in $
// and in shares, snapped bid/ask at the applied offset and the market's tick, the real in-band depth it was
// sized against, expected gross $/day, and net $/day ONLY where a real fill was observed (else null → "—").
//
// The allocation OBJECTIVE is the measured observed-window NET/day (what the backtest optimised); gross is
// reported per market but the choice of markets/sizes is the net-optimised knapsack, so the page reproduces
// the backtest to machine precision when run on the same inputs. This module reads no key, signs nothing,
// and constructs no order object.

const allocate = require('../../scripts/rewards-replay/lib/allocate');
const { snapToTick } = require('../../scripts/rewards-replay/lib/tape');
const { median } = require('../../scripts/rewards-replay/lib/net');
const { frontierByCount } = require('../../scripts/rewards-replay/lib/allocate-sweep');

const { allocateBudget } = allocate;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

// Per-market display facts from the journal rows — the SAME medians computeNet sizes against.
function marketMeta(rows, wsOnly = false) {
  const src = wsOnly ? rows.filter((r) => r.src === 'ws') : rows;
  const depthShares = median(src.map((r) => (fin(r.bidDepthInBand) && fin(r.askDepthInBand)) ? Math.min(r.bidDepthInBand, r.askDepthInBand) : null));
  const mid = median(src.map((r) => r.adjMid));
  const tick = rows[0] && fin(rows[0].tick) ? rows[0].tick : null;
  const spanHours = src.length >= 2 ? (src[src.length - 1].tsMs - src[0].tsMs) / 3_600_000 : 0;
  return { mid, tick, depthShares, spanHours };
}

/**
 * Plan an allocation of `budgetUsd` across the collected market set, for the UI.
 * @param cfg { byMarket, marketTokens, tapeByToken, potByCond, budgetUsd, unitUsd?, offsetCents?,
 *             maxInventoryUsd?, policy?, maxCount? }
 * @returns { budgetUsd, unitUsd, offsetCents, marketsUsed, totalCapital, unallocated, totalGrossPerDay,
 *            totalNetPerDay, frontier, rows:[{ marketId, capital, sizePerSideUsd, sizePerSideShares,
 *            snappedBid, snappedAsk, tick, offsetCents, depthShares, mid, spanHours, grossPerDay,
 *            netPerDay, fills, share }] }
 */
function planAllocation(cfg) {
  const {
    byMarket, marketTokens, tapeByToken, potByCond, budgetUsd,
    offsetCents = 1, maxInventoryUsd = 5000, policy = 'hold', maxCount = 25,
  } = cfg;
  // ~50 knapsack units keeps the knapsack fast and matches the backtest's granularity ($100 at $5,000,
  // $2 at $52). Never below $2 so a small balance still gets multiple discrete steps.
  const unitUsd = cfg.unitUsd || Math.max(2, Math.round(budgetUsd / 50));
  const alloc = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: budgetUsd, policy,
  });
  const F = frontierByCount(alloc.curves, Math.floor(budgetUsd / unitUsd), maxCount);

  const rows = alloc.allocation.map((a) => {
    const meta = marketMeta(byMarket.get(a.marketId) || []);
    const price = meta.mid != null ? clampPrice(meta.mid) : null;
    const snappedBid = (meta.mid != null && meta.tick) ? snapToTick(meta.mid - offsetCents / 100, meta.tick) : null;
    const snappedAsk = (meta.mid != null && meta.tick) ? snapToTick(meta.mid + offsetCents / 100, meta.tick) : null;
    const sizePerSideShares = (price != null && price > 0) ? a.sizeUsd / price : null;
    // NET is a real measured figure ONLY where a fill was actually observed; a 0-fill market has no measured
    // adverse selection, so its net renders "—" (never gross-as-net, never a number from an unknown).
    const netPerDay = (a.fills > 0 && fin(a.netPerDay5m)) ? a.netPerDay5m : null;
    return {
      marketId: a.marketId, capital: a.capital, sizePerSideUsd: a.sizeUsd, sizePerSideShares,
      snappedBid, snappedAsk, tick: meta.tick, offsetCents, depthShares: meta.depthShares, mid: meta.mid,
      spanHours: meta.spanHours, grossPerDay: fin(a.grossPerDay) ? a.grossPerDay : null, netPerDay,
      fills: a.fills, share: a.share,
    };
  });

  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalGrossPerDay = rows.reduce((s, r) => s + (fin(r.grossPerDay) ? r.grossPerDay : 0), 0);
  // Portfolio net stays "—" unless EVERY chosen market has a measured net — never sum an unknown as 0.
  const totalNetPerDay = rows.length && rows.every((r) => r.netPerDay != null)
    ? rows.reduce((s, r) => s + r.netPerDay, 0) : null;

  return {
    budgetUsd, unitUsd, offsetCents, marketsUsed: rows.length,
    totalCapital, unallocated: budgetUsd - totalCapital,
    totalGrossPerDay, totalNetPerDay, frontier: F.frontier, rows,
  };
}

module.exports = { ...allocate, planAllocation, marketMeta, frontierByCount };
