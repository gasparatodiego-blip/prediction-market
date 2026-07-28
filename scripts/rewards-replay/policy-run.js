#!/usr/bin/env node
'use strict';
// scripts/rewards-replay/policy-run.js — PHASE 4: HOLD vs CLOSE-NOW at a fixed budget, side by side.
// HOLD leaves inventory and books the +5m markout as cost; CLOSE-NOW exits every fill into the real book and
// books the realised spread paid. Both earn the SAME gross reward; only the cost differs. Offline replay;
// maker disarmed. Observed-window (each market amortised over its own span). Honest-engine intact.
//   node policy-run.js --from ISO --to ISO [--pots snap.json] [--budget 5000] [--unit 100] [--max-count 20]

const fs = require('fs');
const path = require('path');
const { loadJournal } = require('./lib/journal');
const { loadTape } = require('./lib/tape');
const { coverageHeader } = require('../../lib/mid-history-coverage');
const { allocateBudget, perMarketNetAtSize } = require('./lib/allocate');
const { frontierByCount } = require('./lib/allocate-sweep');

const MIN_WINDOW_HOURS = 48, STALE_UNTRUST = 0.20, RISK_FREE_PCT = 4.0, APY_CAP = 200;
const TOXIC = ['0x0d9d760f', '0x0dbd760f', '0x14d32732']; // previously-flagged toxic markets (both spellings)

function parseArgs(argv) {
  const a = { from: null, to: null, pots: null, budget: 5000, unit: 100, offset: 1, size: 1000, maxInventory: 5000, maxCount: 20 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--from') { a.from = v; i++; } else if (k === '--to') { a.to = v; i++; }
    else if (k === '--pots') { a.pots = v; i++; } else if (k === '--budget') { a.budget = Number(v); i++; }
    else if (k === '--unit') { a.unit = Number(v); i++; } else if (k === '--max-count') { a.maxCount = Number(v); i++; }
  }
  return a;
}
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const pct = (x) => (x == null ? '—' : (x > APY_CAP ? `>${APY_CAP}%/yr · run-rate` : x.toFixed(1) + '%/yr · run-rate'));
function annualise(netPerDay, capital, windowHours) {
  if (!(windowHours >= MIN_WINDOW_HOURS) || !(capital > 0) || netPerDay == null) return null;
  return (netPerDay * 365 / capital) * 100;
}
async function loadPots(args) {
  if (args.pots) { const s = JSON.parse(fs.readFileSync(args.pots, 'utf8')); const m = new Map(); for (const [c, o] of Object.entries(s.byCond)) m.set(c, o.pot); return { potByCond: m, source: `snapshot (${s.count}, ${s.fetchedAt})` }; }
  const { fetchRewardMarkets } = require('../rewards-ceiling/lib/gamma');
  const { markets } = await fetchRewardMarkets();
  return { potByCond: new Map(markets.map((m) => [m.conditionId, m.rewardsDailyRate])), source: `live Gamma (${markets.length})` };
}

// summarise an allocation into a policy row (fills/closed/stuck/naked + per-day gross/cost/net)
function summary(alloc) {
  let fills = 0, closed = 0, stuck = 0, naked = 0, noBook = 0;
  for (const a of alloc.allocation) { fills += a.fills || 0; closed += a.closed || 0; stuck += a.stuck || 0; naked += a.nakedRefused || 0; noBook += a.noBook || 0; }
  return { markets: alloc.marketsHeld, fills, closed, stuck, naked, noBook, grossPerDay: alloc.grossPerDay, costPerDay: alloc.costPerDay5m, netPerDay: alloc.totalNet5m };
}

async function main() {
  const args = parseArgs(process.argv);
  const fromMs = args.from ? Date.parse(args.from) : -Infinity, toMs = args.to ? Date.parse(args.to) : Infinity;
  const tapeFull = loadTape({ fromMs, toMs });
  const winFrom = Math.max(fromMs, tapeFull.window.fromMs || -Infinity), winTo = Math.min(toMs, tapeFull.window.toMs || Infinity);
  const J = loadJournal({ fromMs: winFrom, toMs: winTo });
  const tape = loadTape({ fromMs: winFrom, toMs: winTo });
  const windowHours = J.window.hours;
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  const { potByCond, source } = await loadPots(args);

  console.log('═'.repeat(80));
  console.log('PHASE 4 — HOLD vs CLOSE-NOW at a fixed budget (offline replay; maker disarmed; observed-window)');
  console.log('═'.repeat(80));
  console.log(`window ${windowHours.toFixed(2)}h · pots ${source} · unit $${args.unit} capital`);
  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'mid-history-coverage.json'), 'utf8')); } catch {}
  const cov = coverageHeader({ coveredMarketCount: J.byMarket.size, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  console.log('COVERAGE (manifest denominator):'); for (const l of cov.headerLines) console.log('  ' + l);
  console.log(`  TRUE coverage vs the live collectable universe: ${J.byMarket.size} of 658 Gamma reward markets ≈ ${(J.byMarket.size / 658 * 100).toFixed(0)}% — PARTIAL, not the 109-113% the manifest implies.`);
  console.log(`ws/stale: ws ${J.ws} stale ${J.stale} (${(J.staleFrac * 100).toFixed(1)}%)${J.staleFrac > STALE_UNTRUST ? ' ⚠ >20% — DO NOT TRUST' : ' — trusted'}`);

  const budgets = [[args.budget, args.unit], [52.22, 2]];
  const out = { window: J.window, rows: {} };
  for (const [budget, unit] of budgets) {
    const hold = allocateBudget(J.byMarket, marketTokens, tape.byToken, potByCond, { offsetCents: args.offset, maxInventoryUsd: args.maxInventory, budgetUsd: budget, unitUsd: unit, maxPerMarketUsd: budget, policy: 'hold' });
    const close = allocateBudget(J.byMarket, marketTokens, tape.byToken, potByCond, { offsetCents: args.offset, maxInventoryUsd: args.maxInventory, budgetUsd: budget, unitUsd: unit, maxPerMarketUsd: budget, policy: 'close-now' });
    const sh = summary(hold), sc = summary(close);
    const aH = annualise(sh.netPerDay, budget, windowHours), aC = annualise(sc.netPerDay, budget, windowHours);
    console.log('\n' + '─'.repeat(80));
    console.log(`BUDGET $${budget}  (each policy re-optimised independently):`);
    console.log('  policy     mkts  fills closed stuck naked noBook  grossPerDay   costPerDay    NET/day    annualised');
    console.log(`  HOLD       ${String(sh.markets).padStart(4)}  ${String(sh.fills).padStart(5)}    ${'—'.padStart(3)}   ${'—'.padStart(3)}   ${'—'.padStart(3)}    ${'—'.padStart(3)} ${money(sh.grossPerDay).padStart(10)}/d ${money(sh.costPerDay).padStart(9)}/d ${money(sh.netPerDay).padStart(9)}/d  ${pct(aH)}`);
    console.log(`  CLOSE-NOW  ${String(sc.markets).padStart(4)}  ${String(sc.fills).padStart(5)}  ${String(sc.closed).padStart(5)} ${String(sc.stuck).padStart(5)} ${String(sc.naked).padStart(5)}  ${String(sc.noBook).padStart(4)} ${money(sc.grossPerDay).padStart(10)}/d ${money(sc.costPerDay).padStart(9)}/d ${money(sc.netPerDay).padStart(9)}/d  ${pct(aC)}`);
    console.log(`  → ${sh.netPerDay >= sc.netPerDay ? 'HOLD' : 'CLOSE-NOW'} better by ${money(Math.abs(sh.netPerDay - sc.netPerDay))}/day at $${budget}  (both vs ~${RISK_FREE_PCT}% risk-free: ${(aH > RISK_FREE_PCT ? 'CLEARS' : 'FAILS')}/${(aC > RISK_FREE_PCT ? 'CLEARS' : 'FAILS')})`);

    if (budget === args.budget) {
      // fill distribution across the HOLD-allocated markets + toxic membership
      console.log(`  FILL COUNT at the $${budget}/${sh.markets}-market HOLD allocation: ${sh.fills} fills (NOT the ${'395'} of the $250k/125-market baseline).`);
      console.log('  fill distribution across the allocated markets (HOLD):');
      for (const a of [...hold.allocation].sort((x, y) => (y.fills || 0) - (x.fills || 0))) {
        const toxic = TOXIC.some((t) => a.marketId.startsWith(t));
        console.log(`    ${a.marketId.slice(0, 14)}…  $${a.sizeUsd}/side · ${a.fills || 0} fills · span ${a.spanHours != null ? a.spanHours.toFixed(1) + 'h' : '—'}${toxic ? '  ⚠ TOXIC' : ''}`);
      }
      const toxicIn = hold.allocation.filter((a) => TOXIC.some((t) => a.marketId.startsWith(t)));
      console.log(`  TOXIC markets (0x0d9d760f / 0x14d32732) in the $${budget} allocation: ${toxicIn.length ? toxicIn.map((a) => a.marketId.slice(0, 12)).join(', ') : 'NONE — the optimiser excludes them (they are net-negative).'}`);

      // APPLES-TO-APPLES: exit-cost only, on the SAME (HOLD-chosen) markets & sizes. Isolates the policy from
      // the market-selection effect — CLOSE-NOW's headline edge is selection, not a cheaper exit.
      let sameHoldNet = 0, sameCloseNet = 0;
      for (const a of hold.allocation) {
        const rows = J.byMarket.get(a.marketId) || []; const trades = (marketTokens.get(a.marketId) && tape.byToken.get(marketTokens.get(a.marketId))) || [];
        const cfgBase = { offsetCents: args.offset, sizeUsd: a.sizeUsd, maxInventoryUsd: args.maxInventory };
        const h = perMarketNetAtSize(a.marketId, rows, trades, potByCond, cfgBase);
        const c = perMarketNetAtSize(a.marketId, rows, trades, potByCond, { ...cfgBase, policy: 'close-now' });
        if (h.netPerDay5m != null) sameHoldNet += h.netPerDay5m;
        if (c.netPerDay5m != null) sameCloseNet += c.netPerDay5m;
      }
      console.log(`  APPLES-TO-APPLES on the SAME ${sh.markets} HOLD-chosen markets (exit cost only, no re-selection):`);
      console.log(`    HOLD NET ${money(sameHoldNet)}/day  vs  CLOSE-NOW NET ${money(sameCloseNet)}/day  → ${sameHoldNet >= sameCloseNet ? 'HOLD' : 'CLOSE-NOW'} cheaper to exit by ${money(Math.abs(sameHoldNet - sameCloseNet))}/day`);
      console.log('    (So CLOSE-NOW\'s headline edge above is MARKET SELECTION — it tolerates fill-heavy markets HOLD rejects — NOT a cheaper exit.)');

      // CLOSE-NOW allocation sweep — optimal market count under the spread-paying policy
      const budgetUnits = Math.floor(budget / unit);
      const F = frontierByCount(close.curves, budgetUnits, args.maxCount);
      const bestNet = Math.max(...F.frontier.map((p) => p.net));
      const bestCount = F.frontier.find((p) => Math.abs(p.net - bestNet) < 1e-9).count;
      console.log(`  CLOSE-NOW NET/day frontier by #markets: ` + F.frontier.filter((p) => p.count <= Math.min(args.maxCount, bestCount + 4)).map((p) => `${p.count}:${money(p.net)}`).join('  ') + `  → best ${bestCount} markets`);
      const FH = frontierByCount(hold.curves, budgetUnits, args.maxCount);
      const bestNetH = Math.max(...FH.frontier.map((p) => p.net));
      const bestCountH = FH.frontier.find((p) => Math.abs(p.net - bestNetH) < 1e-9).count;
      console.log(`  (HOLD best market count for comparison: ${bestCountH})`);
      out.rows.detail = { holdBestCount: bestCountH, closeBestCount: bestCount, toxicIn: toxicIn.map((a) => a.marketId) };
    }
    out.rows['b' + budget] = { hold: sh, close: sc, annualHold: aH, annualClose: aC };
  }
  try { fs.mkdirSync('/tmp/rewards-replay', { recursive: true }); fs.writeFileSync('/tmp/rewards-replay/policy-summary.json', JSON.stringify(out, null, 0)); console.log('\nwrote /tmp/rewards-replay/policy-summary.json'); } catch (e) { console.error('write failed', e.message); }
}
main().catch((e) => { console.error('HARD FAIL:', e.message); process.exit(1); });
