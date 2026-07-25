#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent34-clob-ws — LIVE Polymarket CLOB order books for liquidity-rewards.
//
// HONEST ENGINE / SAFETY:
//   • Read-only. The market channel is public + keyless and carries NO order path.
//     This process cannot place, cancel, or sign anything. €0 — reuses the `ws`
//     package already in the tree (no new dependency).
//   • A book is served as LIVE only when it is seeded, fresh, and not flagged for
//     resnapshot. Otherwise it is written as STALE and consumers fall back to the
//     15-min REST path and are TOLD they are on the slower path. We never label a
//     book behind a dead/lagging socket as live.
//   • Failure isolation: this is its OWN pm2 process, NOT folded into agent27, so a
//     dead socket can never stall the news-guard or the dashboard. autorestart:true.
//   • Bounded: subscribes only to reward-eligible markets (+ persisted user legs,
//     wired in a later commit), never "everything", capped at SUBSCRIPTION_CAP.
//
// Reward math is NOT changed here. We compute BOTH the plain mid (what the live UI
// shows today) and the dust-filtered adjusted mid (what actually scores rewards)
// and write both, plus their difference, so the divergence can be MEASURED and
// reported before any consumer switches. lib/rewardScore.js remains the SSOT.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { ClobWsClient } = require('../lib/clob-ws/client');
const { LiveBookStore } = require('../lib/clob-ws/live-book');
const { httpGet } = require('../lib/httpGet');
const { adjustedMid, parseOrders, scoreBook, quadraticUserShare } = require('../lib/rewardScore');
const REWARD_REF_CAPITAL = 1000; // MUST match lib/rewards-normalize REWARD_REF_CAPITAL (refShare capital)
const { decideDrift } = require('../lib/rewards-drift');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { appendDriftShadowRecord } = require('../lib/news-guard/shadow-log');
const { estRewardForgone } = require('../lib/news-guard/action');

// ── config ──
const WATCHLIST_FILE = '/root/prediction-market/data/liquidity-rewards.json'; // agent24 output
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';                        // normalized (carries rewardScore)
const OUT_FILE       = '/tmp/clob-live-books.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
// Self-describing COVERAGE manifest for the mid-history journal. The journal only covers the markets
// agent34 subscribes to (a subset of the rewards universe), so a backtest must state that. This records
// the universe size AT COLLECTION TIME (not a later drifting feed read) so the mandated coverage header
// (lib/mid-history-coverage) is honest for the day the data was collected.
const COVERAGE_FILE  = path.join(__dirname, '..', 'data', 'mid-history-coverage.json');
const CLOB_BASE      = 'https://clob.polymarket.com';

const SUBSCRIPTION_CAP = 60;          // markets (× 2 tokens = ≤120 assets; well under the ~250/conn cap)
const WRITE_INTERVAL_MS = 3_000;      // recompute + persist snapshot cadence
const REFRESH_MARKETS_MS = 60_000;    // re-read the watchlist for adds/drops
const STALE_MS = 30_000;              // no event within this ⇒ that book is STALE (≈3 heartbeats)
const RESNAPSHOT_MIN_GAP_MS = 5_000;  // don't hammer REST for the same asset
const STARTUP_DELAY_MS = 8_000;
// Ladder depth persisted per side, per token. The event terminal renders a book, not a market-data
// archive: 12 levels covers the visible ladder plus a couple of rows of context. BOUNDED ON PURPOSE —
// the in-memory store already holds the full book, and dumping it every 3s would grow this file with
// the depth of the most active market rather than with anything the UI shows.
const LADDER_LEVELS = 12;
const UA = 'edgeradar-agent34-clob-ws/1.0 (read-only)';

// ── MID-HISTORY sampling (append-only observation log for the rewards backtest) ──
// One JSONL line per market per sample, appended to a daily-rotated file. This is PURELY an append of
// data already held in memory (the live book + the same size-cutoff adjusted mid the reward math uses);
// it changes NO existing output, no estimate, and touches no order path. Memory-safe by construction:
//   • append STREAM (flags:'a') — never read the file back, never buffer the day in memory;
//   • rotate per UTC day → data/mid-history-YYYY-MM-DD.jsonl;
//   • retention: on each rotation, delete mid-history files older than MID_HISTORY_RETENTION_DAYS.
// Interval: the spec's 15s × 60 markets × ~380 B/row ≈ 131 MB/day exceeds the 50 MB/day box budget, so
// the interval is raised to the finest value that stays under it at the subscription cap (measured below).
const MID_HISTORY_DIR = '/root/prediction-market/data';
const MID_HISTORY_INTERVAL_MS = Number(process.env.MID_HISTORY_INTERVAL_MS || 45_000);
const MID_HISTORY_RETENTION_DAYS = 14;

const log = (...a) => console.log(new Date().toISOString(), '[agent34]', ...a);

// Lazy Prisma — legs are persisted user data (RewardsLeg). If the client/DB isn't
// available the agent still serves the watchlist; leg markets are simply not unioned
// in. We read only DISTINCT marketIds here — never leg prices/contents — and never log them.
let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); } catch { /* watchlist-only */ }
const resolvedTokens = new Map(); // conditionId -> { tokenId, tokenIdNo } (CLOB-resolved, cached)

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function heartbeat() {
  const hb = readJsonSafe(HB_FILE) || {};
  hb['agent34-clob-ws'] = Date.now();
  try { atomicWrite(HB_FILE, hb); } catch { /* best-effort */ }
}

// ── desired markets: reward-eligible watchlist (persisted user legs unioned in a
// later commit via collectLegMarkets). Returns a Map<conditionId, marketMeta>. ──
function collectDesiredMarkets() {
  const out = new Map();
  const d = readJsonSafe(WATCHLIST_FILE);
  const markets = (d && d.markets) || [];
  for (const m of markets) {
    if (!m.tokenId || !m.conditionId) continue;
    out.set(m.conditionId, {
      conditionId: m.conditionId,
      tokenId: String(m.tokenId),
      tokenIdNo: m.tokenIdNo ? String(m.tokenIdNo) : null,
      minSize: Number(m.rewardsMinSize || m.minSize || 1) || 1,
      maxSpread: Number(m.rewardsMaxSpread ?? m.maxSpread) || null, // cents; band radius = /2
      tick: Number(m.tickSize) > 0 ? Number(m.tickSize) : null,     // venue min tick (agent24 /tick-size); null if unknown
      title: (m.question || m.title || '').slice(0, 120),
    });
    if (out.size >= SUBSCRIPTION_CAP) break;
  }
  return out;
}

// Resolve YES/NO token ids for a conditionId via the CLOB (cached). Needed for
// leg-only markets that aren't in the reward-eligible watchlist file.
async function resolveTokens(conditionId) {
  if (resolvedTokens.has(conditionId)) return resolvedTokens.get(conditionId);
  try {
    const r = await httpGet(`${CLOB_BASE}/markets/${conditionId}`, { timeoutMs: 6_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const tokens = r && r.status === 200 && Array.isArray(r.data.tokens) ? r.data.tokens : [];
    const yes = tokens.find(t => t.outcome === 'Yes');
    const no = tokens.find(t => t.outcome === 'No');
    const rec = { tokenId: yes ? String(yes.token_id) : null, tokenIdNo: no ? String(no.token_id) : null };
    if (rec.tokenId) resolvedTokens.set(conditionId, rec);
    return rec;
  } catch { return { tokenId: null, tokenIdNo: null }; }
}

// Union in markets where ANY user has a persisted leg (Phase 2). We read only the
// DISTINCT (marketId, venue) — never any leg's price/side/contents. Mutates `into`.
async function unionLegMarkets(into) {
  if (!prisma) return;
  let rows = [];
  try {
    rows = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket' }, distinct: ['marketId'], select: { marketId: true } });
  } catch (e) { log('leg-market query failed (watchlist-only this cycle):', e.message); return; }
  for (const { marketId } of rows) {
    if (into.has(marketId)) continue;            // already covered by the watchlist
    if (into.size >= SUBSCRIPTION_CAP) break;     // stay bounded — never subscribe to everything
    const t = await resolveTokens(marketId);
    if (!t.tokenId) continue;                      // unresolvable → skip, never fabricate a token
    into.set(marketId, {
      conditionId: marketId,
      tokenId: t.tokenId,
      tokenIdNo: t.tokenIdNo,
      minSize: 1,          // unknown for off-watchlist markets → conservative; band stays null
      maxSpread: null,     // no reward-band config known → band null (mid/drift still tracked)
      tick: null,          // off-watchlist market → venue tick unknown here → null (never fabricated)
      title: '',
      fromLeg: true,
    });
  }
}

const store = new LiveBookStore();
const client = new ClobWsClient({ logger: (...a) => log('[ws]', ...a) });
let desired = new Map();            // conditionId -> meta
let assetToMarket = new Map();      // assetId -> { conditionId, side:'yes'|'no', meta }
const lastResnapshotAt = new Map(); // assetId -> ts (throttle REST)
let reconnects = 0, watchdogReconnects = 0, restSnapshots = 0, droppedForCap = 0;
let driftSignals = 0;
let midHistoryStream = null;       // { day, stream } — the daily-rotated append stream (never read back)
let midHistoryRows = 0;            // rows appended this process lifetime (observability only)

// ── drift-advisory state (Phase 4). Legs are persisted user data; we track per-leg
// time-in/out-of-band and emit SHADOW DriftSignals through the news-guard rails. ──
let ngConfig = { armed: false, killSwitch: false, cooldownMs: 6 * 3_600_000, maxPerHour: 20 };
let legsByMarket = new Map();      // conditionId -> [RewardsLeg rows]
let placementByKey = new Map();    // `${userId}:${marketId}` -> placement (for est $/day)
let rewardScoreByMarket = new Map(); // marketId -> rewardScore object (from normalized snapshot)
const driftTime = new Map();       // leg.id -> { lastTs, inBandMs, outBandMs, prevInBand }
const driftCooldown = new Map();   // leg.id -> ts of last emitted signal
let driftHourly = [];              // timestamps of emitted signals in the last hour

client.on('close', () => { reconnects++; });
client.on('watchdog-reconnect', () => { watchdogReconnects++; });
client.on('open', () => {
  // Missed deltas during any gap are unrecoverable → REST-resnapshot every asset
  // before trusting the stream again.
  resnapshotAll('ws-open').catch(e => log('resnapshot on open failed:', e.message));
});
client.on('event', (ev, now) => { store.ingest(ev, now); });

async function restBook(tokenId) {
  const r = await httpGet(`${CLOB_BASE}/book?token_id=${tokenId}`, { timeoutMs: 6_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return r && r.status === 200 ? r.data : null;
}

async function resnapshotAsset(assetId, reason) {
  const now = Date.now();
  if (now - (lastResnapshotAt.get(assetId) || 0) < RESNAPSHOT_MIN_GAP_MS) return;
  lastResnapshotAt.set(assetId, now);
  try {
    const b = await restBook(assetId);
    if (b) { store.applySnapshot(assetId, b, Date.now()); restSnapshots++; }
  } catch (e) { log(`resnapshot ${assetId.slice(-8)} (${reason}) failed:`, e.message); }
}

async function resnapshotAll(reason) {
  const ids = [...assetToMarket.keys()];
  for (const id of ids) await resnapshotAsset(id, reason);
}

// Reconcile subscriptions to the current desired set. Adds/drops on the live socket.
async function reconcileSubscriptions() {
  desired = collectDesiredMarkets();
  await unionLegMarkets(desired);   // Phase 2: + markets where a user has legs
  await loadDriftInputs();          // Phase 4: refresh legs/placements/rewardScore/rails
  const nextAssets = new Map();
  for (const meta of desired.values()) {
    nextAssets.set(meta.tokenId, { conditionId: meta.conditionId, side: 'yes', meta });
    if (meta.tokenIdNo) nextAssets.set(meta.tokenIdNo, { conditionId: meta.conditionId, side: 'no', meta });
  }
  const add = [...nextAssets.keys()].filter(a => !assetToMarket.has(a));
  const drop = [...assetToMarket.keys()].filter(a => !nextAssets.has(a));
  assetToMarket = nextAssets;
  if (add.length) { client.subscribe(add); add.forEach(a => resnapshotAsset(a, 'new-sub')); }
  if (drop.length) { client.unsubscribe(drop); drop.forEach(a => store.remove(a)); }
  if (add.length || drop.length) log(`subs reconciled: +${add.length} -${drop.length} (markets=${desired.size}, assets=${assetToMarket.size})`);
  writeCoverageManifest();   // keep the coverage manifest current with the subscribed set + the live universe size
}

// Compute per-side mids from a live book. Returns null fields when a side isn't seeded.
function sideView(assetId, minSize, now) {
  const b = store.getBook(assetId);
  const fr = store.freshness(assetId, STALE_MS, now);
  if (!b) return { live: false, reason: fr.reason, ageMs: fr.ageMs, plainMid: null, adjustedMid: null, bestBid: null, bestAsk: null, needsResnapshot: true };
  const bids = parseOrders(b.bids, true);
  const asks = parseOrders(b.asks, false);
  const bestBid = bids[0] ? bids[0].price : null;
  const bestAsk = asks[0] ? asks[0].price : null;
  const plainMid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const adjMid = adjustedMid(bids, asks, minSize, null);
  // The ladder itself, top-of-book first, capped at LADDER_LEVELS. parseOrders already returns bids
  // descending and asks ascending, so the slice is genuinely the top of each stack. These are the
  // SAME level objects the mid/depth math above consumed — one book, not a second fetch.
  const ladder = (arr) => arr.slice(0, LADDER_LEVELS).map((o) => ({ price: o.price, size: o.size }));
  return {
    live: fr.live, reason: fr.reason, ageMs: fr.ageMs,
    bestBid, bestAsk, plainMid,
    adjustedMid: adjMid != null ? adjMid : null,
    needsResnapshot: b.needsResnapshot,
    // Levels beyond the cap exist in the book but are NOT in this file — stated so a consumer never
    // reads the truncated ladder as the whole book.
    levels: { bids: ladder(bids), asks: ladder(asks), cap: LADDER_LEVELS, bidCount: bids.length, askCount: asks.length },
  };
}

// In-band $ (Σ price×size) around a mid, no size cutoff — matches agent24 existing_depth_usd so the live
// depth is the same measure the scan produces. Returns 0 when the band/mid is unknown or the side empty.
function inBandUsd(orders, mid, bandRadiusC) {
  if (mid == null || bandRadiusC == null || !(bandRadiusC > 0)) return 0;
  const r = bandRadiusC / 100;
  let usd = 0;
  for (const o of orders) if (o.price >= mid - r - 1e-12 && o.price <= mid + r + 1e-12) usd += o.price * o.size;
  return usd;
}

// A COHERENT live reward observation from the full live books at ONE instant — mid, competitorQ, refShare
// and the two-sided in-band depth all measured together, via the SAME SSOT the scan uses (scoreBook +
// quadraticUserShare). This is what lets the API upgrade a covered row WITHOUT ever pairing a live mid
// with a scan-time depth: the whole block travels together. Returns null (→ the API keeps the scan block)
// when the book is not live, has no reward band, or cannot be scored. Never fabricates.
function liveRewardObs(meta, now) {
  if (meta.maxSpread == null || !(meta.maxSpread > 0)) return null;   // no band → cannot score coherently
  const fr = store.freshness(meta.tokenId, STALE_MS, now);
  if (!fr.live) return null;                                          // not fresh → stay at scan speed (never mix)
  const bYes = store.getBook(meta.tokenId);
  if (!bYes) return null;
  const bids = parseOrders(bYes.bids, true);
  const asks = parseOrders(bYes.asks, false);
  const mid = adjustedMid(bids, asks, meta.minSize, null);
  if (mid == null) return null;
  const v = meta.maxSpread;                                           // full band (cents); radius = v/2
  const sc = scoreBook({ bids, asks }, v, meta.minSize, mid);         // { Qbids, Qasks, Qmin, mid }
  const competitorQ = sc.Qmin;
  const refShare = quadraticUserShare(competitorQ, mid, v, meta.minSize, REWARD_REF_CAPITAL, v / 4);
  if (refShare == null) return null;
  // Two-sided in-band $ at THIS instant (YES around its mid + NO around its mid), same measure as the scan.
  const depthYes = inBandUsd([...bids, ...asks], mid, v / 2);
  let depthNo = 0;
  if (meta.tokenIdNo) {
    const bNo = store.getBook(meta.tokenIdNo);
    if (bNo) {
      const nb = parseOrders(bNo.bids, true), na = parseOrders(bNo.asks, false);
      const midNo = adjustedMid(nb, na, meta.minSize, null);
      depthNo = inBandUsd([...nb, ...na], midNo, v / 2);
    }
  }
  return {
    observedAt: new Date(now).toISOString(),
    ageMs: fr.ageMs,
    mid: Math.round(mid * 1e6) / 1e6,
    competitorQ: Math.round(competitorQ * 1e4) / 1e4,
    refShare: Math.round(refShare * 1e6) / 1e6,
    minSize: meta.minSize,
    maxSpreadCents: v,
    inBandDepthUsd: Math.round((depthYes + depthNo) * 100) / 100,
  };
}

function buildSnapshot() {
  const now = Date.now();
  const markets = {};
  for (const meta of desired.values()) {
    const yes = sideView(meta.tokenId, meta.minSize, now);
    const no = meta.tokenIdNo ? sideView(meta.tokenIdNo, meta.minSize, now) : null;
    // Market-level mid/band anchor on the YES token (the reward book), matching agent24.
    const mid = yes.adjustedMid;
    const plainMid = yes.plainMid;
    const bandRadiusC = meta.maxSpread != null ? meta.maxSpread / 2 : null;
    // The divergence, MEASURED not acted on: adjusted − plain, in cents.
    const midAdjVsPlainC = (mid != null && plainMid != null) ? Math.round((mid - plainMid) * 1000) / 10 : null;
    markets[meta.conditionId] = {
      tokenId: meta.tokenId,
      tokenIdNo: meta.tokenIdNo,
      title: meta.title,
      minSize: meta.minSize,
      maxSpread: meta.maxSpread,
      bandRadiusC,
      mid, plainMid, midAdjVsPlainC,
      live: yes.live,
      ageMs: yes.ageMs,
      // COHERENT live reward observation (mid + competitorQ + refShare + depth, one instant) — null when
      // the book is not live / no band / unscoreable, in which case the API keeps the coherent scan block.
      rewardObs: liveRewardObs(meta, now),
      yes, no,
    };
  }
  const rss = process.memoryUsage().rss;
  return {
    generatedAt: new Date(now).toISOString(),
    source: 'Polymarket CLOB market channel · live · read-only · no orders placed',
    feed: {
      connected: client.connected,
      silentMs: client.connected ? client.silenceMs(now) : null,
      subscriptions: assetToMarket.size,
      markets: desired.size,
      reconnects, watchdogReconnects, restSnapshots,
    },
    staleMs: STALE_MS,
    markets,
    memory: {
      rssMB: Math.round(rss / 1e5) / 10,
      liveBookBytes: store.memoryBytesEstimate(),
      bytesPerSubscription: assetToMarket.size ? Math.round(store.memoryBytesEstimate() / assetToMarket.size) : 0,
      tokens: assetToMarket.size,
    },
  };
}

// Refresh the drift inputs: persisted legs (user data — full rows needed here to
// compute band position, but contents are NEVER logged), the user's placement (for
// est $/day), the market rewardScore (from the normalized snapshot), and the live
// news-guard rail config. Called on the slow reconcile cadence, not every tick.
async function loadDriftInputs() {
  ngConfig = loadNewsGuardConfig(process.env);
  // rewardScore per market from the normalized snapshot.
  rewardScoreByMarket = new Map();
  const snap = readJsonSafe(NORMALIZED_FILE);
  for (const m of (snap && snap.markets) || []) {
    if (m.marketId && m.rewardScore) rewardScoreByMarket.set(m.marketId, m.rewardScore);
  }
  if (!prisma) { legsByMarket = new Map(); placementByKey = new Map(); return; }
  try {
    const legs = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket' } });
    const byMarket = new Map();
    for (const l of legs) {
      if (!byMarket.has(l.marketId)) byMarket.set(l.marketId, []);
      byMarket.get(l.marketId).push(l);
    }
    legsByMarket = byMarket;
    const pls = await prisma.rewardsPlacement.findMany({ where: { venue: 'polymarket' } });
    placementByKey = new Map(pls.map(p => [`${p.userId}:${p.marketId}`, p]));
  } catch (e) {
    log('drift-input load failed (drift paused this cycle):', e.message);
    legsByMarket = new Map(); placementByKey = new Map();
  }
}

// Evaluate drift for every persisted leg against the live book. Emits SHADOW records
// only; can never execute. Respects kill-switch, cooldown, hourly cap, structural gate.
function runDrift(snapshot, now) {
  if (legsByMarket.size === 0) return;
  driftHourly = driftHourly.filter(t => now - t < 3_600_000);
  for (const [marketId, legs] of legsByMarket) {
    const mk = snapshot.markets[marketId];
    if (!mk) continue;                                    // not subscribed → cannot judge
    const feedState = mk.live ? 'live' : 'stale';
    const oneSided = !mk.yes || mk.yes.bestBid == null || mk.yes.bestAsk == null;
    const rewardScore = rewardScoreByMarket.get(marketId) || null;
    for (const leg of legs) {
      // est $/day for THIS user's placement (from rewardScore only; null when absent).
      const placement = placementByKey.get(`${leg.userId}:${marketId}`) || null;
      const forg = (rewardScore && placement)
        ? estRewardForgone({ rewardScore }, placement, ngConfig.cooldownMs)
        : null;
      const market = {
        mid: mk.mid, maxSpread: mk.maxSpread, feedState, oneSided,
        estDailyUsd: forg ? forg.estDailyUsd : null,
      };
      const rails = {
        cooldownActive: driftCooldown.get(leg.id) != null && (now - driftCooldown.get(leg.id)) < ngConfig.cooldownMs,
        hourlyCapReached: driftHourly.length >= ngConfig.maxPerHour,
      };
      const out = decideDrift({ leg, market, timeState: driftTime.get(leg.id), config: ngConfig, rails, now });
      driftTime.set(leg.id, out.timeState);
      if (out.record && out.record.decision === 'drift') {
        appendDriftShadowRecord(out.record);   // scrubbed + appended to the drift shadow dataset
        driftSignals++;
        if (out.consumesSlot) { driftCooldown.set(leg.id, now); driftHourly.push(now); }
      }
    }
  }
}

// Write the coverage manifest, captured at collection time. The denominator a backtest MUST use is the
// COLLECTABLE universe, not the full published one: Kalshi's liquidity-rewards program is US-only
// (help.kalshi.com/en/articles/13823851-liquidity-incentive-program — "International, non-U.S. users
// ineligible for rewards") and this operator is in the EU, so Kalshi markets are structurally
// uncollectable AND uncoverable by this Polymarket CLOB feed. universeMarketCount is therefore the
// Polymarket-only count; the full poly+kalshi total is kept alongside for transparency. A missing
// universe file ⇒ universeMarketCount null (the coverage header then fails honest → partial + below-half).
function writeCoverageManifest() {
  const norm = readJsonSafe(NORMALIZED_FILE);
  const all = (norm && Array.isArray(norm.markets)) ? norm.markets : null;
  const collectable = all ? all.filter((m) => m && m.venue === 'polymarket').length : null;
  const full = all ? all.length : null;
  const manifest = {
    at: new Date().toISOString(),
    subscribedMarketCount: desired.size,           // markets this journal currently covers
    subscriptionCap: SUBSCRIPTION_CAP,             // the hard bound on coverage
    universeMarketCount: collectable,              // COLLECTABLE universe (Polymarket only) — the denominator to use
    universeMarketCountFull: full,                 // full published universe (poly + kalshi) — transparency only
    kalshiExcludedCount: (full != null && collectable != null) ? full - collectable : null,
    sampleIntervalMs: MID_HISTORY_INTERVAL_MS,
    note: 'Denominator = COLLECTABLE universe (Polymarket only). Kalshi liquidity rewards are US-only (help.kalshi.com/en/articles/13823851-liquidity-incentive-program) and this operator is in the EU, so Kalshi is not collectable and is excluded from the coverage denominator. A backtest must call lib/mid-history-coverage.coverageHeader and print its header before any result.',
  };
  try { atomicWrite(COVERAGE_FILE, manifest); } catch (e) { log('coverage manifest write failed:', e.message); }
}

// ── mid-history: rotation + 14-day retention ──
// Retention runs ON ROTATION (a new UTC day, or first open): list data/mid-history-YYYY-MM-DD.jsonl,
// parse the date out of the name, and unlink any file whose day is older than the cutoff. Delete-by-name
// (never read a file's contents), so pruning is O(files) and touches no memory.
function midHistoryPath(dayStr) { return path.join(MID_HISTORY_DIR, `mid-history-${dayStr}.jsonl`); }
function utcDayStr(now) { return new Date(now).toISOString().slice(0, 10); } // YYYY-MM-DD (UTC)
function pruneOldHistory(now) {
  const cutoff = now - MID_HISTORY_RETENTION_DAYS * 86_400_000;
  let files = [];
  try { files = fs.readdirSync(MID_HISTORY_DIR); } catch { return; }
  for (const f of files) {
    const m = f.match(/^mid-history-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) {
      try { fs.unlinkSync(path.join(MID_HISTORY_DIR, f)); log('mid-history: pruned', f, `(older than ${MID_HISTORY_RETENTION_DAYS}d)`); }
      catch (e) { log('mid-history: prune failed for', f, e.message); }
    }
  }
}
// The append stream for the CURRENT UTC day. On a day change we end the old stream, open the new one in
// append mode (flags:'a'), and run retention. flags:'a' means we never truncate or read an existing file.
function midHistoryStreamFor(now) {
  const day = utcDayStr(now);
  if (midHistoryStream && midHistoryStream.day === day) return midHistoryStream.stream;
  if (midHistoryStream) { try { midHistoryStream.stream.end(); } catch { /* ignore */ } }
  const stream = fs.createWriteStream(midHistoryPath(day), { flags: 'a' });
  stream.on('error', (e) => log('mid-history: stream error:', e.message));
  midHistoryStream = { day, stream };
  pruneOldHistory(now);
  log(`mid-history: appending ${midHistoryPath(day)} every ${MID_HISTORY_INTERVAL_MS / 1000}s (retain ${MID_HISTORY_RETENTION_DAYS}d)`);
  return stream;
}

// Qualifying resting SIZE inside the reward band, per side. Same size-cutoff (≥ minSize) the reward
// scoring uses, over the FULL in-memory book (not the truncated ladder). Band = adjMid ± bandRadiusC.
// When the band or the mid is unknown, every band-derived field is null — never 0, never guessed.
function inBandDepth(bids, asks, adjMid, bandRadiusC, minSize) {
  if (adjMid == null || bandRadiusC == null || !(bandRadiusC > 0)) {
    return { bandLow: null, bandHigh: null, bidDepthInBand: null, askDepthInBand: null };
  }
  const r = bandRadiusC / 100;
  const bandLow = adjMid - r;
  const bandHigh = adjMid + r;
  const cutoff = minSize > 0 ? minSize : 0;
  let bidDepth = 0, askDepth = 0;
  for (const o of bids) if (o.size >= cutoff && o.price >= bandLow - 1e-12 && o.price <= bandHigh + 1e-12) bidDepth += o.size;
  for (const o of asks) if (o.size >= cutoff && o.price >= bandLow - 1e-12 && o.price <= bandHigh + 1e-12) askDepth += o.size;
  return {
    bandLow: Math.round(bandLow * 1e6) / 1e6,
    bandHigh: Math.round(bandHigh * 1e6) / 1e6,
    bidDepthInBand: Math.round(bidDepth * 1e4) / 1e4,
    askDepthInBand: Math.round(askDepth * 1e4) / 1e4,
  };
}

// Append one row per market from IN-MEMORY book state only. A value not genuinely known at sample time
// is null (never a fallback, never a silent carry). src distinguishes a book that got a fresh ws event
// within the sampling interval ("ws") from one carried forward from an older event ("stale").
function sampleMidHistory() {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  let stream;
  try { stream = midHistoryStreamFor(now); } catch (e) { log('mid-history: stream open failed:', e.message); return; }
  let batch = '';
  let n = 0;
  for (const meta of desired.values()) {
    const assetId = meta.tokenId;
    const fr = store.freshness(assetId, STALE_MS, now);
    const b = store.getBook(assetId);
    let bestBid = null, bestAsk = null, plainMid = null, adjMid = null;
    let bidDepthInBand = null, askDepthInBand = null, bandLow = null, bandHigh = null;
    if (b) {
      const bids = parseOrders(b.bids, true);
      const asks = parseOrders(b.asks, false);
      bestBid = bids[0] ? bids[0].price : null;
      bestAsk = asks[0] ? asks[0].price : null;
      plainMid = (bestBid != null && bestAsk != null) ? Math.round(((bestBid + bestAsk) / 2) * 1e6) / 1e6 : null;
      const am = adjustedMid(bids, asks, meta.minSize, null);
      adjMid = am != null ? Math.round(am * 1e6) / 1e6 : null;
      const bandRadiusC = meta.maxSpread != null ? meta.maxSpread / 2 : null;
      const d = inBandDepth(bids, asks, adjMid, bandRadiusC, meta.minSize);
      bidDepthInBand = d.bidDepthInBand; askDepthInBand = d.askDepthInBand;
      bandLow = d.bandLow; bandHigh = d.bandHigh;
    }
    // "ws" only when the book got a fresh event within the sampling interval; otherwise the values are a
    // carried-forward book (or none) → "stale", exactly what the flag is for.
    const src = (b && fr.ageMs != null && fr.ageMs <= MID_HISTORY_INTERVAL_MS) ? 'ws' : 'stale';
    batch += JSON.stringify({
      ts: iso,
      marketId: meta.conditionId,
      tokenIdYes: meta.tokenId,
      adjMid, plainMid, bestBid, bestAsk,
      bidDepthInBand, askDepthInBand,
      bandLow, bandHigh,
      tick: meta.tick != null ? meta.tick : null,
      src,
    }) + '\n';
    n++;
  }
  if (batch) { stream.write(batch); midHistoryRows += n; }
}

async function tick() {
  // Heal any book that lost its snapshot (delta-without-seed).
  for (const id of store.resnapshotNeeded()) await resnapshotAsset(id, 'gap');
  const now = Date.now();
  const snapshot = buildSnapshot();
  try { runDrift(snapshot, now); } catch (e) { log('drift eval failed:', e.message); }
  snapshot.feed.driftSignals = driftSignals;
  try { atomicWrite(OUT_FILE, snapshot); } catch (e) { log('write failed:', e.message); }
  heartbeat();
}

async function main() {
  log('starting — LIVE CLOB books for liquidity-rewards (read-only, €0)');
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));
  await reconcileSubscriptions();
  client.connect();
  client.subscribe([...assetToMarket.keys()]);
  await resnapshotAll('startup'); // seed immediately via REST so we're useful before the first ws snapshot

  setInterval(() => { reconcileSubscriptions().catch(e => log('reconcile failed:', e.message)); }, REFRESH_MARKETS_MS);
  setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, WRITE_INTERVAL_MS);
  // Append-only mid-history sample (separate, slower cadence than the 3s snapshot). Read-only; never
  // reaches an order path. Wrapped so a write hiccup can never stall the feed loop.
  setInterval(() => { try { sampleMidHistory(); } catch (e) { log('mid-history sample failed:', e.message); } }, MID_HISTORY_INTERVAL_MS);
  log(`up: ${desired.size} markets / ${assetToMarket.size} assets subscribed`);
}

function shutdown() {
  try { client.close(); } catch { /* ignore */ }
  if (midHistoryStream) { try { midHistoryStream.stream.end(); } catch { /* ignore */ } }
  if (prisma) { prisma.$disconnect().catch(() => {}); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = { collectDesiredMarkets, sideView, buildSnapshot, store, client, inBandDepth, sampleMidHistory, pruneOldHistory, utcDayStr, writeCoverageManifest, MID_HISTORY_INTERVAL_MS, COVERAGE_FILE };
