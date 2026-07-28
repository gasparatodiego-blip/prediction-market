#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/allocate-run.js — RECOMPUTE the rewards NET replay under a HARD TOTAL-CAPITAL
// budget shared across markets, instead of the base replay's "fund every market at $size/side at once"
// assumption. Offline; places/signs/decrypts nothing. Honest-engine intact: replay (not realised P&L),
// coverage header from the shared helper, ws/stale reported, refusal to annualise under 48h, APY_CAP +
// run-rate label, nulls excluded+counted.
//
//   node allocate-run.js --from ISO --to ISO [--pots snapshot.json] [--budget 5000] [--size 1000]
//                        [--offset 1] [--max-inventory 5000] [--unit N]
//
// It prints, over the SAME window:
//   • BASELINE — every fundable market at $size/side (the base replay's config) and its implied denominator
//   • BUDGET   — the optimal split of --budget across markets (multiple-choice knapsack on NET), annualised
//   • the NON-LINEARITY proof: budget-net ≠ baseline-net ÷ (baselineCapital/budget), with the direction
// A frozen --pots snapshot keeps gross apples-to-apples across configs (the live pot drifts day to day).

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { loadTape } = require('./lib/tape');
const { coverageHeader } = require('../../lib/mid-history-coverage');
const { perMarketNetAtSize, allocateBudget } = require('./lib/allocate');

const MIN_WINDOW_HOURS = 48;
const STALE_UNTRUST = 0.20;
const RISK_FREE_PCT = 4.0;
const APY_CAP = 200;
const OUT = '/tmp/rewards-replay/allocate-summary.json';

function parseArgs(argv) {
  const a = { from: null, to: null, pots: null, budget: 5000, size: 1000, offset: 1, maxInventory: 5000, unit: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--from') { a.from = v; i++; }
    else if (k === '--to') { a.to = v; i++; }
    else if (k === '--pots') { a.pots = v; i++; }
    else if (k === '--budget') { a.budget = Number(v); i++; }
    else if (k === '--size') { a.size = Number(v); i++; }
    else if (k === '--offset') { a.offset = Number(v); i++; }
    else if (k === '--max-inventory') { a.maxInventory = Number(v); i++; }
    else if (k === '--unit') { a.unit = Number(v); i++; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const pct = (x) => (x == null ? '—' : (x > APY_CAP ? `>${APY_CAP}%/yr · run-rate, not guaranteed` : x.toFixed(2) + '%/yr'));

// annualised NET %, honest: refuse under 48h, run-rate label handled by pct().
function annualise(net5m, windowHours, capital) {
  if (!(windowHours >= MIN_WINDOW_HOURS) || !(capital > 0)) return null;
  const netPerDay = net5m / (windowHours / 24);
  return (netPerDay * 365 / capital) * 100;
}

async function loadPots(args) {
  if (args.pots) {
    const snap = JSON.parse(fs.readFileSync(args.pots, 'utf8'));
    const m = new Map();
    for (const [cond, o] of Object.entries(snap.byCond)) m.set(cond, o.pot);
    return { potByCond: m, source: `snapshot ${path.basename(args.pots)} (${snap.count} markets, fetched ${snap.fetchedAt})` };
  }
  const { fetchRewardMarkets } = require('../rewards-ceiling/lib/gamma');
  const { markets } = await fetchRewardMarkets();
  return { potByCond: new Map(markets.map((m) => [m.conditionId, m.rewardsDailyRate])), source: `live Gamma (${markets.length} markets)` };
}

async function main() {
  const args = parseArgs(process.argv);
  const fromMs = args.from ? Date.parse(args.from) : -Infinity;
  const toMs = args.to ? Date.parse(args.to) : Infinity;
  // fills only exist where the tape covers → window = overlap of journal and tape (as run.js does).
  const tapeFull = loadTape({ fromMs, toMs });
  const winFrom = Math.max(fromMs, tapeFull.window.fromMs || -Infinity);
  const winTo = Math.min(toMs, tapeFull.window.toMs || Infinity);
  const J = loadJournal({ fromMs: winFrom, toMs: winTo });
  const tape = loadTape({ fromMs: winFrom, toMs: winTo });
  const windowHours = J.window.hours;

  console.log('═'.repeat(78));
  console.log('REWARDS NET — TOTAL-CAPITAL BUDGET ALLOCATED ACROSS MARKETS (offline replay; maker disarmed)');
  console.log('═'.repeat(78));
  console.log('window:', new Date(J.window.fromMs).toISOString(), '→', new Date(J.window.toMs).toISOString(), `(${windowHours.toFixed(3)}h)`);
  console.log('journal rows:', J.rows, '| markets:', J.byMarket.size, '| ws', J.ws, 'stale', J.stale,
    `(${(J.staleFrac * 100).toFixed(1)}%${J.staleFrac > STALE_UNTRUST ? ' ⚠ >20% NOT trustworthy' : ''})`);

  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);

  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'mid-history-coverage.json'), 'utf8')); } catch {}
  const cov = coverageHeader({ coveredMarketCount: J.byMarket.size, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  console.log('\nCOVERAGE:'); for (const l of cov.headerLines) console.log('  ' + l);

  const { potByCond, source } = await loadPots(args);
  console.log('\npots:', source);

  const unit = args.unit || (args.budget <= 200 ? 2 : 100);
  console.log(`PLACEMENT: offset ${args.offset}¢ both sides · baseline size $${args.size}/side · max inventory $${args.maxInventory} · knapsack unit $${unit} capital`);

  // ── BASELINE: fund every fundable market at $size/side (the base replay's config) ──
  let baseGross = 0, baseCost = 0, baseNet = 0, baseMarkets = 0;
  for (const [marketId, rows] of J.byMarket.entries()) {
    const trades = (marketTokens.get(marketId) && tape.byToken.get(marketTokens.get(marketId))) || [];
    const r = perMarketNetAtSize(marketId, rows, trades, potByCond, { offsetCents: args.offset, sizeUsd: args.size, maxInventoryUsd: args.maxInventory }, windowHours);
    if (r.excluded) continue;
    baseMarkets++; baseGross += r.gross; baseCost += r.cost5m; baseNet += r.net5m;
  }
  const baseCapital = baseMarkets * 2 * args.size;
  const baseAnnual = annualise(baseNet, windowHours, baseCapital);
  console.log('\n' + '─'.repeat(78));
  console.log(`BASELINE (every market at $${args.size}/side — the base replay's assumption):`);
  console.log(`  fundable markets ${baseMarkets} · IMPLIED CAPITAL = ${baseMarkets} × 2 × $${args.size} = ${money(baseCapital)}`);
  console.log(`  gross ${money(baseGross)} · cost(+5m) ${money(baseCost)} · NET(+5m) ${money(baseNet)}  over ${windowHours.toFixed(2)}h`);
  console.log(`  annualised NET on ${money(baseCapital)}: ${pct(baseAnnual)}  vs ~${RISK_FREE_PCT}% risk-free: ${baseAnnual > RISK_FREE_PCT ? 'CLEARS' : 'FAILS'}`);

  // ── BUDGET: optimal split of --budget across markets ──
  const alloc = allocateBudget(J.byMarket, marketTokens, tape.byToken, potByCond,
    { offsetCents: args.offset, maxInventoryUsd: args.maxInventory, windowHours, budgetUsd: args.budget, unitUsd: unit, maxPerMarketUsd: args.budget });
  const budgetCapitalUsed = alloc.usedUnits * unit;
  const budgetAnnual = annualise(alloc.totalNet5m, windowHours, args.budget);
  console.log('\n' + '─'.repeat(78));
  console.log(`BUDGET = ${money(args.budget)} allocated across markets (multiple-choice knapsack on NET(+5m)):`);
  console.log(`  markets held ${alloc.marketsHeld} · capital deployed ${money(budgetCapitalUsed)} of ${money(args.budget)} (idle ${money(args.budget - budgetCapitalUsed)})`);
  console.log(`  gross ${money(alloc.grossWindow)} · cost(+5m) ${money(alloc.cost5mWindow)} · NET(+5m) ${money(alloc.totalNet5m)}  over ${windowHours.toFixed(2)}h`);
  console.log(`  annualised NET on ${money(args.budget)}: ${pct(budgetAnnual)}  vs ~${RISK_FREE_PCT}% risk-free: ${budgetAnnual > RISK_FREE_PCT ? 'CLEARS' : 'FAILS'}`);
  console.log('  top holdings (by NET):');
  for (const a of [...alloc.allocation].sort((x, y) => y.net5m - x.net5m).slice(0, 8)) {
    console.log(`    ${a.marketId.slice(0, 14)}…  $${a.sizeUsd}/side (cap ${money(a.capital)}) · gross ${money(a.gross)} · cost ${money(a.cost5m)} · NET ${money(a.net5m)} · ${a.fills} fills · share ${(a.share * 100).toFixed(1)}%`);
  }

  // ── NON-LINEARITY: budget-net vs naive scaling of the baseline ──
  const scaleFactor = baseCapital / args.budget;
  const naiveScaled = baseNet / scaleFactor;
  console.log('\n' + '─'.repeat(78));
  console.log('NON-LINEARITY (the reward share s/(s+cQ) is concave in size, so nets do NOT scale):');
  console.log(`  baseline NET ${money(baseNet)} on ${money(baseCapital)} ÷ ${scaleFactor.toFixed(1)} (= ${money(baseCapital)}/${money(args.budget)}) = ${money(naiveScaled)}  ← NAIVE, WRONG`);
  console.log(`  actual ${money(args.budget)} NET (recomputed from the journal) = ${money(alloc.totalNet5m)}`);
  const ratio = naiveScaled !== 0 ? alloc.totalNet5m / naiveScaled : null;
  console.log(`  → the ${money(args.budget)} result is ${ratio ? ratio.toFixed(2) + '×' : '—'} the naive scaling; direction: concentrating a small budget in the BEST markets, kept in the near-linear low-capital regime, earns ${ratio > 1 ? 'MORE' : 'LESS'} net per dollar than the blended big-denominator config.`);

  const out = {
    generatedAt: new Date(J.window.toMs).toISOString(), window: J.window, potSource: source, staleFrac: J.staleFrac, coverage: cov,
    placement: { offset: args.offset, size: args.size, maxInventory: args.maxInventory, unit },
    baseline: { markets: baseMarkets, capital: baseCapital, gross: baseGross, cost5m: baseCost, net5m: baseNet, annualPct: baseAnnual },
    budget: { budgetUsd: args.budget, marketsHeld: alloc.marketsHeld, capitalUsed: budgetCapitalUsed, gross: alloc.grossWindow, cost5m: alloc.cost5mWindow, net5m: alloc.totalNet5m, annualPct: budgetAnnual, allocation: alloc.allocation },
    nonLinearity: { baseNet, baseCapital, scaleFactor, naiveScaled, actual: alloc.totalNet5m, ratio },
  };
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 0)); console.log('\nwrote', OUT); } catch (e) { console.error('json write failed:', e.message); }
}

main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
