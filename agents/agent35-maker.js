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
//   • live-min / live → constructs the maker adapter with credsProvider/signerProvider. In THIS build
//     those providers THROW (live wiring is a separate reviewed change, exactly like the news-guard
//     cancel adapter). So even MAKER_MODE=live cannot obtain a key to sign an order here.
//
// Reward math, the news-guard, the structural-baseline gate, entitlement/redaction and the cancel-only
// adapter are all REUSED, never changed. All quoting is off the ADJUSTED mid (agent34), never plain mid.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { httpGet } = require('../lib/httpGet');
const { loadMakerConfig } = require('../lib/maker/config');
const { planQuotes } = require('../lib/maker/quote-plan');
const { earningRange } = require('../lib/maker/earning-range');
const { decideRequote, planRequoteOrdering } = require('../lib/maker/requote-policy');
const { evaluateRails } = require('../lib/maker/risk-rails');
const { reconcile } = require('../lib/maker/reconcile');
const { legTarget } = require('../lib/rewards-live-band');
const { scoreOrder } = require('../lib/rewardScore');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { createMakerAdapter } = require('../lib/venues/polymarket-clob-maker/adapter');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');

const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';        // agent34 (adjusted mid + live/stale)
const WATCHLIST_FILE  = '/root/prediction-market/data/liquidity-rewards.json'; // band config + rewardsDailyRate
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';       // carries rewardScore per market
const NEWS_STATE_FILE = '/tmp/news-guard-state.json';        // per-market severity, if present
const OUT_FILE        = '/tmp/maker-state.json';
const HB_FILE         = '/tmp/agent-heartbeats.json';
const CLOB_BASE       = 'https://clob.polymarket.com';
const UA = 'edgeradar-agent35-maker/1.0';

const TICK_MS = Number(process.env.MAKER_TICK_MS || 3_000);
const DEFAULT_SIZE_SHARES = Number(process.env.MAKER_DEFAULT_SIZE || 200);
const OUT_OF_BOOK_MODEL_MS = Number(process.env.MAKER_OUT_OF_BOOK_MS || 400); // modelled cancel→replace gap in paper

const log = (...a) => console.log(new Date().toISOString(), '[agent35-maker]', ...a);

let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); } catch { /* legs unavailable → engine idles honestly */ }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function atomicWrite(file, obj) { const t = `${file}.tmp.${process.pid}`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file); }
function heartbeat() { const hb = readJson(HB_FILE) || {}; hb['agent35-maker'] = Date.now(); try { atomicWrite(HB_FILE, hb); } catch { /* best-effort */ } }

// ── build the maker adapter for the current mode. off/paper → no providers (canWrite false). live modes
//    → throwing providers (live wiring is a separate reviewed change; even live can't place here). ──
function buildAdapter(cfg) {
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'paper' || cfg.dryRun) return createMakerAdapter({ mode: 'paper', dryRun: cfg.dryRun });
  const throwProvider = async () => { throw new Error('live maker provider is not wired in this build — arming (custody signer + L2 creds) is a separate reviewed change (see lib/venues/polymarket-clob-maker/credentials.ts + scripts/polymarket-maker-store-key.ts)'); };
  return createMakerAdapter({ mode: cfg.mode, liveMinCapUsd: cfg.liveMinCapUsd, credsProvider: throwProvider, signerProvider: throwProvider });
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
  const newsByMarket = new Map();
  for (const [mid, s] of Object.entries((news && news.markets) || {})) newsByMarket.set(mid, s && s.severity);
  return { books, bandByMarket, rewardScoreByMarket, newsByMarket };
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
  const { books, bandByMarket, rewardScoreByMarket, newsByMarket } = loadInputs();
  const legsByMarket = await loadLegs();
  const ngCfg = loadNewsGuardConfig(process.env);

  const globalState = { dailyPnlUsd: 0, totalExposureUsd: 0, recentErrorCount: 0 }; // paper: no realised P&L/exposure
  const marketsOut = {};
  let totalRequotes = 0, totalWouldPost = 0, railsTrippedCount = 0;

  for (const [marketId, legs] of legsByMarket) {
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
      config: cfg,
    });
    if (rails.trips.length) railsTrippedCount += rails.trips.length;

    // ── desired quotes (Phase 3) ──
    const plan = planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId, tokenIdNo, defaultSizeShares: DEFAULT_SIZE_SHARES });

    // ── earning-range advisory (Phase 4) — measure competing depth from the FULL REST ladder (agent34's
    //    snapshot has only best bid/ask). null book → advisory shows "—", never a fabricated 100% share. ──
    const advisoryBook = tokenId ? await getRestBook(tokenId) : null;
    const advisory = earningRange({ book: advisoryBook, mid, maxSpreadC, minSize, rewardsDailyRate, capitalUsd: 1000 });

    // ── re-quote decisions (Phase 5) + reward-vs-baseline accrual ──
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

      if (q.postable && feedLive) totalWouldPost++;
      legActions.push({ book: q.book, kind: q.kind, side: q.side, mode: q.mode, targetPrice: q.price, size: q.size, notionalUsd: q.notionalUsd, distanceC: q.distanceC, expectedScore: q.score, inBandNow: q.inBandNow, belowMinSize: q.belowMinSize, neverEarns: q.neverEarns, postable: q.postable, reason: q.reason, requote: dec.requote, requoteReason: dec.reason, outOfBookMs, ordering: ordering.order, rewardVsBaseline });
    }

    // ── reconcile (Phase 5): in paper we hold no venue orders, so desired == toPlace (belief starts empty) ──
    const desiredPostable = plan.quotes.filter(q => q.postable);
    const recon = reconcile({ desired: desiredPostable, venueOrders: [], tick });

    // ── what the engine WOULD do this tick (paper shadow) ──
    if (cfg.mode !== 'off') {
      appendMakerAudit({ ts: now, venue: 'polymarket', op: 'plan', mode: cfg.mode, marketRef,
        feedLive, mid, twoSided: plan.market.twoSided, oneSidedPenalty: plan.market.oneSidedPenalty,
        wouldPost: desiredPostable.length, wouldCancel: recon.toCancel.length, railHalt: rails.cancelScope,
      });
    }

    marketsOut[marketId] = {
      title: (band && (band.question || band.title)) || (bookMarket && bookMarket.title) || '',
      mid, feedLive, maxSpreadC, minSize, tick, rewardsDailyRate,
      band: plan.market, rails: { cancelScope: rails.cancelScope, allowNewPlacement: rails.allowNewPlacement, trips: rails.trips },
      legs: legActions,
      advisory,
    };
  }

  const state = {
    generatedAt: new Date(now).toISOString(),
    mode: cfg.mode, dryRun: cfg.dryRun, canWrite: cfg.canWrite, killSwitch: cfg.killSwitch,
    source: 'agent35-maker · paper pipeline · quotes from ADJUSTED mid · no orders placed (MAKER_MODE=' + cfg.mode + ')',
    config: { liveMinMarket: cfg.liveMinMarket, liveMinCapUsd: cfg.liveMinCapUsd, requote: cfg.requote, rails: cfg.rails },
    summary: { markets: Object.keys(marketsOut).length, totalWouldPost, totalRequotes, railsTrippedCount },
    markets: marketsOut,
  };
  try { atomicWrite(OUT_FILE, state); } catch (e) { log('write failed:', e.message); }
  heartbeat();
  return state;
}

async function main() {
  const cfg = loadMakerConfig(process.env);
  log(`starting — MAKER_MODE=${cfg.mode} dryRun=${cfg.dryRun} canWrite=${cfg.canWrite} (default off; arms nothing)`);
  const adapter = buildAdapter(cfg);
  if (adapter) log(`adapter built: mode=${adapter.mode} canWrite=${adapter.canWrite}`);
  // Refuse to silently run live without wired providers — a forced live call would throw; log it once.
  if (cfg.mode === 'live-min' || cfg.mode === 'live') log('WARNING: live mode set, but live providers are NOT wired in this build — no order can be signed. This is intentional (arming is a separate reviewed change).');
  const loop = () => tick(cfg, adapter).catch(e => log('tick failed:', e.message)).finally(() => setTimeout(loop, TICK_MS));
  loop();
}

function shutdown() { try { const cfg = loadMakerConfig(process.env); const a = buildAdapter(cfg); if (a && a.close) a.close(); } catch { /* ignore */ } if (prisma) prisma.$disconnect().catch(() => {}); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = { tick, buildAdapter, getTick, loadInputs };
