'use strict';
// lib/maker/universe.js — resolve the maker's quoting universe from the SELECTION + the live rewards
// markets, using the SAME filter functions the board uses (lib/rewards-server-filter). This is the ONLY
// place the resolution math lives: agent35 AND the selection API both call it, so the bot's set and the
// board's set are derived from ONE code path and can never silently diverge. Node-requirable (CommonJS).

const { parseRewardFilters, applyRewardFilters } = require('../rewards-server-filter');

// A resolved reward market is dropped once its resolution time is in the past — the SAME lifecycle drop
// the board applies (app/api/rewards-unified). Pure; shared so board and bot use one predicate.
function isResolved(m) {
  return typeof m?.hoursToResolution === 'number' && Number.isFinite(m.hoursToResolution) && m.hoursToResolution <= 0;
}
function dropResolvedRewards(markets) {
  return (Array.isArray(markets) ? markets : []).filter((m) => !isResolved(m));
}

function poolOf(m) {
  const p = m && m.dailyPool;
  return typeof p === 'number' && Number.isFinite(p) ? p : -Infinity; // unknown pool sorts last
}

/**
 * Resolve the universe. Returns the market SET the bot quotes + truncation facts.
 * @param {Array}  rawMarkets  markets from /tmp/liquidity-rewards.json (data.markets)
 * @param {object} selection   normalized selection (lib/maker/selection)
 */
function resolveMakerUniverse(rawMarkets, selection) {
  const sel = selection || {};
  const venues = Array.isArray(sel.venues) && sel.venues.length ? sel.venues : ['polymarket'];
  const allow = new Set((sel.allowlist || []).map(String));
  const deny = new Set((sel.denylist || []).map(String));
  const maxMarkets = Number.isFinite(sel.maxMarkets) && sel.maxMarkets > 0 ? sel.maxMarkets : 5;

  const eligible = dropResolvedRewards(rawMarkets);
  const f = parseRewardFilters(sel.filters || {});
  // The SAME six filters the board applies (shared module — no second implementation).
  let set = applyRewardFilters(eligible, f);
  // Hard venue restriction (default Polymarket only).
  set = set.filter((m) => venues.includes(m.venue));
  // Allowlist: force-in eligible markets on an allowed venue that the filters excluded.
  const have = new Set(set.map((m) => m.marketId));
  for (const m of eligible) {
    if (allow.has(String(m.marketId)) && venues.includes(m.venue) && !have.has(m.marketId)) {
      set.push(m);
      have.add(m.marketId);
    }
  }
  // Denylist: force-out.
  set = set.filter((m) => !deny.has(String(m.marketId)));
  // Deterministic order, ALLOWLIST FIRST: an allowlisted market is an explicit operator instruction
  // ("quote this one"), so it must not be pushed out of the cap by a filter-matched market that merely
  // happens to have a bigger pot. Without this, force-in silently loses to truncation and a market the
  // operator just added reads as "not in the bot's list". Within each group: daily pot desc, then
  // marketId for a stable cut.
  set.sort((a, b) =>
    (Number(allow.has(String(b.marketId))) - Number(allow.has(String(a.marketId))))
    || (poolOf(b) - poolOf(a))
    || String(a.marketId).localeCompare(String(b.marketId)));

  const matchedBeforeCap = set.length;
  const truncated = matchedBeforeCap > maxMarkets;
  const resolvedMarkets = truncated ? set.slice(0, maxMarkets) : set;
  return {
    resolvedMarketIds: resolvedMarkets.map((m) => m.marketId),
    resolvedMarkets,
    matchedBeforeCap,
    truncated,
    maxMarkets,
  };
}

module.exports = { resolveMakerUniverse, dropResolvedRewards, isResolved };
