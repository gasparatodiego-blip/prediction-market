'use strict';
// lib/maker/risk-rails.js — PURE core for the maker's risk rails (Phase 6). Given the engine's current
// state + the resolved config + the live market state, decide which rails have TRIPPED and what the
// engine must do (halt this market and cancel, or halt everything and cancel all). No I/O, no Date —
// the engine supplies `now` and the measured state; this returns decisions the engine executes.
//
// These rails were previously rejected because nothing executed; now that placement exists they are all
// REQUIRED. Every rail is independent and fail-safe: on missing/uncertain data a rail that protects
// capital trips CLOSED (halts), never open. Adverse selection (a market moving against resting quotes)
// is a reward-farmer's main tail risk, so the market-state / staleness / news rails halt-and-cancel
// rather than widen — the poly-maker "EVENT/HALTED → pull quotes" pattern, adopted.
//
// Rail actions:
//   'halt-all'    — cancel every resting order on every market and stand the engine down (kill switches)
//   'halt-market' — cancel this market's resting orders and quote nothing there until the cause clears
//   'block-new'   — keep existing quotes but place no NEW/larger exposure (a cap is reached, not breached)

// ── GLOBAL rails (engine-wide). state: { dailyPnlUsd, totalExposureUsd, recentErrorCount } ──
function evaluateGlobalRails({ state, config }) {
  const trips = [];
  const R = config.rails;
  if (config.killSwitch) trips.push({ rail: 'manual-kill', tripped: true, action: 'halt-all', detail: 'MAKER_KILL=true' });
  if (state.dailyPnlUsd != null && R.dailyLossLimitUsd > 0 && state.dailyPnlUsd <= -R.dailyLossLimitUsd)
    trips.push({ rail: 'daily-loss', tripped: true, action: 'halt-all', detail: `realised+unrealised P&L $${state.dailyPnlUsd.toFixed(2)} ≤ −$${R.dailyLossLimitUsd}` });
  if (state.recentErrorCount != null && R.errorRateMax > 0 && state.recentErrorCount >= R.errorRateMax)
    trips.push({ rail: 'error-rate', tripped: true, action: 'halt-all', detail: `${state.recentErrorCount} venue errors in ${R.errorRateWindowMs}ms ≥ ${R.errorRateMax} — halting rather than retrying into a wall` });
  if (state.totalExposureUsd != null && R.totalExposureCapUsd > 0 && state.totalExposureUsd >= R.totalExposureCapUsd)
    trips.push({ rail: 'total-exposure', tripped: true, action: 'block-new', detail: `total exposure $${state.totalExposureUsd.toFixed(2)} ≥ cap $${R.totalExposureCapUsd}` });
  const haltAll = trips.some(t => t.action === 'halt-all');
  return { trips, haltAll, blockNew: trips.some(t => t.action === 'block-new') };
}

// ── PER-MARKET rails. market: { feedLive, resolved, closed, structurallyDegenerate, newsSeverity,
//    marketNotionalUsd, positionUsd } ──
function evaluateMarketRails({ market, config }) {
  const trips = [];
  const R = config.rails;
  // Feed staleness: NEVER quote from the REST fallback. A non-live book → stand this market down.
  if (market.feedLive !== true) trips.push({ rail: 'feed-stale', tripped: true, action: 'halt-market', detail: 'live book is STALE/absent — standing down (never quote off the REST fallback)' });
  // Market state: resolved / closed / structurally degenerate (structural-baseline gate) → exclude.
  if (market.resolved === true) trips.push({ rail: 'market-resolved', tripped: true, action: 'halt-market', detail: 'market resolved' });
  if (market.closed === true) trips.push({ rail: 'market-closed', tripped: true, action: 'halt-market', detail: 'market closed' });
  if (market.structurallyDegenerate === true) trips.push({ rail: 'market-structural', tripped: true, action: 'halt-market', detail: 'structurally degenerate (structural-baseline gate) — one-sided-by-construction, no two-sided band' });
  // News: a HIGH-severity news-guard signal on this market → halt + cancel (reuse the existing rails).
  if (market.newsSeverity === 'high') trips.push({ rail: 'news-high', tripped: true, action: 'halt-market', detail: 'high-severity news-guard signal — halting quoting on this market' });
  // Caps: reached (not breached) → place no new/larger exposure here, keep existing quotes.
  if (market.marketNotionalUsd != null && R.perMarketNotionalCapUsd > 0 && market.marketNotionalUsd >= R.perMarketNotionalCapUsd)
    trips.push({ rail: 'market-notional', tripped: true, action: 'block-new', detail: `market notional $${market.marketNotionalUsd.toFixed(2)} ≥ cap $${R.perMarketNotionalCapUsd}` });
  if (market.positionUsd != null && R.perMarketPositionCapUsd > 0 && Math.abs(market.positionUsd) >= R.perMarketPositionCapUsd)
    trips.push({ rail: 'market-position', tripped: true, action: 'block-new', detail: `position $${market.positionUsd.toFixed(2)} ≥ limit $${R.perMarketPositionCapUsd}` });
  const haltMarket = trips.some(t => t.action === 'halt-market');
  return { trips, haltMarket, blockNew: trips.some(t => t.action === 'block-new') };
}

/**
 * Full evaluation for one market in the current engine state. Returns the merged decision the engine
 * acts on: cancel scope + whether new placement is allowed here.
 */
function evaluateRails({ globalState, market, config }) {
  const g = evaluateGlobalRails({ state: globalState, config });
  const m = evaluateMarketRails({ market, config });
  const halt = g.haltAll || m.haltMarket;
  return {
    trips: [...g.trips, ...m.trips],
    haltAll: g.haltAll,
    haltMarket: m.haltMarket,
    // Cancel scope the engine must enforce right now.
    cancelScope: g.haltAll ? 'all' : m.haltMarket ? 'market' : 'none',
    // May the engine place a new or larger quote on this market this tick?
    allowNewPlacement: !halt && !g.blockNew && !m.blockNew,
  };
}

module.exports = { evaluateRails, evaluateGlobalRails, evaluateMarketRails };
