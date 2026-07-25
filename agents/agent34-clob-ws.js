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
const { adjustedMid, parseOrders } = require('../lib/rewardScore');
const { decideDrift } = require('../lib/rewards-drift');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { appendDriftShadowRecord } = require('../lib/news-guard/shadow-log');
const { estRewardForgone } = require('../lib/news-guard/action');

// ── config ──
const WATCHLIST_FILE = '/root/prediction-market/data/liquidity-rewards.json'; // agent24 output
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';                        // normalized (carries rewardScore)
const OUT_FILE       = '/tmp/clob-live-books.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
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
  log(`up: ${desired.size} markets / ${assetToMarket.size} assets subscribed`);
}

function shutdown() {
  try { client.close(); } catch { /* ignore */ }
  if (prisma) { prisma.$disconnect().catch(() => {}); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = { collectDesiredMarkets, sideView, buildSnapshot, store, client };
