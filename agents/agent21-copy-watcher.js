#!/usr/bin/env node
// agent21-copy-watcher.js — Polymarket copy-trading alert layer (NO execution, NO keys)
// READ-ONLY · Zero Claude API · Public wallet addresses only · Telegram alerts only
// Rate: 1 req/sec  ·  Output: /tmp/copy-watcher.json

'use strict';

const fs   = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const https = require('https');
const path  = require('path');
const { httpGet: _sharedGet } = require('../lib/httpGet');
const { categoryFromText } = require('../lib/category');

// Prisma (local Postgres) — read stored CopyConfigs for the paper engine. Guarded:
// if the client/DB is unavailable the agent degrades to alert-only, never crashes.
let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); }
catch (e) { console.warn('[CW] Prisma unavailable — paper engine disabled:', e.message); }

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
const DATA_DIR         = path.join(__dirname, '../data');
const WATCHLIST_FILE   = path.join(DATA_DIR, 'copy-watchlist.json');
const STATE_FILE       = '/tmp/copy-watcher.json';
const HB_FILE          = '/tmp/agent-heartbeats.json';
const LEADERBOARD_FILE = '/tmp/leaderboard.json';
// Durable copy-trading state (survives /tmp wipes + restarts; gitignored):
const POSITION_STATE_FILE = path.join(DATA_DIR, 'copy-position-state.json');  // snapshot + watermark
const COPY_EVENTS_FILE    = path.join(DATA_DIR, 'copy-events.json');          // append-merge open/close/adjust log
const PAPER_POSITIONS_FILE = path.join(DATA_DIR, 'paper-positions.json');     // simulated positions + paper PnL

const MAX_RPS           = 1.0;
const POLL_INTERVAL_MS  = 5 * 60_000;   // 5 min between full cycles
const MAX_WALLETS       = 50;
const TRADES_PER_POLL   = 20;
const MAX_RECENT_ALERTS = 100;
const MAX_COPY_EVENTS   = 5000;   // ring cap on the durable event log (most-recent kept)
const CLOSE_EPS         = 1.0;    // shares below this = position treated as flat (~0)

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';

// ── Runtime state ─────────────────────────────────────────────────────────────
let   walletLastSeen  = {};        // wallet → highest trade timestamp seen
let   recentAlerts    = [];
// Real position-state tracking (Phase 2): per-wallet net signed size per (cid|outcome),
// accumulated from the SAME trades feed already polled. Persisted durably so a restart
// resumes from the last snapshot + watermark and never double-fires an open/close.
let   positionSnapshot = {};       // wallet → { 'cid|outcome': {cid,outcome,title,netSize,avgPrice,category,updatedAt} }
let   copyEvents       = [];        // durable open/close/adjust log (most-recent first)
const copyEventKeys    = new Set(); // dedup: `${wallet}|${cid}|${outcome}|${ts}|${action}`
// Paper engine (Phase 5): per-config simulated positions + realized/unrealized PnL,
// driven by the copy-events above. lastPrice tracks the last OBSERVED executable
// trade price per (cid|outcome) — a real fill price from the feed, used to mark
// open positions and evaluate TP/SL. Never a midpoint, never fabricated.
let   paperConfigs     = {};        // configKey → { ...config, positions, realizedPnl, closed, lastEventTs }
let   lastPrice        = {};        // 'cid|outcome' → last real trade price seen
const PAPER_DUST       = 0.5;       // sim shares below this = closed
const MAX_PAPER_CLOSED = 50;        // recent closed sim trades kept per config

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

// ── Durable copy-trading state (snapshot + watermark + event log) ──────────────
function loadDurableState() {
  try {
    const s = JSON.parse(fs.readFileSync(POSITION_STATE_FILE, 'utf8'));
    if (s.walletLastSeen && typeof s.walletLastSeen === 'object') walletLastSeen = s.walletLastSeen;
    if (s.positionSnapshot && typeof s.positionSnapshot === 'object') positionSnapshot = s.positionSnapshot;
    console.log(`[CW] Restored state: ${Object.keys(walletLastSeen).length} watermarks, ` +
                `${Object.values(positionSnapshot).reduce((n, w) => n + Object.keys(w).length, 0)} open positions`);
  } catch { /* first run — start clean */ }
  try {
    const ev = JSON.parse(fs.readFileSync(COPY_EVENTS_FILE, 'utf8'));
    if (Array.isArray(ev.events)) {
      copyEvents = ev.events;
      for (const e of copyEvents) copyEventKeys.add(`${e.wallet}|${e.cid}|${e.outcome}|${e.timestamp}|${e.action}`);
      console.log(`[CW] Restored ${copyEvents.length} copy-events`);
    }
  } catch { /* first run */ }
}

function persistDurableState() {
  try {
    atomicWrite(POSITION_STATE_FILE, {
      walletLastSeen, positionSnapshot, updatedAt: new Date().toISOString(),
    });
  } catch (e) { console.error('[CW] persist state err:', e.message); }
  try {
    // Keep most-recent MAX_COPY_EVENTS (copyEvents is unshift-ordered, newest first).
    if (copyEvents.length > MAX_COPY_EVENTS) copyEvents = copyEvents.slice(0, MAX_COPY_EVENTS);
    atomicWrite(COPY_EVENTS_FILE, { updatedAt: new Date().toISOString(), events: copyEvents });
  } catch (e) { console.error('[CW] persist events err:', e.message); }
}

// ── Paper execution engine (Phase 5) ──────────────────────────────────────────
// Consumes the copy-events log and, for each stored CopyConfig, maintains SIMULATED
// positions + realized/unrealized paper PnL. Honest-engine: fills use the copied
// trade's REAL executed price (a genuine executable fill from the feed, never a
// midpoint); an out-of-range/absent price is skipped and logged, never fabricated.
// Live execution stays OFF — this never places a real order.
function loadPaperState() {
  try {
    const s = JSON.parse(fs.readFileSync(PAPER_POSITIONS_FILE, 'utf8'));
    if (s.configs && typeof s.configs === 'object') paperConfigs = s.configs;
    if (s.lastPrice && typeof s.lastPrice === 'object') lastPrice = s.lastPrice;
    console.log(`[CW] Restored paper state: ${Object.keys(paperConfigs).length} configs`);
  } catch { /* first run */ }
}

function persistPaperState() {
  try {
    atomicWrite(PAPER_POSITIONS_FILE, {
      updatedAt: new Date().toISOString(),
      liveExecution: false,   // explicit: paper only, AUTO_EXECUTE stays OFF
      configs: paperConfigs,
      lastPrice,
    });
  } catch (e) { console.error('[CW] persist paper err:', e.message); }
}

async function getCopyConfigs() {
  if (!prisma) return [];
  try { return await prisma.copyConfig.findMany(); }
  catch (e) { console.warn('[CW] copyConfig read failed:', e.message); return []; }
}

// A copied fill is executable only if its price is a sane 0<p<1 outcome price and
// size>0. Anything else is skipped (never fabricated into a fill).
function isExecutable(price, size) {
  return Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(size) && size > 0;
}

function runPaperEngine(configs) {
  // Refresh last observed executable prices from the whole event log (real fills).
  for (const e of copyEvents) {
    if (isExecutable(e.price, e.size)) lastPrice[`${e.cid}|${e.outcome}`] = e.price;
  }

  const liveKeys = new Set();
  for (const cfg of configs) {
    const key = `${cfg.userId}|${cfg.walletAddr.toLowerCase()}`;
    liveKeys.add(key);
    const cats = Array.isArray(cfg.categories) ? cfg.categories : [];
    const catSet = new Set(cats);
    const pct = cfg.pctPerOrder > 0 ? cfg.pctPerOrder : 5;

    let st = paperConfigs[key];
    if (!st) st = paperConfigs[key] = { userId: cfg.userId, walletAddr: cfg.walletAddr,
      positions: {}, realizedPnl: 0, closed: [], lastEventTs: 0 };
    // keep config knobs fresh (user may have edited them)
    st.categories = cats; st.pctPerOrder = pct; st.maxOpenPositions = cfg.maxOpenPositions;
    st.exitMode = cfg.exitMode; st.tpPct = cfg.tpPct; st.slPct = cfg.slPct; st.walletAddr = cfg.walletAddr;

    // Chronological, un-processed events for THIS watched wallet (watermark guard =
    // ignore stale fills; also a hard no-double-process).
    const wl = cfg.walletAddr.toLowerCase();
    const evs = copyEvents
      .filter(e => e.wallet && e.wallet.toLowerCase() === wl && (e.timestamp || 0) > st.lastEventTs)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const e of evs) {
      st.lastEventTs = Math.max(st.lastEventTs, e.timestamp || 0);
      // category filter (empty = all)
      if (catSet.size > 0 && !catSet.has(e.category || 'other')) continue;
      // pre-flight price sanity — no fabricated fills
      if (!isExecutable(e.price, e.size)) { console.log(`[CW][paper] skip non-executable ${e.action} ${(e.market||e.cid||'').slice(0,30)} p=${e.price}`); continue; }

      const pkey = `${e.cid}|${e.outcome}`;
      const pos  = st.positions[pkey];
      const yourShares = e.size * pct / 100;   // mirror sizing: pct of their order

      if (e.action === 'OPEN' || e.action === 'ADD') {
        if (!pos) {
          // maxOpen cap (only blocks NEW positions; adds to existing are fine)
          if (Object.keys(st.positions).length >= (cfg.maxOpenPositions || 999)) {
            console.log(`[CW][paper] maxOpen ${cfg.maxOpenPositions} reached — skip new ${(e.market||'').slice(0,30)}`);
            continue;
          }
          st.positions[pkey] = { cid: e.cid, outcome: e.outcome, market: e.market,
            category: e.category, shares: yourShares, entryAvg: e.price, openedAt: e.timestamp };
        } else {
          // ADD → weighted-average entry (no double-entry: same key updates in place)
          const tot = pos.shares + yourShares;
          pos.entryAvg = tot > 0 ? (pos.shares * pos.entryAvg + yourShares * e.price) / tot : e.price;
          pos.shares = tot;
        }
      } else if ((e.action === 'REDUCE' || e.action === 'CLOSE') && st.exitMode === 'mirror' && pos) {
        // Mirror exit: shrink our position by the same fraction they exited.
        const frac = e.action === 'CLOSE' ? 1
          : (e.prevSize > 0 ? Math.min(1, e.size / e.prevSize) : 1);
        const out  = pos.shares * frac;
        const pnl  = out * (e.price - pos.entryAvg);   // realized paper PnL (USDC)
        st.realizedPnl += pnl;
        pos.shares -= out;
        st.closed.unshift({ market: pos.market, outcome: pos.outcome, category: pos.category,
          shares: Math.round(out * 100) / 100, entryAvg: pos.entryAvg, exitPrice: e.price,
          pnl: Math.round(pnl * 100) / 100, reason: e.action === 'CLOSE' ? 'mirror-close' : 'mirror-reduce',
          closedAt: e.timestamp });
        if (pos.shares <= PAPER_DUST) delete st.positions[pkey];
      }
      // exitMode 'tpsl' ignores the trader's REDUCE/CLOSE — own TP/SL handled below.
    }

    // TP/SL evaluation for 'tpsl' configs — mark at last real observed price.
    if (st.exitMode === 'tpsl') {
      for (const [pkey, pos] of Object.entries(st.positions)) {
        const mark = lastPrice[pkey];
        if (!Number.isFinite(mark) || pos.entryAvg <= 0) continue;   // can't mark → don't fabricate
        const chg = (mark - pos.entryAvg) / pos.entryAvg;            // long the outcome token
        const hitTp = cfg.tpPct != null && chg >=  cfg.tpPct / 100;
        const hitSl = cfg.slPct != null && chg <= -cfg.slPct / 100;
        if (hitTp || hitSl) {
          const pnl = pos.shares * (mark - pos.entryAvg);
          st.realizedPnl += pnl;
          st.closed.unshift({ market: pos.market, outcome: pos.outcome, category: pos.category,
            shares: Math.round(pos.shares * 100) / 100, entryAvg: pos.entryAvg, exitPrice: mark,
            pnl: Math.round(pnl * 100) / 100, reason: hitTp ? 'take-profit' : 'stop-loss',
            closedAt: Math.floor(Date.now() / 1000) });
          delete st.positions[pkey];
        }
      }
    }

    // Recompute unrealized from marks (positions without a mark contribute nothing —
    // shown as unmarked, never guessed).
    let unreal = 0, marked = 0, total = 0;
    for (const [pkey, pos] of Object.entries(st.positions)) {
      total++;
      const mark = lastPrice[pkey];
      if (Number.isFinite(mark)) { unreal += pos.shares * (mark - pos.entryAvg); marked++; }
    }
    st.unrealizedPnl = marked > 0 ? Math.round(unreal * 100) / 100 : null;
    st.openPositions = total;
    st.markedPositions = marked;
    st.realizedPnl = Math.round(st.realizedPnl * 100) / 100;
    if (st.closed.length > MAX_PAPER_CLOSED) st.closed = st.closed.slice(0, MAX_PAPER_CLOSED);
  }

  // Drop paper state for configs the user deleted.
  for (const k of Object.keys(paperConfigs)) if (!liveKeys.has(k)) delete paperConfigs[k];

  persistPaperState();
  const open = Object.values(paperConfigs).reduce((n, s) => n + Object.keys(s.positions).length, 0);
  console.log(`[CW][paper] ${configs.length} configs · ${open} open sim positions`);
}

// Real OPEN/CLOSE/ADD/REDUCE tracking from the trades feed already polled.
// Groups new trades by (cid|outcome|timestamp), nets signed size (BUY:+, SELL:−),
// applies each net delta to the persisted per-wallet snapshot in chronological
// order, and classifies the resulting transition. Best-effort over OBSERVED
// trades only (the feed returns the last TRADES_PER_POLL) — never fabricated:
// we record only transitions our own polling actually witnessed. Returns the
// list of newly-emitted events (also merged into the durable copyEvents log).
function trackPositions(wallet, traderName, newTrades) {
  const emitted = [];
  if (!positionSnapshot[wallet]) positionSnapshot[wallet] = {};
  const snap = positionSnapshot[wallet];

  // Aggregate signed size + volume-weighted price per (cid|outcome|ts) group.
  const groups = new Map();
  for (const t of newTrades) {
    const cid     = t.conditionId ?? t.market ?? '';
    const outcome = t.outcome ?? '—';
    const ts      = t.timestamp ?? Math.floor(Date.now() / 1000);
    const price   = parseFloat(t.price ?? 0);
    const size    = parseFloat(t.size ?? 0);
    if (!cid || !(size > 0)) continue;
    const signed  = (t.side ?? '').toUpperCase() === 'SELL' ? -size : size;
    const gkey    = `${cid}|${outcome}|${ts}`;
    let g = groups.get(gkey);
    if (!g) { g = { cid, outcome, ts, title: t.title || null, slug: t.slug || null, signed: 0, pxNum: 0, pxDen: 0 }; groups.set(gkey, g); }
    g.signed += signed;
    g.pxNum  += price * size;   // weight by absolute traded size
    g.pxDen  += size;
  }

  // Apply groups oldest→newest so the running snapshot evolves correctly.
  for (const g of [...groups.values()].sort((a, b) => a.ts - b.ts)) {
    if (Math.abs(g.signed) < 1e-9) continue;              // net-zero churn, no state change
    const key   = `${g.cid}|${g.outcome}`;
    const prev  = snap[key]?.netSize ?? 0;
    const next  = prev + g.signed;
    const price = g.pxDen > 0 ? g.pxNum / g.pxDen : 0;
    const category = categoryFromText(g.title, g.slug);   // real title/slug → 'other' if unmatched

    let action;
    if (prev <= CLOSE_EPS && next > CLOSE_EPS)      action = 'OPEN';
    else if (next <= CLOSE_EPS && prev > CLOSE_EPS) action = 'CLOSE';
    else if (next > prev)                            action = 'ADD';
    else if (next < prev)                            action = 'REDUCE';
    else continue;

    // Update the snapshot (cost-basis avg only grows on OPEN/ADD; unchanged on REDUCE).
    if (action === 'CLOSE') {
      delete snap[key];
    } else {
      const prevAvg = snap[key]?.avgPrice ?? 0;
      const avgPrice = (action === 'OPEN')
        ? price
        : (action === 'ADD' ? (prev * prevAvg + g.signed * price) / next : prevAvg);
      snap[key] = { cid: g.cid, outcome: g.outcome, title: g.title, netSize: next, avgPrice, category, updatedAt: g.ts };
    }

    const dedupKey = `${wallet}|${g.cid}|${g.outcome}|${g.ts}|${action}`;
    if (copyEventKeys.has(dedupKey)) continue;            // append-merge dedup
    copyEventKeys.add(dedupKey);
    const evt = {
      wallet, name: traderName, cid: g.cid, market: g.title, outcome: g.outcome,
      category, action, tradeSide: g.signed > 0 ? 'BUY' : 'SELL',
      price: Math.round(price * 10000) / 10000,
      size: Math.round(Math.abs(g.signed) * 100) / 100,   // shares delta
      prevSize: Math.round(prev * 100) / 100,
      netSize: Math.round(next * 100) / 100,
      timestamp: g.ts,
    };
    copyEvents.unshift(evt);
    emitted.push(evt);
    console.log(`[CW] 📌 ${traderName}: ${action} ${g.outcome} ${evt.size}sh @ ${price.toFixed(3)} — ${(g.title || g.cid).slice(0, 40)}`);
  }
  return emitted;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent21-copy-watcher'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
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
  // NOTE: we poll + track positions for EVERY wallet in the set (incl. copy-config
  // wallets with alerts off) so the paper engine sees their opens/closes. Only the
  // Telegram alert emission below is gated on alertsEnabled.

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

  // Phase 2 — real open/close tracking from ALL new trades (not just the alert cap).
  trackPositions(wallet, traderName, newTrades);

  if (!alertsEnabled) return;   // tracking done; skip Telegram for copy-only wallets

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
  const watchlist = loadWatchlist();
  const lbMap     = loadLeaderboardMap();
  const configs   = await getCopyConfigs();

  // Poll set = watchlist ∪ CopyConfig wallets (deduped, case-insensitive). Config
  // wallets are polled with alerts OFF — they exist only to feed the paper engine.
  const byAddr = new Map();
  for (const w of watchlist) byAddr.set((w.wallet || '').toLowerCase(), w);
  for (const c of configs) {
    const a = (c.walletAddr || '').toLowerCase();
    if (a && !byAddr.has(a)) byAddr.set(a, { wallet: c.walletAddr, name: null, alertsEnabled: false, copyOnly: true });
  }
  const wallets = [...byAddr.values()].slice(0, MAX_WALLETS);

  if (wallets.length === 0) {
    writeState([]);
    runPaperEngine(configs);   // no-op cleanup if configs exist without wallets
    return;
  }

  const active = wallets.filter(w => w.alertsEnabled);
  console.log(`[CW] Polling ${wallets.length} wallets (${active.length} alerting, ${configs.length} copy-configs)…`);
  for (const entry of wallets) {
    await pollWallet(entry, lbMap);
    beat();
  }

  writeState(wallets);
  persistDurableState();       // snapshot + watermark + event log (atomic, restart-safe)
  runPaperEngine(configs);     // drive simulated positions/PnL from the fresh events
  console.log(`[CW] Done. Alerts: ${recentAlerts.length}, copy-events: ${copyEvents.length}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log('[CW] Starting agent21-copy-watcher — read-only, zero Claude, zero keys');
console.log(`[CW] Telegram: ${BOT_TOKEN ? 'configured' : 'NOT SET — alerts will log only'}`);
loadDurableState();   // resume watermark + position snapshot + event log (no double-fire)
loadPaperState();     // resume simulated positions + paper PnL
writeState([]);

setTimeout(async () => {
  await scan();
  setInterval(scan, POLL_INTERVAL_MS);
}, 3_000);
