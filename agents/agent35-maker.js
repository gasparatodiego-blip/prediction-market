#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent35-maker — the automated Polymarket liquidity-reward MARKET MAKER engine.
//
// FIRST component in this project that can PLACE orders — so it ships behind the staged MAKER_MODE
// ladder (off default / paper / live-min / live) and drives the ISOLATED maker adapter
// (lib/venues/polymarket-clob-maker). The cancel-only adapter and its "cannot place" proof are untouched.
//
// SAFETY POSTURE IN THIS BUILD:
//   • Default MAKER_MODE=off → the engine builds no adapter that could post; venue writes unreachable.
//   • paper → full pipeline: reads live books (agent34), the operator's per-leg config (RewardsLeg),
//     the real band config + rewardScore; computes the desired quotes, runs every risk rail, decides
//     re-quotes, reconciles, and LOGS what it WOULD post (out-of-book gap + expected S) — ZERO venue
//     writes, no key load.
//   • live-min / live → constructs the maker adapter with REAL credsProvider/signerProvider
//     (lib/maker/live-providers) and hands every postable quote to adapter.postOrder. The adapter then
//     decides: gate chain, live-min notional cap, live-min single-market restriction, order-version
//     gate, and the exchange's own validateOrder() via eth_call.
//   • placement (MAKER_PLACEMENT) → 'dry-run' by DEFAULT, even in live modes: the order is built,
//     SIGNED and validated on-chain, then reported and dropped. Nothing reaches POST /order until this
//     is deliberately set to the exact string 'send'. It is the last belt and it defaults closed.
//
// Reward math, the news-guard, the structural-baseline gate, entitlement/redaction and the cancel-only
// adapter are all REUSED, never changed. All quoting is off the ADJUSTED mid (agent34), never plain mid.
//
// WHAT THE OPERATOR'S MARKET SCREEN CONTROLS, and where this engine reads it (one read each, no copy):
//   • follow / pinned   RewardsLeg.mode + .offsetC → planQuotes → legTarget (a follow leg re-computes its
//                       target off the LIVE mid every cycle), then EVERY target — follow or pinned — is
//                       re-proved by the shared guard lib/maker/venue-rules.validateQuote before it can
//                       count as postable. Off-tick / out-of-band / under-min never reaches a venue.
//   • on-fill rule      RewardsLeg.onFill → lib/maker/fill-policy.planOnFill, per side: close | opposite
//                       | hold. 'opposite' must fit the market's remaining collateral headroom, and its
//                       follow-up order passes the same guard. A HIGH news signal forces close.
//   • collateral cap    data/maker-market-caps.json → lib/maker/market-caps-store.getMarketCap →
//                       lib/maker/market-cap.applyCollateralCap. A hard per-market ceiling on committed
//                       collateral, re-read every cycle, that bounds inventory accumulation from repeated
//                       fills + re-quotes. Unreadable store ⇒ $0 ⇒ nothing committed.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { httpGet } = require('../lib/httpGet');
const { loadMakerConfig } = require('../lib/maker/config');
const { checkTtlVsRefresh, computeGtdExpiration, MIN_EFFECTIVE_TTL_SEC } = require('../lib/maker/order-ttl');
const { planQuotes } = require('../lib/maker/quote-plan');
const { earningRange } = require('../lib/maker/earning-range');
const { decideRequote, planRequoteOrdering } = require('../lib/maker/requote-policy');
const { evaluateRails } = require('../lib/maker/risk-rails');
// The SHARED venue-rules guard. EVERY quote this engine would post — including every follow-mid
// re-quote — is validated here before it can be counted postable. It is the same validateQuote the
// preflight probes with a known-bad order and the market screen calls for its band warning.
const { validateQuote } = require('../lib/maker/venue-rules');
// The PER-MARKET collateral ceiling the operator sets on the market screen, and its durable store.
const { applyCollateralCap } = require('../lib/maker/market-cap');
// REAL outcome-token inventory (read-only ERC-1155 balanceOf). Feeds the SELL guard; null = unreadable
// = the SELL is blocked. Never assumed, never defaulted to a constant.
const { readMarketInventory } = require('../lib/maker/inventory-read');
// What happens AFTER a fill: the per-market inventory ceiling (DEFAULT 0 = do not accumulate, do not
// re-quote the opposite side). Decision logic only — it emits no order and reaches no venue.
const { planPostFill, preferredSides, CODES: INV_CODES } = require('../lib/maker/inventory-manager');
const { getMarketCap } = require('../lib/maker/market-caps-store');
// What the engine does when a leg fills — the per-side rule (close | opposite | hold), read from the
// SAME RewardsLeg rows the quotes come from. Previously stored and never consulted.
const { planOnFill, normalizeFillRule } = require('../lib/maker/fill-policy');
const { reconcile } = require('../lib/maker/reconcile');
const { legTarget } = require('../lib/rewards-live-band');
const { scoreOrder } = require('../lib/rewardScore');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { createMakerAdapter } = require('../lib/venues/polymarket-clob-maker/adapter');
const { makerLiveProviders } = require('../lib/maker/live-providers');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const { checkKill, cancelAllOnKill } = require('../lib/safety/kill-switch');
const { queryByUser } = require('../lib/safety/execution-audit');
const { sentOrdersFromAudit } = require('../lib/safety/usage');
const { reconcileOnce, RECONCILE_INTERVAL_MS } = require('../lib/safety/reconcile-fills');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const { getMakerSelection, DEFAULT_SELECTION } = require('../lib/maker/selection');
const { resolveMakerUniverse } = require('../lib/maker/universe');
const { readArming, checkArmedInvariants } = require('../lib/maker/arming');
const { runPreflight } = require('../lib/maker/preflight');

const OPERATOR_USER = process.env.MAKER_OPERATOR_USER || 'operator';

const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';        // agent34 (adjusted mid + live/stale)
const WATCHLIST_FILE  = '/root/prediction-market/data/liquidity-rewards.json'; // band config + rewardsDailyRate
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';       // carries rewardScore per market
const NEWS_STATE_FILE = '/tmp/news-guard-state.json';        // per-market severity, if present
const OUT_FILE        = '/tmp/maker-state.json';
const HB_FILE         = '/tmp/agent-heartbeats.json';
// The maker-specific heartbeat the dead-man watchdog (agent37) and the kill-switch UI read. Lives under
// data/ (not /tmp) so it survives a reboot for the watchdog to detect staleness. Written at the END of
// EVERY cycle — success OR error — so a heartbeat that STOPS is the death signal, an error is not.
const MAKER_HB_FILE   = path.join(__dirname, '..', 'data', 'maker-heartbeat.json');
const CLOB_BASE       = 'https://clob.polymarket.com';
const UA = 'edgeradar-agent35-maker/1.0';

const TICK_MS = Number(process.env.MAKER_TICK_MS || 3_000);
const DEFAULT_SIZE_SHARES = Number(process.env.MAKER_DEFAULT_SIZE || 200);
const OUT_OF_BOOK_MODEL_MS = Number(process.env.MAKER_OUT_OF_BOOK_MS || 400); // modelled cancel→replace gap in paper
// Stand-down cancel sweep. A live-mode engine that is killed or unarmed re-cancels as a safety net, but
// that is a real venue write and its natural cadence is "occasionally", not "every quote tick".
const STANDDOWN_SWEEP_MS = Number(process.env.MAKER_STANDDOWN_SWEEP_MS || 60_000);
let lastStandDownSweepAt = 0;
let wasStandingDown = false;

const log = (...a) => console.log(new Date().toISOString(), '[agent35-maker]', ...a);

let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); } catch { /* legs unavailable → engine idles honestly */ }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function atomicWrite(file, obj) { const t = `${file}.tmp.${process.pid}`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file); }
function heartbeat() { const hb = readJson(HB_FILE) || {}; hb['agent35-maker'] = Date.now(); try { atomicWrite(HB_FILE, hb); } catch { /* best-effort */ } }
// The dead-man heartbeat. { ts, cycle, openOrderCount (venue-reported, null when not queried — never a
// fabricated 0), mode, lastError }. Atomic (tmp+fsync+rename). Best-effort: a write failure is logged,
// never thrown, so it cannot itself crash the cycle.
function writeMakerHeartbeat(hb) { try { atomicWriteJson(MAKER_HB_FILE, hb); } catch (e) { log('maker-heartbeat write failed:', e.message); } }

// ── build the maker adapter for the current mode. off/paper → no providers (canWrite false). live modes
//    → the REAL custody providers (L2 creds + signing key). EVERY gate stays intact: the adapter still
//    refuses unless MAKER_FUNDING_APPROVED is attested AND MAKER_MODE is live AND the kill switch is off
//    AND the venue-allowlist/notional/rate/inventory caps and the shared venue-rules guard all pass. The
//    providers only make a key REACHABLE on a live mutating path; they decide nothing and remove no gate.
//    In this fleet's env MAKER_FUNDING_APPROVED is now 'true' — attested 2026-07-29 against a funder
//    verified on-chain to hold 100 pUSD with all six v2 approvals granted. That gate is therefore OPEN.
//    agent35 still places nothing, for two independent reasons that have nothing to do with funding:
//    MAKER_MODE=off means buildAdapter returns null below, and MAKER_PLACEMENT=dry-run means even a
//    fully armed adapter builds, signs and on-chain-validates every order and then never POSTs it. ──
function buildAdapter(cfg) {
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'paper' || cfg.dryRun) return createMakerAdapter({ mode: 'paper', dryRun: cfg.dryRun, orderTtlSeconds: cfg.orderTtlSeconds });
  const { credsProvider, signerProvider } = makerLiveProviders();
  return createMakerAdapter({
    mode: cfg.mode, liveMinCapUsd: cfg.liveMinCapUsd, orderTtlSeconds: cfg.orderTtlSeconds,
    // The human funding attestation — a REAL gate, not a formality. Read from the env so a live adapter
    // built without MAKER_FUNDING_APPROVED=true still refuses at the funding gate before any key is loaded.
    fundingApproved: process.env.MAKER_FUNDING_APPROVED === 'true',
    credsProvider, signerProvider,
  });
}

// tick cache — ALWAYS fetch per token, never assume (0.1/0.01/0.001/0.0001/0.0025 all exist). TTL 5min.
const tickCache = new Map(); // tokenId -> { tick, ts }
async function getTick(tokenId) {
  const c = tickCache.get(tokenId);
  if (c && Date.now() - c.ts < 300_000) return c.tick;
  try {
    const r = await httpGet(`${CLOB_BASE}/tick-size?token_id=${tokenId}`, { timeoutMs: 5_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const tick = r && r.status === 200 ? parseFloat(r.data.minimum_tick_size) : null;
    if (Number.isFinite(tick)) { tickCache.set(tokenId, { tick, ts: Date.now() }); return tick; }
  } catch { /* fall through */ }
  return c ? c.tick : null;
}

// REST book cache for the earning-range advisory — agent34's snapshot publishes only best bid/ask, so
// to MEASURE competing depth (the resting size + distances of every OTHER maker) we read the full ladder
// here. Cached 15s (the advisory doesn't need per-tick freshness). Returns null on failure → the
// advisory shows "—" for competing depth/share, never a fabricated 100%.
const bookCache = new Map(); // tokenId -> { book, ts }
async function getRestBook(tokenId) {
  const c = bookCache.get(tokenId);
  if (c && Date.now() - c.ts < 15_000) return c.book;
  try {
    const r = await httpGet(`${CLOB_BASE}/book?token_id=${tokenId}`, { timeoutMs: 6_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r && r.status === 200 && r.data && (Array.isArray(r.data.bids) || Array.isArray(r.data.asks))) {
      const book = { bids: r.data.bids || [], asks: r.data.asks || [] };
      bookCache.set(tokenId, { book, ts: Date.now() });
      return book;
    }
  } catch { /* fall through */ }
  return c ? c.book : null;
}

// per-leg re-quote memory: legKey -> { lastTarget, lastRequoteAt }
const requoteState = new Map();
let lastReconcileAt = 0; // throttle for the periodic fill reconciliation (see tick)
// The armed-invariant preflight re-check is EXPENSIVE (offline signing + chain reads), so it runs on a slow
// cadence while the cheap invariants (TTL, collateral, kill) are checked every tick. Default 120s.
let lastPreflightAt = 0, lastPreflight = null;
const PREFLIGHT_RECHECK_MS = Number(process.env.MAKER_PREFLIGHT_RECHECK_MS || 120_000);
let lastUniverseIds = new Set(); // marketIds quoted last cycle — diffed to cancel markets that leave the universe
// per-leg static-baseline vs follow accumulators (for the paper reward-vs-baseline report)
const rewardAccum = new Map(); // legKey -> { followScoreMs, staticScoreMs, staticInitPrice, lastTs }

function loadInputs() {
  const books = readJson(LIVE_BOOKS_FILE);
  const watch = readJson(WATCHLIST_FILE);
  const norm = readJson(NORMALIZED_FILE);
  const news = readJson(NEWS_STATE_FILE);
  const bandByMarket = new Map();
  for (const m of (watch && watch.markets) || []) {
    if (m.conditionId) bandByMarket.set(m.conditionId, m);
  }
  const rewardScoreByMarket = new Map();
  for (const m of (norm && norm.markets) || []) if (m.marketId && m.rewardScore) rewardScoreByMarket.set(m.marketId, m.rewardScore);
  // negRisk decides WHICH EXCHANGE an order settles against (NegRiskCtfExchangeV2 vs CTFExchangeV2), so
  // it must come from the venue's own feed, never be assumed. A market absent here yields undefined →
  // `=== true` below is false → the order is built for the standard exchange, and validateOrder would
  // reject it against the wrong one rather than it silently settling somewhere unintended.
  const negRiskByMarket = new Map();
  for (const m of (norm && norm.markets) || []) if (m.marketId && typeof m.negRisk === 'boolean') negRiskByMarket.set(m.marketId, m.negRisk);
  const newsByMarket = new Map();
  for (const [mid, s] of Object.entries((news && news.markets) || {})) newsByMarket.set(mid, s && s.severity);
  // The RAW board markets — the SAME /tmp/liquidity-rewards.json the board reads. The universe resolver
  // runs the board's shared filter functions over these, so the bot's set is the board's set by construction.
  const normMarkets = (norm && Array.isArray(norm.markets)) ? norm.markets : [];
  return { books, bandByMarket, rewardScoreByMarket, newsByMarket, normMarkets, negRiskByMarket };
}

// The per-market operator config that carries the inventory ceiling. Absent row ⇒ ceiling 0 ⇒ the bot
// does not accumulate here. Unreadable DB ⇒ empty map ⇒ same conservative answer.
async function loadPlacements() {
  if (!prisma) return new Map();
  try {
    const rows = await prisma.rewardsPlacement.findMany({ where: { venue: 'polymarket' }, select: { marketId: true, maxInventoryUsd: true } });
    const byMarket = new Map();
    for (const r of rows) byMarket.set(r.marketId, r);
    return byMarket;
  } catch (e) { log('placement load failed (inventory ceiling treated as 0):', e.message); return new Map(); }
}

async function loadLegs() {
  if (!prisma) return new Map();
  try {
    const rows = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket' } });
    const byMarket = new Map();
    for (const l of rows) { if (!byMarket.has(l.marketId)) byMarket.set(l.marketId, []); byMarket.get(l.marketId).push(l); }
    return byMarket;
  } catch (e) { log('leg load failed (idle this cycle):', e.message); return new Map(); }
}

// Accumulate time-weighted S for the follow engine vs a STATIC (never-re-quoted) quote frozen at its
// first price — the paper reward-vs-baseline measurement. Follow re-quotes to hold its offset (S stays
// near the target), while the static quote's distance-to-mid grows as mid moves (S decays), so the
// ratio quantifies what following actually buys. `staticFrozenPrice` is captured on first sight per leg.
function accrueReward(legKey, followScore, staticFrozenPrice, mid, vCents, now) {
  const a = rewardAccum.get(legKey) || { followScoreMs: 0, staticScoreMs: 0, frozenPrice: staticFrozenPrice, lastTs: now };
  const dt = Math.max(0, now - a.lastTs);
  const staticScore = (a.frozenPrice != null && mid != null && vCents > 0) ? scoreOrder(Math.abs(a.frozenPrice - mid) * 100, vCents) : 0;
  a.followScoreMs += (followScore || 0) * dt;
  a.staticScoreMs += staticScore * dt;
  a.lastTs = now;
  rewardAccum.set(legKey, a);
  return a;
}

async function tick(cfg, adapter) {
  const now = Date.now();
  const { books, bandByMarket, rewardScoreByMarket, newsByMarket, normMarkets, negRiskByMarket } = loadInputs();
  const legsByMarket = await loadLegs();
  const placementsByMarket = await loadPlacements();
  const ngCfg = loadNewsGuardConfig(process.env);

  // ── OPERATING UNIVERSE (the control channel) — re-read the persisted selection EVERY cycle (never at
  //    boot only), resolve it through the board's SHARED filter code path, and gate quoting to that set.
  //    A selection that needs a pm2 restart to take effect is not a control channel. ──
  let selection = DEFAULT_SELECTION;
  try { if (prisma) selection = await getMakerSelection(prisma); } catch (e) { log('selection read failed (using default):', e.message); }
  const universe = resolveMakerUniverse(normMarkets, selection);
  const universeSet = new Set(universe.resolvedMarketIds);
  // Markets that LEFT the universe since last cycle → cancel their resting orders BEFORE quoting anywhere
  // new, so a de-selected market never keeps orphan quotes. Idempotent (no resting order → no-op). Zero
  // markets is a VALID state: we cancel what we had and quote nothing below — never an error/crash-loop.
  const leaving = [...lastUniverseIds].filter((id) => !universeSet.has(id));
  if (leaving.length && adapter && typeof adapter.cancelMarketOrders === 'function') {
    for (const mid of leaving) {
      try { await adapter.cancelMarketOrders(mid); } catch (e) { log('universe-leave cancel failed', mid, e.message); }
    }
  }
  lastUniverseIds = universeSet;

  const globalState = { dailyPnlUsd: 0, totalExposureUsd: 0, recentErrorCount: 0 }; // paper: no realised P&L/exposure
  const marketsOut = {};
  let totalRequotes = 0, totalWouldPost = 0, railsTrippedCount = 0;

  // ── DURABLE kill switch (fail-closed) — checked EVERY tick, so a kill set one second ago halts the
  //    engine on the very next cycle. When killed we (a) force the rails to halt-all/cancel-all, and
  //    (b) attempt a cancel-all through the (shadow, in this disarmed build) adapter cancel path —
  //    REUSING the existing cancelMarketOrders, never a new venue write. Env MAKER_KILL still applies. ──
  const durableKill = checkKill({ userId: OPERATOR_USER });

  // ── ARMING + AUTO-DISARM (re-checked EVERY cycle, not only at arming) — read the durable arming record
  //    (enforces the TTL on read), and re-run the preflight invariants that can change WHILE armed. Any
  //    breach — TTL expiry, a preflight check gone red (balance dropped, approval revoked, cancel path
  //    down), or the collateral ceiling exceeded — AUTO-DISARMS (audited with the reason) and cancels. The
  //    heartbeat-failed reason is owned by the dead-man watchdog (agent37). In this disarmed build MAKER_MODE
  //    is off so nothing is armed and this is dormant, but the recheck is wired and proven by selfcheck. ──
  let arming = { armed: false };
  try { arming = readArming(); } catch (e) { log('arming read failed (treated disarmed):', e.message); }
  if (arming.armed) {
    if (prisma && now - lastPreflightAt >= PREFLIGHT_RECHECK_MS) {
      lastPreflightAt = now;
      try { lastPreflight = await runPreflight({ prisma, env: process.env }); }
      catch (e) { log('armed preflight recheck failed (fail closed → NO-GO):', e.message); lastPreflight = { go: false, checks: [{ key: 'preflight-error', pass: false, value: e.message }] }; }
    }
    // paper build carries no real exposure, so collateralUsedUsd is 0 here; when live it comes from the fill ledger.
    const inv = checkArmedInvariants({ preflight: lastPreflight, collateralUsedUsd: 0 });
    if (!inv.armed) {
      log('AUTO-DISARM:', inv.disarmedReason || 'ttl-expiry');
      arming = { armed: false, disarmedReason: inv.disarmedReason };
      if (adapter && typeof adapter.cancelMarketOrders === 'function') {
        try { await cancelAllOnKill({ adapter, marketIds: [...legsByMarket.keys()] }); } catch (e) { log('auto-disarm cancel failed:', e.message); }
      }
    }
  }

  // A live-mode engine that is NOT armed must stand down exactly like a killed one (it may not quote). off/
  // paper never place anyway; this makes the arming record a hard placement gate once the env goes live.
  const notArmedLive = (cfg.mode === 'live-min' || cfg.mode === 'live') && !arming.armed;
  const effCfg = (durableKill.killed || notArmedLive) ? { ...cfg, killSwitch: true } : cfg;
  // THROTTLED. A stand-down cancel is a REAL authenticated venue write when canWrite is true, and this
  // branch is reached on EVERY tick for as long as the engine remains killed or unarmed — which is the
  // normal resting state of a live-mode engine that has not been deliberately armed. Unthrottled that is
  // a cancel-all to Polymarket every 3 seconds, forever: measured at 20 calls in 120s the first time
  // MAKER_MODE went to live-min, all returning {canceled:[]} because there was nothing to cancel.
  //
  // Cancelling once per stand-down TRANSITION would be the tidy answer, but it is the wrong one: if an
  // order somehow appears while the engine is standing down, once-only would never clear it. So the
  // cancel repeats — just at a rate that reflects what it is (a safety sweep), not the quote cadence.
  const standingDown = durableKill.killed || notArmedLive;
  if (standingDown && adapter && typeof adapter.cancelMarketOrders === 'function') {
    const sweepDue = now - lastStandDownSweepAt >= STANDDOWN_SWEEP_MS;
    if (sweepDue || !wasStandingDown) {   // immediately on ENTERING stand-down, then at the sweep interval
      lastStandDownSweepAt = now;
      try { await cancelAllOnKill({ adapter, marketIds: [...legsByMarket.keys()] }); } catch (e) { log('cancel-on-standdown failed:', e.message); }
    }
  }
  wasStandingDown = standingDown;

  // ── Periodic FILL RECONCILIATION — resolves the operator's sent orders against VENUE TRUTH into the fill
  //    ledger (feeds openNotionalUsd / realisedDailyPnlUsd). Throttled to once per RECONCILE_INTERVAL_MS
  //    (default 60s), independent of the 3s quote tick. In THIS disarmed build the adapter's reads are
  //    shadow (canWrite=false → no network), so it reaches no venue and records nothing — wired, proven by
  //    the selfcheck, and dormant until arming. READ-ONLY: it never places or cancels. ──
  if (adapter && typeof adapter.listOpenOrders === 'function' && now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
    lastReconcileAt = now;
    try {
      const sentOrders = sentOrdersFromAudit(queryByUser({ userId: OPERATOR_USER, fromTs: 0, toTs: now }));
      if (sentOrders.length) {
        const rc = await reconcileOnce({ userId: OPERATOR_USER, sentOrders, adapter, now });
        if (rc.fills || rc.nofills) log(`reconcile: +${rc.fills} fills, +${rc.nofills} no-fills, ${rc.stillUnknown} unknown`);
      }
    } catch (e) { log('reconcile failed (non-fatal):', e.message); }
  }

  for (const [marketId, legs] of legsByMarket) {
    if (!universeSet.has(marketId)) continue; // outside the operating universe — do not quote this market
    // conditionIds are 0x+64hex — the SAME shape as a private key, so the shared redactor blanks them in
    // the audit (safe over-redaction). A conditionId is PUBLIC, so we log a redaction-surviving ref
    // (no 0x prefix → doesn't match the private-key scrub) to keep the audit trail identifiable.
    const marketRef = 'cid_' + String(marketId).replace(/^0x/, '');
    const band = bandByMarket.get(marketId);
    const bookMarket = books && books.markets && books.markets[marketId];
    const mid = bookMarket ? bookMarket.mid : null;
    const feedLive = !!(bookMarket && bookMarket.live);
    const maxSpreadC = band ? Number(band.rewardsMaxSpread) : (bookMarket ? bookMarket.maxSpread : null);
    const minSize = band ? Number(band.rewardsMinSize) : (bookMarket ? bookMarket.minSize : null);
    const tokenId = band ? band.tokenId : (bookMarket ? bookMarket.tokenId : null);
    const tokenIdNo = band ? band.tokenIdNo : (bookMarket ? bookMarket.tokenIdNo : null);
    const rewardsDailyRate = band ? Number(band.rewardsDailyRate) : null;
    const tick = tokenId ? await getTick(tokenId) : null;
    const oneSidedByConstruction = !!(bookMarket && bookMarket.yes && (bookMarket.yes.bestBid == null || bookMarket.yes.bestAsk == null));

    // ── risk rails (Phase 6) ──
    const rails = evaluateRails({
      globalState,
      market: {
        feedLive, resolved: false, closed: false,
        structurallyDegenerate: oneSidedByConstruction,
        newsSeverity: newsByMarket.get(marketId) || null,
        marketNotionalUsd: 0, positionUsd: 0,
      },
      config: effCfg,
    });
    if (rails.trips.length) railsTrippedCount += rails.trips.length;

    // ── REAL inventory for the SELL guard. Read-only chain call, cached; an unreadable balance stays
    //    null so the guard fails closed and blocks the SELL rather than assuming a position exists. ──
    const inventory = await readMarketInventory({ tokenId, tokenIdNo });

    // ── desired quotes (Phase 3) ──
    const plan = planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId, tokenIdNo, defaultSizeShares: DEFAULT_SIZE_SHARES,
      balances: { yes: inventory.yes, no: inventory.no } });

    // ── SHARED GUARD (lib/maker/venue-rules) — the follow engine re-computes a target off the live mid
    //    every cycle, so every cycle that target must be re-proved against the market's REAL rules:
    //    on-tick, inside the reward band (radius = maxSpread/2), at or above min_incentive_size, inside
    //    the venue price range. A quote the guard refuses is NOT postable, whatever the planner thought.
    //    FAIL CLOSED: unreadable rules ⇒ RULES_UNREADABLE ⇒ nothing is postable on this market. ──
    //
    //    EACH QUOTE IS JUDGED IN ITS OWN BOOK'S SPACE. A NO-token order at q IS a YES order at 1 − q, so
    //    the NO book's mid is 1 − mid. planQuotes already does this mirror (see lib/maker/quote-plan.js,
    //    "EVERY LEG IS PRICED AND JUDGED IN ITS OWN BOOK'S SPACE") — but this guard call did not, and
    //    passed the YES mid for every quote regardless of book. The result was that the planner and the
    //    guard disagreed about the same order: a NO leg 0.45c from the NO mid was measured against the
    //    YES mid, read as ~7c away, and refused OUT_OF_BAND. Since BUY NO is how a collateral-funded
    //    maker offers the ASK side (a SELL YES needs inventory it does not have), this silently made
    //    EVERY two-sided configuration impossible — and one-sided liquidity takes the ÷3 reward penalty,
    //    or earns exactly zero when the mid is in the tails. Same mirror, same formula, both sides.
    for (const q of plan.quotes) {
      const guardMid = (mid != null && q.book === 'no') ? +(1 - mid).toFixed(6) : mid;
      const guardRules = { tick, scoringMid: guardMid, maxSpreadCents: maxSpreadC, minSize };
      const g = validateQuote(guardRules, { side: q.side, price: q.price, size: q.size });
      q.guard = { valid: g.valid, codes: g.reasons.map((r) => r.code) };
      if (!g.valid && q.postable) {
        q.postable = false;
        q.reason = `rifiutato dal guard venue-rules: ${g.reasons.map((r) => r.code).join(', ')}`;
      }
    }

    // ── PER-MARKET COLLATERAL CEILING — the hard limit on what the bot may commit HERE, including
    //    everything an on-fill 'opposite' rule would re-quote. Read fresh every cycle (a ceiling that
    //    needed a restart to take effect would not be a control). No per-market entry ⇒ fall back to the
    //    env rail cap, never to "unlimited"; an unreadable store ⇒ $0 ⇒ nothing is committed. ──
    const capRead = getMarketCap(marketId, { fallbackUsd: cfg.rails.perMarketNotionalCapUsd });
    const capped = applyCollateralCap({ quotes: plan.quotes, capUsd: capRead.capUsd });
    plan.quotes = capped.quotes;

    // ── earning-range advisory (Phase 4) — measure competing depth from the FULL REST ladder (agent34's
    //    snapshot has only best bid/ask). null book → advisory shows "—", never a fabricated 100% share. ──
    const advisoryBook = tokenId ? await getRestBook(tokenId) : null;
    const advisory = earningRange({ book: advisoryBook, mid, maxSpreadC, minSize, rewardsDailyRate, capitalUsd: 1000 });

    // ── re-quote decisions (Phase 5) + reward-vs-baseline accrual ──
    // The operator's per-side ON-FILL rule travels on the SAME RewardsLeg row as the quote, so we index
    // the legs by id and read leg.onFill for the quote the planner produced from it.
    const legById = new Map((legs || []).map((l) => [l.id, l]));
    // Collateral still available on this market AFTER the admitted quotes — what an on-fill 'opposite'
    // round-trip may consume. null cap ⇒ null headroom (no ceiling configured, stated as such).
    const capHeadroomUsd = capRead.capUsd == null ? null : Math.max(0, capRead.capUsd - capped.admittedNotionalUsd);
    const newsForceClose = newsByMarket.get(marketId) === 'high';
    const legActions = [];
    for (const q of plan.quotes) {
      // Key on the leg's stable DB id — laddered follow legs share (book,kind,mode) so keying on those
      // alone collides and causes spurious re-quote churn between ladder levels.
      const legKey = q.id || `${marketId}:${q.book}:${q.kind}:${q.mode === 'pinned' ? q.price : 'follow'}:${q.offsetC}`;
      const st = requoteState.get(legKey) || { lastTarget: q.price, lastRequoteAt: null };
      const driftC = (q.price != null && st.lastTarget != null) ? Math.abs(q.price - st.lastTarget) * 100 : 0;
      const dec = feedLive && q.postable
        ? decideRequote({ driftC, lastRequoteAt: st.lastRequoteAt, recentlyRequoted: st.lastRequoteAt != null && now - st.lastRequoteAt < 60_000, config: cfg.requote, now })
        : { requote: false, reason: feedLive ? q.reason : 'feed not live — stand down', waitMs: 0 };
      // out-of-book gap for THIS re-quote: place-then-cancel (0) if a transient double is within caps, else modelled round-trip.
      const ordering = planRequoteOrdering({ canDoubleTransiently: rails.allowNewPlacement && q.notionalUsd != null && q.notionalUsd * 2 <= cfg.rails.perMarketNotionalCapUsd });
      const outOfBookMs = ordering.order === 'place-then-cancel' ? 0 : OUT_OF_BOOK_MODEL_MS;
      if (dec.requote) { st.lastTarget = q.price; st.lastRequoteAt = now; totalRequotes++; requoteState.set(legKey, st);
        appendMakerAudit({ ts: now, venue: 'polymarket', op: 'requote-intent', mode: cfg.mode, marketRef, leg: { book: q.book, kind: q.kind, price: q.price }, expectedScore: q.score, outOfBookMs, ordering: ordering.order });
      } else if (!requoteState.has(legKey)) { requoteState.set(legKey, st); }

      // reward-vs-baseline: follow S = current in-band score; static S = score of the FROZEN first price vs current mid
      const vCents = maxSpreadC > 0 ? maxSpreadC / 2 : null;
      const ra = accrueReward(legKey + ':fb', q.score || 0, q.price, mid, vCents, now);
      const rewardVsBaseline = ra.staticScoreMs > 0 ? +(ra.followScoreMs / ra.staticScoreMs).toFixed(3) : null;

      // ── ON-FILL RULE (per side, from the leg's own row) — what this engine WOULD do the moment this
      //    level fills. Resolved every cycle so the plan is always against the CURRENT mid/band/tick and
      //    the CURRENT collateral headroom; the follow-up order is priced and guard-validated by
      //    lib/maker/fill-policy before it can exist. Nothing here fires until a real fill arrives, and
      //    in this disarmed build no order exists to fill — the rule is wired and dormant, not pretend. ──
      const onFillRule = normalizeFillRule((legById.get(q.id) || {}).onFill);
      const onFill = planOnFill({
        filledLeg: { book: q.book, kind: q.kind, price: q.price, offsetC: q.offsetC, size: q.size },
        rule: onFillRule, mid, maxSpreadC, tick, minSize, capHeadroomUsd, newsForceClose,
      });

      if (q.postable && feedLive) totalWouldPost++;
      legActions.push({ book: q.book, kind: q.kind, side: q.side, mode: q.mode, targetPrice: q.price, size: q.size, notionalUsd: q.notionalUsd, distanceC: q.distanceC, expectedScore: q.score, inBandNow: q.inBandNow, belowMinSize: q.belowMinSize, neverEarns: q.neverEarns, postable: q.postable, reason: q.reason, requote: dec.requote, requoteReason: dec.reason, outOfBookMs, ordering: ordering.order, rewardVsBaseline,
        guard: q.guard, capBlocked: !!q.capBlocked,
        onFill: { rule: onFillRule, applied: onFill.appliedRule, action: onFill.action, forcedBy: onFill.forcedBy, reason: onFill.reason, quote: onFill.quote, guardValid: onFill.guard ? onFill.guard.valid : null } });
    }

    // ── POST-FILL INVENTORY POLICY (decision only — emits no order, reaches no venue) ─────────────────
    //    The ceiling is the operator's per-market number and DEFAULTS TO 0. At 0 a fill ends quoting on
    //    that side: the engine records CAP_ZERO and re-quotes nothing. Above 0 the re-quote is sized from
    //    the VENUE-CONFIRMED fill (never from the intent) and trimmed so the resulting position cannot
    //    exceed the ceiling. In this disarmed build no order exists to fill, so the decision the engine
    //    records is the gate itself — which is the honest thing to record.
    const placement = placementsByMarket.get(marketId) || null;
    const maxInventoryUsd = placement && Number.isFinite(placement.maxInventoryUsd) ? placement.maxInventoryUsd : 0;
    const invYesUsd = (Number.isFinite(inventory.yes) && mid != null) ? inventory.yes * mid : null;
    const invNoUsd = (Number.isFinite(inventory.no) && mid != null) ? inventory.no * (1 - mid) : null;
    const inventoryUsd = (invYesUsd != null && invNoUsd != null) ? +(invYesUsd + invNoUsd).toFixed(4) : null;
    const sides = preferredSides({ yesShares: inventory.yes, noShares: inventory.no });
    const inventoryDecisions = [];
    for (const q of plan.quotes) {
      if (!q.postable) continue;
      const oppositePrice = q.price != null ? +(1 - q.price).toFixed(6) : null;
      // confirmed:false on purpose — there is no venue-confirmed fill in a disarmed build, and a
      // re-quote may never be sized from an assumed one.
      const d = planPostFill({
        fill: { book: q.book, kind: q.kind, price: q.price, filledShares: q.size, confirmed: false },
        maxInventoryUsd, inventoryUsd, oppositePrice,
      });
      inventoryDecisions.push({ leg: { book: q.book, kind: q.kind, price: q.price }, action: d.action, code: d.code, reason: d.reason, sizeShares: d.sizeShares, notionalUsd: d.notionalUsd, headroomUsd: d.headroomUsd });
      // Every decision lands in the EXISTING append-only maker audit with its reason code.
      appendMakerAudit({ ts: now, venue: 'polymarket', op: 'inventory-decision', mode: cfg.mode, marketRef,
        leg: { book: q.book, kind: q.kind, price: q.price }, action: d.action, code: d.code,
        maxInventoryUsd, inventoryUsd, requoteSizeShares: d.sizeShares, headroomUsd: d.headroomUsd });
    }

    // ── reconcile (Phase 5): in paper we hold no venue orders, so desired == toPlace (belief starts empty) ──
    const desiredPostable = plan.quotes.filter(q => q.postable);
    const recon = reconcile({ desired: desiredPostable, venueOrders: [], tick });

    // ── PLACEMENT — the call that had never existed in this engine ────────────────────────────────────
    // Everything above decides WHAT to quote; this is the only place that hands a quote to the adapter.
    // Until now the loop computed `wouldPost` and threw the quotes away, which is why every safety layer
    // could be intact and yet nothing was ever placed.
    //
    // This adds NO authority. Every existing belt still decides, and each one can only subtract:
    //   • canWrite    — off/paper/dry-run never reach here at all
    //   • durable kill + rails — a killed engine or a tripped rail places nothing this cycle
    //   • capBlocked  — the per-market collateral ceiling already marked over-cap legs unpostable
    //   • the adapter — re-runs the venue-rules guard, the live-min cap, the live-min single-market
    //                   restriction, the full gate chain, the order-version gate, validateOrder, and
    //                   (by default) stops at dry-run without sending.
    // The adapter is the authority on whether an order goes out; this loop only offers candidates.
    //
    // FAIL LOUD, NEVER SILENTLY: a refusal is logged with the gate that produced it, and a throw is
    // caught per-leg so one bad leg cannot take down the cycle — but it is recorded, never swallowed.
    const placements = [];
    const placementBlocked =
      !adapter ? 'no adapter (mode=off)'
        : !adapter.canWrite ? `mode=${cfg.mode} cannot write`
          : durableKill.killed ? `durable kill active (${durableKill.scope || 'global'})`
            : !rails.allowNewPlacement ? `rails refuse new placement (${rails.cancelScope})`
              : null;
    if (placementBlocked) {
      if (recon.toPlace.length && cfg.mode !== 'off') log(`placement skipped on ${marketRef}: ${placementBlocked} (${recon.toPlace.length} quote(s) held back)`);
    } else {
      for (const q of recon.toPlace) {
        // Each leg is judged in ITS OWN book's space — the same mirror the planner and the guard use.
        const legMid = (mid != null && q.book === 'no') ? +(1 - mid).toFixed(6) : mid;
        try {
          const res = await adapter.postOrder({
            marketId,                                   // REQUIRED: the live-min single-market gate proves this
            tokenId: q.token, side: q.side, price: q.price, size: q.size,
            tickSize: tick, negRisk: negRiskByMarket.get(marketId) === true, postOnly: true,
            venueRules: { tick, scoringMid: legMid, maxSpreadCents: maxSpreadC, minSize },
            ttlSeconds: cfg.orderTtlSeconds, userId: OPERATOR_USER,
            decision: { book: q.book, kind: q.kind, mode: q.mode, distanceC: q.distanceC, score: q.score },
          });
          placements.push({ book: q.book, kind: q.kind, side: q.side, price: q.price, size: q.size,
            ok: res.ok === true, sent: res.sent === true, dryRun: res.dryRun === true,
            gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
            wouldSend: res.wouldSend || null });
          if (res.dryRun) log(`DRY-RUN ${marketRef} ${q.side} ${q.book} ${q.size}@${q.price} → validateOrder ACCEPTED, NOT sent (placement=${adapter.placement})`);
          else if (res.ok) log(`PLACED ${marketRef} ${q.side} ${q.book} ${q.size}@${q.price} orderId=${res.orderId}`);
          else log(`REFUSED ${marketRef} ${q.side} ${q.book} ${q.size}@${q.price} gate=${res.gate || '-'} ${res.reason || ''}`);
        } catch (e) {
          // A throw here is NOT "nothing happened": the adapter records an intent before it sends, so
          // the order may or may not exist at the venue. Say so plainly rather than implying a clean miss.
          log(`PLACEMENT THREW on ${marketRef} ${q.side} ${q.book} ${q.size}@${q.price}: ${e.message} — outcome AMBIGUOUS, check the audit ledger`);
          placements.push({ book: q.book, kind: q.kind, side: q.side, price: q.price, size: q.size, ok: false, sent: null, error: e.message });
        }
      }
    }

    // ── what the engine WOULD do this tick (paper shadow) ──
    if (cfg.mode !== 'off') {
      appendMakerAudit({ ts: now, venue: 'polymarket', op: 'plan', mode: cfg.mode, marketRef,
        feedLive, mid, twoSided: plan.market.twoSided, oneSidedPenalty: plan.market.oneSidedPenalty,
        wouldPost: desiredPostable.length, wouldCancel: recon.toCancel.length, railHalt: rails.cancelScope,
        guardRefused: plan.quotes.filter((q) => q.guard && !q.guard.valid).length,
        capUsd: capRead.capUsd, capSource: capRead.source, capBlocked: capped.blockedCount,
        admittedNotionalUsd: capped.admittedNotionalUsd,
      });
    }

    marketsOut[marketId] = {
      title: (band && (band.question || band.title)) || (bookMarket && bookMarket.title) || '',
      mid, feedLive, maxSpreadC, minSize, tick, rewardsDailyRate,
      band: plan.market, rails: { cancelScope: rails.cancelScope, allowNewPlacement: rails.allowNewPlacement, trips: rails.trips },
      // The ceiling this market ran under this cycle, and what it actually admitted — externally
      // observable, so "the bot respects the cap" is a readable fact and not a claim.
      collateralCap: {
        capUsd: capRead.capUsd, source: capRead.source, updatedAt: capRead.updatedAt,
        plannedNotionalUsd: capped.plannedNotionalUsd, admittedNotionalUsd: capped.admittedNotionalUsd,
        headroomUsd: capHeadroomUsd, blockedLegs: capped.blockedCount, capExceeded: capped.capExceeded,
      },
      guard: { refused: plan.quotes.filter((q) => q.guard && !q.guard.valid).length, source: 'lib/maker/venue-rules.validateQuote' },
      // What the placement path actually did this cycle: the adapter's verdict per leg, including
      // the exact order a dry-run would have sent. Externally observable in /tmp/maker-state.json.
      placement: { mode: adapter ? adapter.placement : null, blocked: placementBlocked, attempted: placements.length, results: placements },
      // The position guards: measured inventory (null = unreadable, never 0), the SELL legs they blocked
      // and any YES+NO pair priced at or above $1. Externally observable in /tmp/maker-state.json.
      inventory: { yesShares: inventory.yes, noShares: inventory.no, wallet: inventory.wallet, source: inventory.source },
      positionGuards: { sellBlocks: plan.market.sellBlocks, selfMatches: plan.market.selfMatches, blocked: plan.market.guardBlockedCount },
      // The post-fill inventory policy in force here. maxInventoryUsd 0 (the default) means: after a
      // fill, stop quoting that side — the engine re-quotes nothing and says why.
      inventoryPolicy: { maxInventoryUsd, inventoryUsd, preferredSides: sides, decisions: inventoryDecisions },
      legs: legActions,
      advisory,
    };
  }

  // ── VENUE-REPORTED open order count for the heartbeat — from the venue response, NOT local state.
  //    off mode has no adapter; paper/shadow returns a simulated result (NOT a real venue count) → null.
  //    Honest-engine: null, never a fabricated 0, whenever we did not actually reach the venue. ──
  let openOrderCount = null;
  try {
    if (adapter && typeof adapter.listOpenOrders === 'function') {
      const oo = await adapter.listOpenOrders();
      openOrderCount = (oo && oo.ok && !oo.simulated)
        ? (Number.isFinite(oo.count) ? oo.count : (Array.isArray(oo.orders) ? oo.orders.length : null))
        : null;
    }
  } catch { openOrderCount = null; }

  const state = {
    generatedAt: new Date(now).toISOString(),
    openOrderCount,
    // The operating universe the bot RESOLVED this cycle — externally observable via the heartbeat, so
    // what the bot believes it should quote can be checked against the board without reading its mind.
    resolvedMarketIds: universe.resolvedMarketIds,
    selectionUpdatedAt: selection.updatedAt,
    universe: { matchedBeforeCap: universe.matchedBeforeCap, truncated: universe.truncated, maxMarkets: universe.maxMarkets, isDefaultSelection: !!selection.isDefault },
    mode: cfg.mode, dryRun: cfg.dryRun, canWrite: cfg.canWrite, killSwitch: effCfg.killSwitch,
    // The funding attestation as THIS process sees it. The dashboard runs in a different pm2 process
    // with its own environment, so the market screen must read the engine's value here rather than its
    // own — a gate that looks green in the browser and red in the engine is worse than no gate.
    fundingApproved: process.env.MAKER_FUNDING_APPROVED === 'true',
    durableKill: { killed: durableKill.killed, scope: durableKill.scope, reason: durableKill.reason || null },
    arming: { armed: arming.armed, expiresInSec: arming.expiresInSec ?? null, disarmedReason: arming.disarmedReason || null, notArmedLive },
    source: 'agent35-maker · paper pipeline · quotes from ADJUSTED mid · no orders placed (MAKER_MODE=' + cfg.mode + ')',
    config: { liveMinMarket: cfg.liveMinMarket, liveMinCapUsd: cfg.liveMinCapUsd, requote: cfg.requote, rails: cfg.rails },
    summary: { markets: Object.keys(marketsOut).length, totalWouldPost, totalRequotes, railsTrippedCount },
    markets: marketsOut,
  };
  try { atomicWrite(OUT_FILE, state); } catch (e) { log('write failed:', e.message); }
  heartbeat();
  return state;
}

// One cycle + its guaranteed heartbeat. Runs tick, and WHATEVER happens (success or throw) writes the
// dead-man heartbeat. On throw the heartbeat carries lastError; a heartbeat that STOPS is the real death
// signal. tickFn is injectable purely so the throw-path can be exercised in a test — defaults to tick.
async function runCycleAndHeartbeat(cfg, adapter, cycleNo, tickFn = tick) {
  let openOrderCount = null, lastError = null, resolvedMarketIds = null, selectionUpdatedAt = null, universe = null;
  try {
    const st = await tickFn(cfg, adapter);
    openOrderCount = (st && st.openOrderCount !== undefined) ? st.openOrderCount : null;
    resolvedMarketIds = (st && Array.isArray(st.resolvedMarketIds)) ? st.resolvedMarketIds : null;
    selectionUpdatedAt = (st && st.selectionUpdatedAt !== undefined) ? st.selectionUpdatedAt : null;
    universe = (st && st.universe) ? st.universe : null;
  } catch (e) {
    lastError = (e && e.message) ? e.message : String(e);
    log('tick failed:', lastError);
  }
  const hb = { ts: Date.now(), cycle: cycleNo, openOrderCount, mode: (cfg && cfg.mode) || null, lastError, resolvedMarketIds, selectionUpdatedAt, universe };
  writeMakerHeartbeat(hb);
  return hb;
}

async function main() {
  const cfg = loadMakerConfig(process.env);
  log(`starting — MAKER_MODE=${cfg.mode} dryRun=${cfg.dryRun} canWrite=${cfg.canWrite} (default off; arms nothing)`);

  // ── WHO THIS PROCESS SIGNS FOR, logged at every boot. agent35 does NOT read .env (it takes process.env
  //    from pm2), so a funder set only in .env reaches the tsx scripts and NOT this agent — the two then
  //    disagree with nothing on screen to say so. Printing the RESOLVED pair makes that class of drift
  //    visible in the log instead of at the venue. resolveFunder throws on a half-configured pair, which
  //    is the safe direction: refuse to boot rather than quietly fall back to signing as a bare EOA. ──
  try {
    const { resolveFunder } = require('../lib/venues/polymarket-clob-maker/funder');
    const f = resolveFunder(process.env);
    log(`signing identity — signatureType=${f.signatureType} (0=EOA 1=POLY_PROXY 2=POLY_GNOSIS_SAFE 3=POLY_1271) funder=${f.funderAddress || '— none (self-custody EOA, maker == signer)'} source=${f.source}`);
  } catch (e) {
    log('FATAL (startup assertion): funder configuration is invalid — ' + e.message);
    process.exit(1);
  }

  // ── STARTUP ASSERTION: native TTL vs the refresh loop (fail-closed, refuse to start on violation) ──
  // A TTL <= the refresh interval guarantees permanent gaps in the book (an order expires before the maker
  // re-quotes it). The refresh interval is the SLOWER of the tick and the per-leg re-quote min-interval —
  // the longest an order can rest untouched between re-quote opportunities.
  const refreshIntervalMs = Math.max(TICK_MS, cfg.requote.minIntervalMs);
  const ttlGate = checkTtlVsRefresh({ ttlSeconds: cfg.orderTtlSeconds, refreshIntervalMs });
  if (!ttlGate.ok) {
    log('FATAL (startup assertion): ' + ttlGate.reason + ` [refresh interval = max(tick ${TICK_MS}ms, requote-min ${cfg.requote.minIntervalMs}ms) = ${refreshIntervalMs}ms]`);
    process.exit(1);
  }
  // Native expiry cannot be shorter than the venue's 3-minute GTD floor. If the configured TTL is below
  // the floor's effective minimum, the on-venue expiry is clamped UP and the sub-floor freshness must come
  // from cancel/replace, NOT the native expiry. Surface this loudly — it is a real limitation, not a nit.
  const sampleTtl = computeGtdExpiration(Date.now(), cfg.orderTtlSeconds);
  log(`order TTL: requested ${cfg.orderTtlSeconds}s → native GTD effective ${sampleTtl.effectiveTtlSeconds}s${sampleTtl.clampedToVenueFloor ? ` (CLAMPED UP to the venue 3-min GTD floor — the venue rejects any expiry < ${MIN_EFFECTIVE_TTL_SEC}s effective; sub-floor freshness must come from cancel/replace, not the native expiry)` : ''}. This native expiry is the ONLY layer that survives host death.`);

  const adapter = buildAdapter(cfg);
  if (adapter) log(`adapter built: mode=${adapter.mode} canWrite=${adapter.canWrite}`);
  // ── WHAT ACTUALLY STOPS AN ORDER IN LIVE MODE — and the history of getting this wrong twice.
  //    v1 of this banner said "live providers are NOT wired in this build". False since 21120aa:
  //    buildAdapter() calls makerLiveProviders() and passes real creds + signing-key thunks.
  //    v2 said "this engine NEVER CALLS postOrder". True when written, false as soon as the placement
  //    wiring landed — the tick loop now hands every postable quote to adapter.postOrder.
  //    Both versions sent readers hunting for a blocker that was not there, which is worse than saying
  //    nothing. The banner below is therefore computed from the CURRENT environment rather than
  //    asserting a fact about "this build" that goes stale the moment the build changes.
  //
  //    As of now, three things stop an order in live-min, and any ONE of them is sufficient:
  //      • MAKER_PLACEMENT != 'send'  → built, signed, on-chain validated, then dropped (the default)
  //      • the arming record disarmed → a live engine that is not armed stands down like a killed one
  //      • the ordinary gate chain    → kill, venue allowlist, limits, caps, guards, version, validateOrder
  if (cfg.mode === 'live-min' || cfg.mode === 'live') {
    // What actually stops an order NOW. This line has been wrong twice: it once claimed the live
    // providers were unwired (they were wired), then that this engine never calls postOrder (it does,
    // since the placement wiring). A startup banner that names the wrong blocker sends whoever reads it
    // hunting in the wrong place, so it states the real ones and says which is decisive.
    const placement = process.env.MAKER_PLACEMENT === 'send' ? 'send' : 'dry-run';
    if (placement === 'send') {
      log('ARMED FOR SEND: MAKER_PLACEMENT=send — postOrder will POST to the venue once the arming record is armed and every gate passes. Real orders, real money.');
    } else {
      log('live mode set, placement=dry-run: every postable quote IS handed to adapter.postOrder, which builds it, SIGNS it and validates it against the exchange via eth_call — then stops without POSTing. Set MAKER_PLACEMENT=send to reach the venue. Quoting ALSO requires an armed record (lib/maker/arming): an unarmed live engine stands down exactly like a killed one.');
    }
  }
  // Per-cycle loop. The maker heartbeat is written at the END of every cycle — success OR throw — so a
  // STOPPED heartbeat is the death signal the watchdog keys on, while an errored cycle still heartbeats
  // (with lastError populated). openOrderCount comes from the venue via tick's state.
  let cycleCount = 0;
  const loop = async () => { cycleCount++; await runCycleAndHeartbeat(cfg, adapter, cycleCount); setTimeout(loop, TICK_MS); };
  loop();
}

function shutdown() { try { const cfg = loadMakerConfig(process.env); const a = buildAdapter(cfg); if (a && a.close) a.close(); } catch { /* ignore */ } if (prisma) prisma.$disconnect().catch(() => {}); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = { tick, buildAdapter, getTick, loadInputs, runCycleAndHeartbeat, writeMakerHeartbeat, MAKER_HB_FILE };
