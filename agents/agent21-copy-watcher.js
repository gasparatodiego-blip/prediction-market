#!/usr/bin/env node
// agent21-copy-watcher.js — Polymarket copy-trading alert layer (NO execution, NO keys)
// READ-ONLY · Zero Claude API · Public wallet addresses only · Telegram alerts only
// Rate: 1 req/sec  ·  Output: /tmp/copy-watcher.json

'use strict';

const fs   = require('fs');
const https = require('https');
const path  = require('path');
const { httpGet: _sharedGet } = require('../lib/httpGet');

// ── Load .env for Telegram creds (pm2 doesn't auto-load project env files) ───
// Read every candidate file (don't stop at the first one that merely exists —
// .env.local exists but only carries ODDS_API_KEY; TELEGRAM_* live in .env).
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

// ── Config ────────────────────────────────────────────────────────────────────
const WATCHLIST_FILE   = path.join(__dirname, '../data/copy-watchlist.json');
const STATE_FILE       = '/tmp/copy-watcher.json';
const HB_FILE          = '/tmp/agent-heartbeats.json';
const LEADERBOARD_FILE = '/tmp/leaderboard.json';

const MAX_RPS           = 1.0;
const POLL_INTERVAL_MS  = 5 * 60_000;   // 5 min between full cycles
const MAX_WALLETS       = 50;
const TRADES_PER_POLL   = 20;
const MAX_RECENT_ALERTS = 100;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// ── Runtime state ─────────────────────────────────────────────────────────────
let   walletLastSeen = {};         // wallet → highest trade timestamp seen
let   recentAlerts   = [];

// ── Rate-limited HTTP GET ─────────────────────────────────────────────────────
let queue = [], busy = false;

function get(url, ms = 10_000) {
  return new Promise((res, rej) => { queue.push({ url, ms, res, rej }); if (!busy) drain(); });
}

async function drain() {
  busy = true;
  while (queue.length) {
    const { url, ms, res, rej } = queue.shift();
    const t0 = Date.now();
    try { res(await rawGet(url, ms)); } catch (e) { rej(e); }
    const wait = 1000 / MAX_RPS - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  busy = false;
  if (queue.length) drain();
}

function rawGet(url, ms) { return _sharedGet(url, { timeoutMs: ms }).then(r => r.data); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Atomic write ──────────────────────────────────────────────────────────────
function atomicWrite(p, data) {
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent21-copy-watcher'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(html) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[CW] Telegram not configured — alert logged only');
    return;
  }
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: html, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, r => { r.resume(); r.on('end', resolve); });
    req.on('error', e => { console.error('[CW] Telegram err:', e.message); resolve(); });
    req.write(body); req.end();
  });
}

// ── Watchlist ─────────────────────────────────────────────────────────────────
function loadWatchlist() {
  try {
    const d = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
    return (d.wallets ?? []).slice(0, MAX_WALLETS);
  } catch { return []; }
}

// ── Leaderboard enrichment ────────────────────────────────────────────────────
function loadLeaderboardMap() {
  try {
    const lb  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const map = {};
    for (const cat of Object.values(lb.categories ?? {})) {
      for (const t of cat) { if (!map[t.wallet]) map[t.wallet] = t; }
    }
    return map;
  } catch { return {}; }
}

// ── Poll one wallet ───────────────────────────────────────────────────────────
async function pollWallet(entry, lbMap) {
  const { wallet, name, alertsEnabled } = entry;
  if (!alertsEnabled) return;

  let trades;
  try {
    trades = await get(
      `https://data-api.polymarket.com/trades?proxyWallet=${wallet}&limit=${TRADES_PER_POLL}`
    );
  } catch (e) {
    console.error(`[CW] poll error ${(name || wallet).slice(0, 14)}: ${e.message}`);
    return;
  }
  if (!Array.isArray(trades) || trades.length === 0) return;

  const lastSeen  = walletLastSeen[wallet] ?? 0;
  const newTrades = trades.filter(t => (t.timestamp ?? 0) > lastSeen);

  // Always update watermark
  const maxTs = Math.max(...trades.map(t => t.timestamp ?? 0));
  walletLastSeen[wallet] = maxTs;

  // First poll: just set baseline, don't alert on old trades
  if (lastSeen === 0) {
    console.log(`[CW] Baseline ${name ?? wallet.slice(0,12)}: ts=${maxTs}, skipping ${trades.length} historical`);
    return;
  }
  if (newTrades.length === 0) return;

  const lb          = lbMap[wallet] ?? {};
  const traderName  = name || lb.name || (wallet.slice(0, 6) + '…' + wallet.slice(-4));
  const category    = entry.category ?? lb.category ?? 'Unknown';
  const winRate     = lb.winRate ?? null;

  for (const trade of newTrades.slice(0, 5)) {  // cap at 5 per cycle per wallet
    const conditionId = trade.market ?? trade.conditionId ?? '';
    // data-api /trades carries the authoritative market title inline; the old gamma
    // ?conditionIds= lookup silently ignored the filter and mislabeled every alert.
    const title       = trade.title || (conditionId ? conditionId.slice(0, 16) + '…' : '—');
    const side        = (trade.side ?? '').toUpperCase();
    const price       = parseFloat(trade.price ?? 0);
    const size        = parseFloat(trade.size  ?? 0);
    const outcome     = trade.outcome ?? '—';
    const ts          = trade.timestamp ?? Math.floor(Date.now() / 1000);

    const alert = {
      wallet, name: traderName, category,
      market: title, conditionId,
      side, outcome, price, size,
      timestamp: ts,
      alertSentAt: Math.floor(Date.now() / 1000),
    };
    recentAlerts.unshift(alert);
    if (recentAlerts.length > MAX_RECENT_ALERTS) recentAlerts = recentAlerts.slice(0, MAX_RECENT_ALERTS);

    const dir = side === 'BUY' ? '📈' : '📉';
    const msg = [
      `🔔 <b>Trade Alert — ${traderName}</b>`,
      `📊 ${title.slice(0, 100)}`,
      `${dir} ${side} <b>${outcome}</b> @ $${price.toFixed(3)} · <b>$${size.toFixed(0)} USDC</b>`,
      `🏷 ${category}${winRate != null ? ` · ${winRate.toFixed(0)}% WR` : ''}`,
    ].join('\n');

    console.log(`[CW] 🔔 ${traderName}: ${side} ${outcome} @ ${price.toFixed(3)} — ${title.slice(0, 50)}`);
    await sendTelegram(msg);
  }
}

// ── Write state ───────────────────────────────────────────────────────────────
function writeState(wallets) {
  try {
    atomicWrite(STATE_FILE, {
      status:           'online',
      walletsMonitored: wallets.filter(w => w.alertsEnabled).length,
      walletLastSeen,
      recentAlerts:     recentAlerts.slice(0, MAX_RECENT_ALERTS),
      updatedAt:        new Date().toISOString(),
    });
  } catch (e) { console.error('[CW] writeState err:', e.message); }
}

// ── Main scan loop ─────────────────────────────────────────────────────────────
async function scan() {
  beat();
  const wallets = loadWatchlist();
  const lbMap   = loadLeaderboardMap();

  if (wallets.length === 0) {
    writeState([]);
    return;
  }

  const active = wallets.filter(w => w.alertsEnabled);
  console.log(`[CW] Polling ${active.length}/${wallets.length} wallets…`);
  for (const entry of wallets) {
    await pollWallet(entry, lbMap);
    beat();
  }

  writeState(wallets);
  console.log(`[CW] Done. Alerts in history: ${recentAlerts.length}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log('[CW] Starting agent21-copy-watcher — read-only, zero Claude, zero keys');
console.log(`[CW] Telegram: ${BOT_TOKEN ? 'configured' : 'NOT SET — alerts will log only'}`);
writeState([]);

setTimeout(async () => {
  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}, 3_000);
