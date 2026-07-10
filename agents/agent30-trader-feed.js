#!/usr/bin/env node
// agent30-trader-feed.js — Edgeradar per-trader live fill/position feed.
//
// PURPOSE
//   Powers the trader detail page (/dashboard/traders/<address>) with an
//   always-fresh, real-time trade feed reconstructed from REAL public
//   Polymarket data. Two honest data channels, zero API cost, zero keys:
//
//   1. LIVE   — RTDS activity WebSocket (wss://ws-live-data.polymarket.com).
//               Global trade firehose; each event carries `proxyWallet`, so a
//               fill is attributable to a wallet. We filter to the tracked set
//               (the qualifying leaderboard wallets) and append in real time.
//   2. RESYNC — Data-API REST (data-api.polymarket.com), keyless:
//                 GET /trades?user=<addr>   → full fill history (price/size/side/ts)
//                 GET /positions?user=<addr>→ current holdings + Polymarket's own
//                                             avgPrice / cashPnl(unrealized) /
//                                             realizedPnl / curPrice(mark)
//               Run on startup AND on every WS reconnect, because the WS does
//               NOT replay deltas missed during a disconnect — re-reading REST
//               is the only way to guarantee no fill is silently lost. That
//               completeness guarantee is the whole point: a P&L computed from
//               an incomplete fill set would be a lie.
//
// HONEST-ENGINE
//   * Every field written here is a real on-chain fill or a real Data-API read.
//     Nothing is fabricated. Missing → omitted/null, never invented.
//   * `updatedAt` is the TRUE last write; `feedHealthy` reflects the real WS
//     state. We never imply the data is fresher than it is.
//   * We store raw fills + Polymarket's own position economics; all P&L
//     LABELLING (unrealized mark-to-mid vs realized) happens at render time.
//
// OUTPUT   /tmp/trader-feed.json   (atomic; read by /api/traders/feed/[address])
// HEARTBEAT/tmp/agent-heartbeats.json  key 'agent30-trader-feed'
// COST     $0 — public WS + keyless REST only. No paid tier, no polling firehose.

'use strict';

const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { rlGet } = require('../lib/rateLimitedFetch');
const { fetchOpenPositions } = require('../lib/open-positions-fetch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

// ── .env (pm2 doesn't auto-load project env files) — only for optional Telegram
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_API          = 'https://data-api.polymarket.com';
const WS_URL            = 'wss://ws-live-data.polymarket.com';
const LEADERBOARD_FILE  = '/tmp/leaderboard.json';
const OUT_FILE          = '/tmp/trader-feed.json';
const HB_FILE           = '/tmp/agent-heartbeats.json';

const FILLS_PER_WALLET  = 200;            // depth kept per wallet (full history → link out to Polymarket profile)
const MAX_OPEN_KEEP     = 60;             // display/store cap on OPEN positions (true count disclosed via openObserved)
const RESYNC_INTERVAL_MS = 10 * 60_000;   // periodic full REST resync (refreshes marks + catches anything)
const TRACKED_REFRESH_MS = 10 * 60_000;   // re-read the tracked wallet set from leaderboard.json
const HEALTH_TICK_MS    = 5_000;          // health check + heartbeat cadence
const WS_STALE_MS       = 45_000;         // no WS message for this long ⇒ unhealthy (firehose is constant)
const WS_WATCHDOG_MS    = 90_000;         // silent-but-"connected" this long ⇒ dead half-open socket → force reconnect
const WS_PING_MS        = 10_000;         // protocol ping cadence
const WRITE_DEBOUNCE_MS = 3_000;          // coalesce file writes after a burst of tracked fills
const MAX_TRACKED       = 400;            // safety cap on tracked wallets
const REQ_TIMEOUT_MS    = 12_000;

// Optional Telegram — muted by default like the other data agents; only fires
// when the feed is UNHEALTHY for a sustained period (never on normal operation).
const TG_ENABLED = String(process.env.TELEGRAM_ALERTS_ENABLED || '').toLowerCase() === 'true';
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID   || '';
const UNHEALTHY_ALERT_MS = 5 * 60_000;    // sustained-unhealthy threshold before a single alert

// ── Runtime state ─────────────────────────────────────────────────────────────
/** @type {Map<string, {fills: any[], fillKeys: Set<string>, positions: any[]|null,
 *  fillsUpdatedAt: number|null, positionsUpdatedAt: number|null,
 *  firstFillTs: number|null, lastFillTs: number|null}>} */
const wallets = new Map();          // lowercased address → per-wallet record
let   trackedRefreshedAt = 0;
let   ws = null;
let   wsConnected   = false;
let   lastWsMsgAt   = 0;
let   reconnectAttempts = 0;
let   reconnectTimer = null;
let   lastForceReconnectAt = 0;
let   resyncing     = false;
let   lastFullResyncAt = null;
let   pingTimer     = null;
let   writeTimer    = null;
let   dirty         = false;
let   unhealthySince = null;
let   lastUnhealthyAlertAt = 0;
let   shuttingDown  = false;

const log = (...a) => console.log('[agent30]', ...a);

// ── Tracked wallet set (union of leaderboard category rows + bots) ────────────
function refreshTracked() {
  let added = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const set = new Set();
    for (const cat of Object.values(raw.categories || {})) {
      for (const r of cat) if (r && r.wallet) set.add(String(r.wallet).toLowerCase());
    }
    for (const b of (raw.bots || [])) if (b && b.wallet) set.add(String(b.wallet).toLowerCase());
    for (const addr of set) {
      if (wallets.size >= MAX_TRACKED && !wallets.has(addr)) continue;
      if (!wallets.has(addr)) {
        wallets.set(addr, {
          fills: [], fillKeys: new Set(), positions: null,
          fillsUpdatedAt: null, positionsUpdatedAt: null,
          firstFillTs: null, lastFillTs: null,
        });
        added++;
      }
    }
    trackedRefreshedAt = Date.now();
    log(`tracked set: ${wallets.size} wallets (+${added} new) from leaderboard.json`);
  } catch (e) {
    log('refreshTracked: leaderboard.json unavailable —', e.message);
  }
  return added;
}

// ── Fill normalisation + dedup ────────────────────────────────────────────────
// Both REST /trades records and RTDS activity payloads share the same shape.
function normFill(t) {
  if (!t || t.asset == null || t.timestamp == null) return null;
  const price = Number(t.price), size = Number(t.size), ts = Number(t.timestamp);
  if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return null;
  return {
    txHash:       t.transactionHash || null,
    asset:        String(t.asset),
    conditionId:  t.conditionId || null,
    side:         t.side || null,              // BUY | SELL
    price, size, timestamp: ts,
    title:        t.title || null,
    slug:         t.slug || null,
    eventSlug:    t.eventSlug || null,
    outcome:      t.outcome ?? null,
    outcomeIndex: (t.outcomeIndex != null && t.outcomeIndex !== 999) ? Number(t.outcomeIndex) : null,
  };
}
// Uniqueness of a single fill: tx + token + price + size + side. (One tx can
// touch several tokens; a wallet can fill the same token twice at diff prices.)
const fillKey = (f) => `${f.txHash || 'na'}:${f.asset}:${f.price}:${f.size}:${f.side}`;

// Insert one normalised fill into a wallet record (newest-first, capped, deduped).
// Returns true if it was new.
function addFill(rec, f) {
  if (!f) return false;
  const k = fillKey(f);
  if (rec.fillKeys.has(k)) return false;
  rec.fillKeys.add(k);
  // insert keeping fills sorted newest-first
  let i = 0;
  while (i < rec.fills.length && rec.fills[i].timestamp >= f.timestamp) i++;
  rec.fills.splice(i, 0, f);
  if (rec.fills.length > FILLS_PER_WALLET) {
    const dropped = rec.fills.splice(FILLS_PER_WALLET);
    for (const d of dropped) rec.fillKeys.delete(fillKey(d));
  }
  rec.firstFillTs = rec.fills.length ? rec.fills[rec.fills.length - 1].timestamp : rec.firstFillTs;
  rec.lastFillTs  = rec.fills.length ? rec.fills[0].timestamp : rec.lastFillTs;
  return true;
}

// ── REST resync ───────────────────────────────────────────────────────────────
async function fetchTrades(addr) {
  const url = `${DATA_API}/trades?user=${addr}&limit=${FILLS_PER_WALLET}`;
  const r = await rlGet(url, { timeoutMs: REQ_TIMEOUT_MS });
  return Array.isArray(r.data) ? r.data : [];
}
// Returns { positions, openObserved, openCapped }.
//   • positions  — RESOLVED/redeemable rows from the base fetch (drives realized
//                  settlement EXACTLY as before) PLUS the COMPLETE genuinely-open
//                  set (capped to MAX_OPEN_KEEP by value for display/poll load).
//   • openObserved — true number of open (redeemable=false, |size|>0) positions.
//   • openCapped   — more open exist than we kept/scanned → UI discloses "X of Y".
// The base default fetch is untouched, so redeemable/resolved (and thus realized
// P&L) never change — we only ADD open positions the defaults silently dropped.
async function fetchPositions(addr) {
  const base = await rlGet(`${DATA_API}/positions?user=${addr}`, { timeoutMs: REQ_TIMEOUT_MS });
  const baseArr = Array.isArray(base.data) ? base.data : [];

  const getJson = async (url) => {
    const r = await rlGet(url, { timeoutMs: REQ_TIMEOUT_MS });
    return Array.isArray(r.data) ? r.data : [];
  };
  const { ok, open, openObserved, openScanCapped } =
    await fetchOpenPositions(getJson, addr, { maxKeep: MAX_OPEN_KEEP });

  let keptOpen, observed, capped;
  if (ok) {
    keptOpen = open;
    observed = openObserved;
    capped   = openScanCapped || openObserved > open.length;
  } else {
    // Complete-open fetch failed — degrade to the base fetch's open set rather
    // than dropping open positions entirely (honest: never fewer than we can see).
    keptOpen = baseArr.filter(p => p && !p.redeemable && Math.abs(Number(p.size) || 0) > 0);
    observed = keptOpen.length;
    capped   = false;
  }

  // Merge: complete open + resolved-from-base. No asset overlap (open=redeemable:false,
  // resolved=redeemable:true) but dedupe defensively so a row can't appear twice.
  const keptAssets = new Set(keptOpen.map(p => String(p.asset)));
  const merged = keptOpen.slice();
  for (const p of baseArr) {
    if (p && p.redeemable && !keptAssets.has(String(p.asset))) merged.push(p);
  }
  return { positions: merged, openObserved: observed, openCapped: capped };
}
function normPosition(p) {
  if (!p || p.asset == null) return null;
  const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    asset:        String(p.asset),
    conditionId:  p.conditionId || null,
    size:         num(p.size),
    avgPrice:     num(p.avgPrice),
    curPrice:     num(p.curPrice),        // current mark (mid)
    initialValue: num(p.initialValue),    // cost basis
    currentValue: num(p.currentValue),    // mark-to-mid value
    cashPnl:      num(p.cashPnl),         // UNREALIZED (mark-to-mid) — labelled as such at render
    percentPnl:   num(p.percentPnl),
    realizedPnl:  num(p.realizedPnl),     // realized on partial exits within this open position
    totalBought:  num(p.totalBought),
    redeemable:   !!p.redeemable,
    title:        p.title || null,
    slug:         p.slug || null,
    eventSlug:    p.eventSlug || null,
    outcome:      p.outcome ?? null,
    outcomeIndex: (p.outcomeIndex != null) ? Number(p.outcomeIndex) : null,
    endDate:      p.endDate || null,
  };
}

// Resync one wallet (both endpoints). Never throws — logs + degrades.
async function resyncWallet(addr) {
  const rec = wallets.get(addr);
  if (!rec) return;
  try {
    const trades = await fetchTrades(addr);
    for (const t of trades) addFill(rec, normFill(t));
    rec.fillsUpdatedAt = Date.now();
  } catch (e) { log(`resync trades ${addr.slice(0, 10)}… failed:`, e.message); }
  try {
    const { positions, openObserved, openCapped } = await fetchPositions(addr);
    rec.positions = positions.map(normPosition).filter(Boolean);
    rec.openObserved = openObserved;   // true open count (redeemable=false, |size|>0)
    rec.openCapped = openCapped;       // more open than stored/scanned → UI discloses
    rec.positionsUpdatedAt = Date.now();
  } catch (e) { log(`resync positions ${addr.slice(0, 10)}… failed:`, e.message); }
}

// Full resync of every tracked wallet. rlGet serialises per host, so this is a
// polite sequential sweep; live WS keeps appending during it.
async function fullResync(reason) {
  if (resyncing) { log(`fullResync skipped (already running) — ${reason}`); return; }
  resyncing = true;
  markDirty();
  const t0 = Date.now();
  log(`fullResync START (${reason}) — ${wallets.size} wallets`);
  let done = 0;
  for (const addr of Array.from(wallets.keys())) {
    if (shuttingDown) break;
    await resyncWallet(addr);
    done++;
    if (done % 25 === 0) { markDirty(); writeNow(); }   // progressive visibility
  }
  lastFullResyncAt = Date.now();
  resyncing = false;
  markDirty();
  writeNow();
  log(`fullResync DONE (${reason}) — ${done} wallets in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ── WebSocket (live wallet-attributed fills) ──────────────────────────────────
function connectWs() {
  if (shuttingDown) return;
  try { if (ws) ws.removeAllListeners(); } catch {}
  log(`WS connecting → ${WS_URL} (attempt ${reconnectAttempts + 1})`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    wsConnected = true;
    lastWsMsgAt = Date.now();
    reconnectAttempts = 0;
    log('WS open — subscribing to activity/trades');
    try {
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] }));
    } catch (e) { log('WS subscribe send failed:', e.message); }
    // COMPLETENESS = TRUTH: the WS does not replay deltas missed while we were
    // disconnected, so re-read REST for every tracked wallet now. Runs in the
    // background; live events append concurrently.
    fullResync('ws-reconnect').catch(e => log('reconnect resync error:', e.message));
  });

  ws.on('message', (buf) => {
    lastWsMsgAt = Date.now();
    const s = buf.toString();
    if (!s || !s.trim()) return;
    let j;
    try { j = JSON.parse(s); } catch { return; }
    const p = j && j.payload;
    if (!p || !p.proxyWallet) return;
    const addr = String(p.proxyWallet).toLowerCase();
    const rec = wallets.get(addr);
    if (!rec) return;                       // not a tracked wallet — ignore (firehose)
    if (addFill(rec, normFill(p))) {
      rec.fillsUpdatedAt = Date.now();
      markDirty();
    }
  });

  ws.on('error', (e) => log('WS error:', e.message));
  ws.on('close', (code) => {
    wsConnected = false;
    if (shuttingDown) return;
    reconnectAttempts++;
    const backoff = Math.min(30_000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 5)));
    log(`WS closed (code ${code}) — reconnecting in ${backoff}ms`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, backoff);
  });
}

// Protocol-level ping keeps the socket alive; the server's constant firehose
// means a healthy connection always has a very recent lastWsMsgAt.
function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    try { if (ws && wsConnected && ws.readyState === WebSocket.OPEN) ws.ping(); } catch {}
  }, WS_PING_MS);
}

// ── Health + heartbeat + file write ───────────────────────────────────────────
function feedHealthy() {
  return wsConnected && (Date.now() - lastWsMsgAt) < WS_STALE_MS;
}

function markDirty() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; if (dirty) writeNow(); }, WRITE_DEBOUNCE_MS);
}

function buildFile() {
  const out = { wallets: {} };
  let totalFills = 0;
  for (const [addr, rec] of wallets) {
    // Skip wallets we've never populated to keep the file lean; they resync in.
    if (!rec.fills.length && !(rec.positions && rec.positions.length)) continue;
    totalFills += rec.fills.length;
    out.wallets[addr] = {
      fills:              rec.fills,
      positions:          rec.positions || [],
      firstFillTs:        rec.firstFillTs,
      lastFillTs:         rec.lastFillTs,
      fillsUpdatedAt:     rec.fillsUpdatedAt,
      positionsUpdatedAt: rec.positionsUpdatedAt,
      fillsCount:         rec.fills.length,
      fillsCapped:        rec.fills.length >= FILLS_PER_WALLET, // true ⇒ older fills exist only on Polymarket
      openObserved:       rec.openObserved ?? null,             // true open count (may exceed stored positions)
      openCapped:         !!rec.openCapped,                     // true ⇒ more open than we stored → disclose "X of Y"
    };
  }
  return {
    updatedAt:        new Date().toISOString(),
    feedHealthy:      feedHealthy(),
    wsConnected,
    resyncing,
    lastWsMsgAt:      lastWsMsgAt ? new Date(lastWsMsgAt).toISOString() : null,
    lastFullResyncAt: lastFullResyncAt ? new Date(lastFullResyncAt).toISOString() : null,
    trackedCount:     wallets.size,
    servedCount:      Object.keys(out.wallets).length,
    totalFills,
    fillsPerWallet:   FILLS_PER_WALLET,
    source: {
      live:  'wss://ws-live-data.polymarket.com (activity/trades, wallet-attributed)',
      resync:'data-api.polymarket.com /trades + /positions (keyless)',
    },
    wallets: out.wallets,
  };
}

function writeNow() {
  dirty = false;
  try { atomicWriteJson(OUT_FILE, buildFile()); }
  catch (e) { log('write failed:', e.message); }
}

async function maybeAlertUnhealthy() {
  if (!TG_ENABLED || !BOT_TOKEN || !CHAT_ID) return;
  if (Date.now() - lastUnhealthyAlertAt < UNHEALTHY_ALERT_MS) return;
  lastUnhealthyAlertAt = Date.now();
  const txt = `⚠️ agent30 trader-feed UNHEALTHY for >${Math.round(UNHEALTHY_ALERT_MS / 60000)}min — WS ${wsConnected ? 'connected but quiet' : 'disconnected'}. Trader pages may be stale.`;
  try {
    const { rlPost } = require('../lib/rateLimitedFetch');
    await rlPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: txt }, { timeoutMs: 8000 });
  } catch (e) { log('telegram alert failed:', e.message); }
}

// Silent-but-open WS watchdog. The activity firehose is constant, so a socket
// that still reads `wsConnected` yet has gone quiet for WS_WATCHDOG_MS is a dead
// half-open connection: the 'close' event never fired, so the normal reconnect
// path (ws.on('close')) can't run and feedHealthy() would sit false FOREVER —
// the "re-syncing…/reconnecting" badge that never returns to healthy. Terminate
// it to force a real 'close' → reconnect → resync, making unhealthy a TERMINATING
// transient. During normal operation lastWsMsgAt is always < WS_STALE_MS, so this
// never fires and never disturbs a healthy feed.
function wsWatchdog() {
  if (shuttingDown || !ws || !wsConnected) return;   // disconnected → 'close' path already reconnects
  if (Date.now() - lastWsMsgAt < WS_WATCHDOG_MS) return;
  if (Date.now() - lastForceReconnectAt < WS_WATCHDOG_MS) return; // don't thrash if terminate is slow
  lastForceReconnectAt = Date.now();
  log(`WS silent ${((Date.now() - lastWsMsgAt) / 1000).toFixed(0)}s while "connected" — forcing reconnect`);
  try { (ws.terminate ? ws.terminate() : ws.close()); } catch (e) { log('watchdog terminate failed:', e.message); }
}

function healthTick() {
  wsWatchdog();
  // heartbeat (monitor watches this key)
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent30-trader-feed'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}

  const healthy = feedHealthy();
  if (healthy) { unhealthySince = null; }
  else {
    if (unhealthySince == null) unhealthySince = Date.now();
    if (Date.now() - unhealthySince > UNHEALTHY_ALERT_MS) maybeAlertUnhealthy();
  }
  // keep updatedAt/health fresh in the file even when idle (marks age honestly)
  markDirty();

  if (Date.now() - trackedRefreshedAt > TRACKED_REFRESH_MS) {
    const added = refreshTracked();
    if (added > 0) fullResync('new-tracked-wallets').catch(() => {});
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  log('starting — honest per-trader live feed (public WS + keyless REST, $0)');
  refreshTracked();
  writeNow();                       // create the file immediately (warming state)
  connectWs();
  startPing();
  setInterval(healthTick, HEALTH_TICK_MS);
  setInterval(() => fullResync('periodic').catch(e => log('periodic resync error:', e.message)), RESYNC_INTERVAL_MS);
  // initial full history/positions load
  await fullResync('startup');
}

function shutdown() {
  shuttingDown = true;
  try { if (ws) ws.close(); } catch {}
  try { writeNow(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException',  (e) => log('uncaughtException:', e && e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && (e.message || e)));

main().catch((e) => { log('fatal:', e && e.message); process.exit(1); });
