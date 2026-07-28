'use strict';
// lib/rewards/allocator.js — the ONE capital allocator, imported by BOTH the backtest
// (scripts/rewards-replay/allocate-run.js) and the UI (/dashboard/liquidity-rewards/allocate).
//
// It re-exports the measured knapsack allocator from scripts/rewards-replay/lib/allocate — never a second
// implementation — and adds a UI-facing planAllocation() plus planFromCollection() (the orchestration the
// /api/rewards/allocate route runs out-of-process). It reads no key, signs nothing, and constructs no order.
//
// PER-MARKET OFFSET: the base allocation runs the knapsack ONCE at a fixed reference offset (offsetCents,
// default 1¢) — that is the backtest-equal baseline, unchanged. Each returned row carries everything the
// client needs to recompute its own offset LOCALLY (no refetch): mid, tick, maxSpread, the S=1-ceiling
// gross, the per-tick fill curve, the structural fill score. The offset override is a display recompute; it
// never re-runs the knapsack, so the allocation (markets/capital/gross) equals the backtest by construction.

const path = require('path');
const allocate = require('../../scripts/rewards-replay/lib/allocate');
const { snapToTick, reconstructTapeFillsForMarket } = require('../../scripts/rewards-replay/lib/tape');
const { markoutForFill } = require('../../scripts/rewards-replay/lib/markout');
const { median } = require('../../scripts/rewards-replay/lib/net');
const { frontierByCount } = require('../../scripts/rewards-replay/lib/allocate-sweep');

const { allocateBudget } = allocate;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

function marketMeta(rows, wsOnly = false) {
  const src = wsOnly ? rows.filter((r) => r.src === 'ws') : rows;
  const depthShares = median(src.map((r) => (fin(r.bidDepthInBand) && fin(r.askDepthInBand)) ? Math.min(r.bidDepthInBand, r.askDepthInBand) : null));
  const mid = median(src.map((r) => r.adjMid));
  const tick = rows[0] && fin(rows[0].tick) ? rows[0].tick : null;
  const spanHours = src.length >= 2 ? (src[src.length - 1].tsMs - src[0].tsMs) / 3_600_000 : 0;
  // newest observed sample for THIS market — the client turns it into a live data age (now − newestTsMs).
  const tsList = src.map((r) => r.tsMs).filter(fin);
  const newestTsMs = tsList.length ? Math.max.apply(null, tsList) : null;
  return { mid, tick, depthShares, spanHours, newestTsMs };
}

// Snapped bid/ask at `offsetTicks` ticks from mid, on the market's OWN tick. Fails closed on unknown tick.
function snapBidAsk(mid, tick, offsetTicks) {
  if (!(fin(mid) && fin(tick) && tick > 0)) return { bid: null, ask: null };
  const d = offsetTicks * tick;
  return { bid: snapToTick(mid - d, tick), ask: snapToTick(mid + d, tick) };
}

/**
 * Per-tick fill curve for one market at its allocated size: for each offset in ticks 0..maxTick, the number
 * of observed fills and the amortised adverse cost/day. Lets the client show fill exposure at ANY chosen
 * offset without a server round-trip. Cost = Σ max(0,−markout) over the offset's fills, over the span.
 */
function fillsByTickCurve(rows, trades, sizeUsd, tick, mid, maxSpreadCents, spanHours, maxInventoryUsd) {
  const out = [];
  const radiusTicks = (fin(maxSpreadCents) && fin(tick) && tick > 0) ? Math.ceil((maxSpreadCents / 2) / (tick * 100)) : 5;
  const maxTick = fin(tick) && tick > 0 ? Math.min(40, Math.max(3, radiusTicks + 2)) : 3; // cover the band + a couple beyond
  const spanDays = fin(spanHours) && spanHours > 0 ? spanHours / 24 : null;
  for (let t = 0; t <= maxTick; t++) {
    const offsetCents = fin(tick) ? t * tick * 100 : null;
    const fills = fin(tick) ? reconstructTapeFillsForMarket(rows, trades, { offsetCents, sizeUsd, maxInventoryUsd }).fills : [];
    let adverse = 0, measured = 0;
    for (const f of fills) { const h5 = markoutForFill(f, rows).horizons['5m']; if (h5 && fin(h5.usd)) { adverse += Math.max(0, -h5.usd); measured++; } }
    const { bid, ask } = snapBidAsk(mid, tick, t); // snapped on the market's OWN tick (reuses snapToTick)
    out.push({ tick: t, offsetCents, fills: fills.length, costPerDay: (spanDays && measured) ? adverse / spanDays : (fills.length ? null : 0), bid, ask });
  }
  return out;
}

/**
 * Plan an allocation of `budgetUsd`. The knapsack runs at `offsetCents` (default 1¢) — the backtest baseline.
 * Extra per-market inputs are additive and never change the allocation:
 *   maxSpreadByMarket   conditionId → reward band width (cents), for the out-of-band ZERO rule + fill curve
 *   fillScoreByMarket   conditionId → structural fill-likelihood score (0..1) | null
 */
function planAllocation(cfg) {
  const {
    byMarket, marketTokens, tapeByToken, potByCond, budgetUsd,
    offsetCents = 1, maxInventoryUsd = 5000, policy = 'hold', maxCount = 25,
    maxSpreadByMarket = null, fillScoreByMarket = null,
  } = cfg;
  const unitUsd = cfg.unitUsd || Math.max(2, Math.round(budgetUsd / 50));
  const alloc = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: budgetUsd, policy,
  });
  const F = frontierByCount(alloc.curves, Math.floor(budgetUsd / unitUsd), maxCount);

  const rows = alloc.allocation.map((a) => {
    const rowsJ = byMarket.get(a.marketId) || [];
    const meta = marketMeta(rowsJ);
    const price = meta.mid != null ? clampPrice(meta.mid) : null;
    const sizePerSideShares = (price != null && price > 0) ? a.sizeUsd / price : null;
    const maxSpreadCents = maxSpreadByMarket ? (maxSpreadByMarket.get(a.marketId) ?? null) : null;
    // default offset (ticks) = the global offsetCents expressed in THIS market's ticks (backtest is 1¢ uniform)
    const defaultOffsetTicks = (fin(meta.tick) && meta.tick > 0) ? Math.max(1, Math.round(offsetCents / (meta.tick * 100))) : 1;
    const { bid, ask } = snapBidAsk(meta.mid, meta.tick, defaultOffsetTicks);
    const netPerDay = (a.fills > 0 && fin(a.netPerDay5m)) ? a.netPerDay5m : null;
    const trades = (marketTokens.get(a.marketId) && tapeByToken.get(marketTokens.get(a.marketId))) || [];
    return {
      marketId: a.marketId, capital: a.capital, sizePerSideUsd: a.sizeUsd, sizePerSideShares,
      snappedBid: bid, snappedAsk: ask, tick: meta.tick, offsetCents, depthShares: meta.depthShares, mid: meta.mid,
      spanHours: meta.spanHours, newestTsMs: meta.newestTsMs, grossPerDay: fin(a.grossPerDay) ? a.grossPerDay : null,
      grossInBandPerDay: fin(a.grossPerDay) ? a.grossPerDay : null, // S=1 ceiling gross (offset-independent within band)
      netPerDay, fills: a.fills, share: a.share, maxSpreadCents, defaultOffsetTicks,
      fillScore: fillScoreByMarket ? (fillScoreByMarket.get(a.marketId) ?? null) : null,
      fillsByTick: fillsByTickCurve(rowsJ, trades, a.sizeUsd, meta.tick, meta.mid, maxSpreadCents, meta.spanHours, maxInventoryUsd),
    };
  });

  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalGrossPerDay = rows.reduce((s, r) => s + (fin(r.grossPerDay) ? r.grossPerDay : 0), 0);
  const totalNetPerDay = rows.length && rows.every((r) => r.netPerDay != null) ? rows.reduce((s, r) => s + r.netPerDay, 0) : null;

  return {
    budgetUsd, unitUsd, offsetCents, marketsUsed: rows.length,
    totalCapital, unallocated: budgetUsd - totalCapital,
    totalGrossPerDay, totalNetPerDay, frontier: F.frontier, rows,
  };
}

// ── Orchestration the /api/rewards/allocate route runs out-of-process (plain node, no webpack). ──
const ROOT = path.join(__dirname, '..', '..');
const REWARDS_FILE = path.join(ROOT, 'data', 'liquidity-rewards.json');
const WINDOW_MS = 48 * 3_600_000;
const LIVE_UNIVERSE = 658;
const APY_CAP = 200;
// Measured offset frontier from the risk-first run ($1000/side, all markets) — fills and reward lost per tick.
const OFFSET_FRONTIER = [
  { offsetCents: 0, fills: 14642, grossInBand: 515.86, rewardLost: 0 },
  { offsetCents: 1, fills: 395, grossInBand: 515.86, rewardLost: 0 },
  { offsetCents: 2, fills: 51, grossInBand: 442.85, rewardLost: 73.01 },
  { offsetCents: 3, fills: 24, grossInBand: 11.65, rewardLost: 504.21 },
];

function loadBoard() {
  const board = JSON.parse(require('fs').readFileSync(REWARDS_FILE, 'utf8'));
  const nameMap = new Map(), potByCond = new Map(), maxSpreadByMarket = new Map();
  for (const m of board.markets || []) {
    if (!m.conditionId) continue;
    const pot = Number(m.rewardsDailyRate);
    if (fin(pot) && pot > 0) potByCond.set(m.conditionId, pot);
    nameMap.set(m.conditionId, { question: m.question ?? null, category: m.category ?? null });
    if (m.rewardsMaxSpread != null) maxSpreadByMarket.set(m.conditionId, Number(m.rewardsMaxSpread));
  }
  return { nameMap, potByCond, maxSpreadByMarket };
}

function identify(nameMap, marketId) {
  const m = nameMap.get(marketId);
  const question = m && typeof m.question === 'string' && m.question.trim() ? m.question : null;
  return { name: question, category: m && typeof m.category === 'string' && m.category.trim() ? m.category : null, nameAvailable: question != null, shortId: marketId.slice(0, 10) + '…' + marketId.slice(-4) };
}

// Full API body: load the window, score the universe, run planAllocation, resolve identity + coverage.
function planFromCollection(opts = {}) {
  const fs = require('fs');
  const { loadJournal } = require('../../scripts/rewards-replay/lib/journal');
  const { loadTape } = require('../../scripts/rewards-replay/lib/tape');
  const { coverageHeader } = require('../mid-history-coverage');
  const { marketFeatures } = require('../../scripts/rewards-riskfirst/lib/features');
  const { computeFillScores, auc } = require('../../scripts/rewards-riskfirst/lib/fillscore');

  const capital = fin(opts.capital) && opts.capital > 0 ? opts.capital : 0;
  const { nameMap, potByCond: boardPots, maxSpreadByMarket } = loadBoard();
  let potByCond = boardPots;
  if (opts.pots) { const snap = JSON.parse(fs.readFileSync(opts.pots, 'utf8')); potByCond = new Map(Object.entries(snap.byCond).map(([c, o]) => [c, o.pot])); }

  const nowMs = Date.now();
  const rawTo = opts.to ? Date.parse(opts.to) : nowMs;
  const rawFrom = opts.from ? Date.parse(opts.from) : rawTo - WINDOW_MS;
  // Clamp to the tape's actual span (as the backtest allocate-run.js does) so the window — and therefore the
  // allocation — matches the backtest exactly when no override is set.
  const tapeFull = loadTape({ fromMs: rawFrom, toMs: rawTo });
  const fromMs = Math.max(rawFrom, tapeFull.window.fromMs ?? rawFrom);
  const toMs = Math.min(rawTo, tapeFull.window.toMs ?? rawTo);
  const J = loadJournal({ fromMs, toMs });
  const tape = loadTape({ fromMs, toMs });
  for (const rows of J.byMarket.values()) for (const r of rows) r.levels = undefined;
  const coveredMarketCount = J.byMarket.size;
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  const fundable = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (potByCond.has(mid)) fundable.set(mid, rows);

  // true OBSERVED fill/market counts across the tape (not the allocation's 11/4)
  let totalTapeFills = 0; const filledMarkets = new Set();
  for (const [mid, rows] of fundable.entries()) {
    const trades = (marketTokens.get(mid) && tape.byToken.get(marketTokens.get(mid))) || [];
    const nf = reconstructTapeFillsForMarket(rows, trades, { offsetCents: 1, sizeUsd: 250, maxInventoryUsd: 5000 }).fills.length;
    if (nf > 0) { totalTapeFills += nf; filledMarkets.add(mid); }
  }

  // structural fill scores across the fundable universe + the AUC/CI of the score (validated, not refit)
  const feats = [];
  for (const [mid, rows] of fundable.entries()) feats.push(marketFeatures(mid, rows, { ...(nameMap.get(mid) || {}), maxSpread: maxSpreadByMarket.get(mid), pot: potByCond.get(mid) }, nowMs));
  const scored = computeFillScores(feats);
  const fillScoreByMarket = new Map(scored.map((f) => [f.marketId, f.fillScore]));
  const V = auc(scored, filledMarkets);

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mid-history-coverage.json'), 'utf8')); } catch { /* unknown */ }
  const cov = coverageHeader({ coveredMarketCount, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  const truePct = Math.round((coveredMarketCount / LIVE_UNIVERSE) * 1000) / 10;

  const plan = capital > 0
    ? planAllocation({ byMarket: fundable, marketTokens, tapeByToken: tape.byToken, potByCond, budgetUsd: capital, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxCount: 25, maxSpreadByMarket, fillScoreByMarket })
    : { budgetUsd: 0, unitUsd: 0, offsetCents: 1, marketsUsed: 0, totalCapital: 0, unallocated: 0, totalGrossPerDay: 0, totalNetPerDay: null, frontier: [], rows: [] };
  const rows = plan.rows.map((r) => ({ ...r, ...identify(nameMap, r.marketId) }));
  const annPct = capital > 0 && plan.totalGrossPerDay >= 0 ? (plan.totalGrossPerDay * 365 / capital) * 100 : null;

  return {
    generatedAt: new Date(J.window.toMs || Date.now()).toISOString(),
    requested: opts.capital, capital, unit: plan.unitUsd, offsetCents: plan.offsetCents,
    window: J.window, staleFrac: J.staleFrac,
    coverage: {
      coveredMarketCount: cov.coveredMarketCount, manifestUniverse: cov.universeMarketCount, truePct, partial: true,
      headerLines: cov.headerLines,
      trueNote: `COVERAGE VERA: ${cov.coveredMarketCount} di ${LIVE_UNIVERSE} mercati reward collezionabili (Gamma) ≈ ${truePct}% — copertura PARZIALE, non il 109-113% del manifest.`,
    },
    observed: { totalFills: totalTapeFills, filledMarkets: filledMarkets.size, windowHours: J.window.hours },
    fillScore: { auc: V.auc, ci95: V.ci95, nFilled: V.nFilled, nUnfilled: V.nUnfilled, note: 'discriminatore debole ma significativo (AUC), NON una probabilità' },
    offsetFrontier: OFFSET_FRONTIER,
    rows,
    totals: { capital: plan.totalCapital, unallocated: plan.unallocated, grossPerDay: plan.totalGrossPerDay, netPerDay: plan.totalNetPerDay, count: plan.marketsUsed },
    annualisedGross: { pct: annPct, capped: annPct != null && annPct > APY_CAP, cap: APY_CAP, label: 'lordo (adverse selection misurata a parte), run-rate, non garantito' },
    frontier: plan.frontier,
  };
}

// ── Selfcheck for the per-market-offset behaviours (the existing allocator.test covers planAllocation;
// this extends it for the NEW logic). Each assertion is independent. Run: node -e "require('./lib/rewards/allocator').selfcheckOffset()".
function selfcheckOffset() {
  let n = 0; const ok = (name, cond) => { if (!cond) throw new Error('SELFCHECK FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  // 1. per-tick snapping on the market's OWN tick
  ok('snapBidAsk(0.575, 0.01, 1) → bid 0.56 / ask 0.58', (() => { const s = snapBidAsk(0.575, 0.01, 1); return near(s.bid, 0.56) && near(s.ask, 0.58); })());
  ok('snapBidAsk(0.500, 0.001, 1) → bid 0.499 / ask 0.501 (fine tick)', (() => { const s = snapBidAsk(0.5, 0.001, 1); return near(s.bid, 0.499) && near(s.ask, 0.501); })());
  ok('snapBidAsk(0.575, 0.01, 2) → 2 ticks → bid 0.55 / ask 0.59', (() => { const s = snapBidAsk(0.575, 0.01, 2); return near(s.bid, 0.55) && near(s.ask, 0.59); })());
  // 2. unknown tick fails CLOSED → null (renders "—")
  ok('unknown tick → {bid:null, ask:null} (fail closed)', (() => { const s = snapBidAsk(0.5, null, 1); return s.bid === null && s.ask === null; })());
  // 3. dual unit: one tick is different cents on different ticks
  ok('1 tick = 1.0¢ on a 0.01 market, 0.1¢ on a 0.001 market', near(1 * 0.01 * 100, 1) && near(1 * 0.001 * 100, 0.1));
  // 4. default offset (ticks) is the 1¢ baseline expressed in the market's own ticks
  const defTicks = (tick) => Math.max(1, Math.round(1 / (tick * 100)));
  ok('defaultOffsetTicks: 0.01→1 tick, 0.001→10 ticks (both = 1¢ baseline)', defTicks(0.01) === 1 && defTicks(0.001) === 10);
  // 5. fill curve entries carry tick/offsetCents/fills/bid/ask (client looks up, never reimplements)
  const curve = fillsByTickCurve([{ adjMid: 0.5, tsMs: 0, tick: 0.01 }, { adjMid: 0.5, tsMs: 1000, tick: 0.01 }], [], 100, 0.01, 0.5, 4.5, 24, 5000);
  ok('fillsByTickCurve returns per-tick {tick,offsetCents,fills,bid,ask}', Array.isArray(curve) && curve[0].tick === 0 && 'offsetCents' in curve[0] && 'fills' in curve[0] && 'bid' in curve[0]);
  // 6. band-honest rule (the client applies it): offsetCents > maxSpread/2 ⇒ out of band ⇒ gross 0
  const outOfBand = (offsetCents, maxSpread) => offsetCents > maxSpread / 2 + 1e-9;
  ok('3¢ offset vs 4.5¢ band (radius 2.25¢) → OUT of band', outOfBand(3, 4.5) === true);
  ok('2¢ offset vs 4.5¢ band → IN band', outOfBand(2, 4.5) === false);
  console.log('selfcheckOffset: ' + n + ' assertions passed');
  return n;
}

module.exports = { ...allocate, planAllocation, planFromCollection, marketMeta, frontierByCount, snapBidAsk, fillsByTickCurve, identify, selfcheckOffset };
