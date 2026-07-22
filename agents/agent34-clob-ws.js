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

// ── config ──
const WATCHLIST_FILE = '/root/prediction-market/data/liquidity-rewards.json'; // agent24 output
const OUT_FILE       = '/tmp/clob-live-books.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const CLOB_BASE      = 'https://clob.polymarket.com';

const SUBSCRIPTION_CAP = 60;          // markets (× 2 tokens = ≤120 assets; well under the ~250/conn cap)
const WRITE_INTERVAL_MS = 3_000;      // recompute + persist snapshot cadence
const REFRESH_MARKETS_MS = 60_000;    // re-read the watchlist for adds/drops
const STALE_MS = 30_000;              // no event within this ⇒ that book is STALE (≈3 heartbeats)
const RESNAPSHOT_MIN_GAP_MS = 5_000;  // don't hammer REST for the same asset
const STARTUP_DELAY_MS = 8_000;
const UA = 'edgeradar-agent34-clob-ws/1.0 (read-only)';

const log = (...a) => console.log(new Date().toISOString(), '[agent34]', ...a);

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

const store = new LiveBookStore();
const client = new ClobWsClient({ logger: (...a) => log('[ws]', ...a) });
let desired = new Map();            // conditionId -> meta
let assetToMarket = new Map();      // assetId -> { conditionId, side:'yes'|'no', meta }
const lastResnapshotAt = new Map(); // assetId -> ts (throttle REST)
let reconnects = 0, watchdogReconnects = 0, restSnapshots = 0, droppedForCap = 0;

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
function reconcileSubscriptions() {
  desired = collectDesiredMarkets();
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
  return {
    live: fr.live, reason: fr.reason, ageMs: fr.ageMs,
    bestBid, bestAsk, plainMid,
    adjustedMid: adjMid != null ? adjMid : null,
    needsResnapshot: b.needsResnapshot,
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

async function tick() {
  // Heal any book that lost its snapshot (delta-without-seed).
  for (const id of store.resnapshotNeeded()) await resnapshotAsset(id, 'gap');
  try { atomicWrite(OUT_FILE, buildSnapshot()); } catch (e) { log('write failed:', e.message); }
  heartbeat();
}

async function main() {
  log('starting — LIVE CLOB books for liquidity-rewards (read-only, €0)');
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));
  reconcileSubscriptions();
  client.connect();
  client.subscribe([...assetToMarket.keys()]);
  await resnapshotAll('startup'); // seed immediately via REST so we're useful before the first ws snapshot

  setInterval(() => { try { reconcileSubscriptions(); } catch (e) { log('reconcile failed:', e.message); } }, REFRESH_MARKETS_MS);
  setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, WRITE_INTERVAL_MS);
  log(`up: ${desired.size} markets / ${assetToMarket.size} assets subscribed`);
}

process.on('SIGTERM', () => { try { client.close(); } catch { /* ignore */ } process.exit(0); });
process.on('SIGINT', () => { try { client.close(); } catch { /* ignore */ } process.exit(0); });

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = { collectDesiredMarkets, sideView, buildSnapshot, store, client };
