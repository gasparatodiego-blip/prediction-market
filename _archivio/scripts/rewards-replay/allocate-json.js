#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/allocate-json.js — emit the capital-allocation PLAN as JSON on stdout, for the
// /api/rewards/allocate route to spawn. Runs in plain node (no webpack), so the shared allocator's CJS
// chain (which uses dynamic requires) loads correctly, and the heavy journal load is freed when this
// process exits. PLAN-ONLY: reads no key, signs nothing, constructs no order object.
//
//   node allocate-json.js --capital 5000 [--from ISO --to ISO] [--pots snapshot.json]
//
// Pots + market names/categories come from agent24's Gamma-sourced board snapshot (data/liquidity-rewards
// .json) unless --pots overrides them (used by the equality proof to pin the frozen snapshot).

const fs = require('fs');
const path = require('path');
const { planAllocation } = require('../../lib/rewards/allocator');
const { loadJournal } = require('./lib/journal');
const { loadTape } = require('./lib/tape');
const { coverageHeader } = require('../../lib/mid-history-coverage');

const ROOT = path.join(__dirname, '..', '..');
const REWARDS_FILE = path.join(ROOT, 'data', 'liquidity-rewards.json');
const WINDOW_MS = 48 * 3_600_000;
const LIVE_UNIVERSE = 658;
const APY_CAP = 200;

function parseArgs(argv) {
  const a = { capital: 0, from: null, to: null, pots: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--capital') { a.capital = Number(v); i++; }
    else if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--pots') { a.pots = v; i++; }
  }
  return a;
}

function loadBoard() {
  const board = JSON.parse(fs.readFileSync(REWARDS_FILE, 'utf8'));
  const nameMap = new Map(), potByCond = new Map();
  for (const m of board.markets || []) {
    if (!m.conditionId) continue;
    const pot = Number(m.rewardsDailyRate);
    if (Number.isFinite(pot) && pot > 0) potByCond.set(m.conditionId, pot);
    nameMap.set(m.conditionId, { question: m.question ?? null, category: m.category ?? null });
  }
  return { nameMap, potByCond };
}

function identify(nameMap, marketId) {
  const m = nameMap.get(marketId);
  const question = m && typeof m.question === 'string' && m.question.trim() ? m.question : null;
  return {
    name: question,
    category: m && typeof m.category === 'string' && m.category.trim() ? m.category : null,
    nameAvailable: question != null,
    shortId: marketId.slice(0, 10) + '…' + marketId.slice(-4),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const capital = Number.isFinite(args.capital) && args.capital > 0 ? args.capital : 0;

  const { nameMap, potByCond: boardPots } = loadBoard();
  let potByCond = boardPots;
  if (args.pots) { // equality-proof / test override
    const snap = JSON.parse(fs.readFileSync(args.pots, 'utf8'));
    potByCond = new Map(Object.entries(snap.byCond).map(([c, o]) => [c, o.pot]));
  }

  // recent window of collected data (or the pinned window when --from/--to given). The live path uses a
  // wall-clock 48h window (agent34 is collecting now) — no redundant full-span tape read.
  const nowMs = Date.now();
  const toMs = args.to ? Date.parse(args.to) : nowMs;
  const fromMs = args.from ? Date.parse(args.from) : toMs - WINDOW_MS;
  const J = loadJournal({ fromMs, toMs });
  const tape = loadTape({ fromMs, toMs });
  for (const rows of J.byMarket.values()) for (const r of rows) r.levels = undefined; // free the ladders (unused by HOLD)
  const coveredMarketCount = J.byMarket.size; // coverage = ALL collected markets, before the pot pre-filter
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  // Build curves ONLY for markets that currently carry a pot — skips wasted fill reconstruction for the rest
  // (they would be excluded by computeNet anyway). Coverage above already counted the full collected set.
  const fundable = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (potByCond.has(mid)) fundable.set(mid, rows);

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mid-history-coverage.json'), 'utf8')); } catch { /* unknown → partial */ }
  const cov = coverageHeader({ coveredMarketCount, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  const truePct = Math.round((coveredMarketCount / LIVE_UNIVERSE) * 1000) / 10;

  const plan = capital > 0
    ? planAllocation({ byMarket: fundable, marketTokens, tapeByToken: tape.byToken, potByCond, budgetUsd: capital, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxCount: 25 })
    : { budgetUsd: 0, unitUsd: 0, offsetCents: 1, marketsUsed: 0, totalCapital: 0, unallocated: 0, totalGrossPerDay: 0, totalNetPerDay: null, frontier: [], rows: [] };

  const rows = plan.rows.map((r) => ({ ...r, ...identify(nameMap, r.marketId) }));
  const annPct = capital > 0 && plan.totalGrossPerDay >= 0 ? (plan.totalGrossPerDay * 365 / capital) * 100 : null;

  const body = {
    generatedAt: new Date(J.window.toMs || Date.now()).toISOString(),
    requested: args.capital, capital, unit: plan.unitUsd, offsetCents: plan.offsetCents,
    window: J.window, staleFrac: J.staleFrac,
    coverage: {
      coveredMarketCount: cov.coveredMarketCount, manifestUniverse: cov.universeMarketCount, truePct, partial: true,
      headerLines: cov.headerLines,
      trueNote: `COVERAGE VERA: ${cov.coveredMarketCount} di ${LIVE_UNIVERSE} mercati reward collezionabili (Gamma) ≈ ${truePct}% — copertura PARZIALE, non il 109-113% del manifest.`,
    },
    rows,
    totals: { capital: plan.totalCapital, unallocated: plan.unallocated, grossPerDay: plan.totalGrossPerDay, netPerDay: plan.totalNetPerDay, count: plan.marketsUsed },
    annualisedGross: { pct: annPct, capped: annPct != null && annPct > APY_CAP, cap: APY_CAP, label: 'lordo (adverse selection misurata a parte), run-rate, non garantito' },
    frontier: plan.frontier,
  };
  process.stdout.write(JSON.stringify(body));
}

module.exports = { identify }; // exported for the selfcheck; the CLI still runs on direct invocation
if (require.main === module) main();
