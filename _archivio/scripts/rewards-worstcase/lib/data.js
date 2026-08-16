'use strict';
// scripts/rewards-worstcase/lib/data.js — shared, READ-ONLY loader for the worst-case analysis. Loads the
// observed journal + tape over a window and the reward pots, and exposes the maps every phase consumes.
// Imports scripts/rewards-replay/lib/* and lib/* read-only; modifies nothing. Offline; no key, no order.

const fs = require('fs');
const { loadJournal } = require('../../rewards-replay/lib/journal');
const { loadTape } = require('../../rewards-replay/lib/tape');
const { coverageHeader } = require('../../../lib/mid-history-coverage');

// The frozen study window (the $5,000 backtest the task references: 10 markets, $100.98/day, 11 fills).
const DEFAULT_FROM = '2026-07-25T13:36:06.693Z';
const DEFAULT_TO = '2026-07-27T14:24:00.856Z';
const LIVE_UNIVERSE = 658; // collectable Polymarket reward markets (Gamma) — the TRUE coverage denominator

function loadPots(potsPath) {
  if (potsPath) {
    const snap = JSON.parse(fs.readFileSync(potsPath, 'utf8'));
    return { potByCond: new Map(Object.entries(snap.byCond).map(([c, o]) => [c, o.pot])), source: `snapshot ${snap.count} markets @ ${snap.fetchedAt}`, snap };
  }
  const { fetchRewardMarkets } = require('../../rewards-ceiling/lib/gamma');
  return fetchRewardMarkets().then(({ markets }) => ({
    potByCond: new Map(markets.map((m) => [m.conditionId, m.rewardsDailyRate])),
    source: `live Gamma ${markets.length} markets`, snap: null, markets,
  }));
}

// Load the collected window: journal (byMarket), tape (byToken), the YES-token map, coverage, ws/stale.
async function loadWindow({ from = DEFAULT_FROM, to = DEFAULT_TO, potsPath = null } = {}) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const tapeFull = loadTape({ fromMs, toMs });
  const winFrom = Math.max(fromMs, tapeFull.window.fromMs || -Infinity);
  const winTo = Math.min(toMs, tapeFull.window.toMs || Infinity);
  const J = loadJournal({ fromMs: winFrom, toMs: winTo });
  const tape = loadTape({ fromMs: winFrom, toMs: winTo });
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync('/root/prediction-market/data/mid-history-coverage.json', 'utf8')); } catch { /* unknown → partial */ }
  const cov = coverageHeader({ coveredMarketCount: J.byMarket.size, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  const truePct = Math.round((J.byMarket.size / LIVE_UNIVERSE) * 1000) / 10;

  const pots = await loadPots(potsPath);
  return {
    window: J.window, byMarket: J.byMarket, tapeByToken: tape.byToken, marketTokens,
    potByCond: pots.potByCond, potSource: pots.source,
    ws: J.ws, stale: J.stale, staleFrac: J.staleFrac,
    coverage: { ...cov, truePct, liveUniverse: LIVE_UNIVERSE },
  };
}

module.exports = { loadWindow, loadPots, DEFAULT_FROM, DEFAULT_TO, LIVE_UNIVERSE };
