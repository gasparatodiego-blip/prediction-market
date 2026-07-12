#!/usr/bin/env node
'use strict';

/**
 * Agent Market Maker — Phase 6
 * Monitors large BTC/ETH/SOL price moves on Binance and detects prediction
 * market info-lag opportunities. Uses Kelly criterion for bet sizing.
 *
 * Strategy:
 *   1. Watch Binance WebSocket for >2% moves in 5-minute windows
 *   2. Find Kalshi/Polymarket markets whose probability hasn't repriced yet
 *   3. Compute Kelly bet size and estimated profit
 *   4. Log opportunity to /tmp/marketmaker-opps.json + Telegram alert (≥70% conf)
 *   5. NOTE: This agent only DETECTS opportunities. Execution is manual.
 *
 * Runs continuously. WebSocket reconnects on error.
 */

const fs    = require('fs');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const path  = require('path');
const https = require('https');
const WebSocket = require('ws');

// ── Load .env (pm2 doesn't auto-load project env files) ────────────────────
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

const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID;
const HB_FILE   = '/tmp/agent-heartbeats.json';
const OUT_FILE  = '/tmp/marketmaker-opps.json';

const COINS      = ['BTC', 'USDT', 'ETH', 'USDT', 'SOL', 'USDT'];
const SYMBOLS    = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const MOVE_THRESH = 2.0;  // % move in 5-min window triggers scan
const CONF_MIN    = 60;   // min confidence to log
const ALERT_MIN   = 75;   // min confidence to Telegram
const WS_BASE     = 'wss://stream.binance.com:9443/stream?streams=';
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min per coin

// Track 5-min price windows
const priceHistory = {}; // coin → [{ price, ts }]
const alertCooldown = {};

// Read raw files
function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
  try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent-marketmaker'] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}

function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req  = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${TG_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { const r = JSON.parse(d); if (!r.ok) console.error('[mm] tg fail:', r.description); } catch {} });
  });
  req.on('error', e => console.error('[mm] tg error:', e.message));
  req.write(body); req.end();
}

// Kelly criterion: fraction of bankroll to bet
// b = net odds (decimal odds - 1), p = prob of win, q = 1 - p
function kelly(p, decimalOdds) {
  const b = decimalOdds - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.max(0, Math.min(f, 0.25)); // cap at 25%
}

// Detect prediction market info lag given a coin and % move
function detectInfoLag(coin, movePct, currentPrice) {
  const kalshiData    = readJson('/tmp/kalshi-raw.json');
  const polyData      = readJson('/tmp/polymarket-raw.json');
  const opps          = [];
  const direction     = movePct > 0 ? 'UP' : 'DOWN';
  const absMov        = Math.abs(movePct);

  // Keywords to match crypto markets
  const coinKeywords = {
    BTC: ['bitcoin', 'btc'],
    ETH: ['ethereum', 'eth'],
    SOL: ['solana', 'sol'],
  }[coin] ?? [coin.toLowerCase()];

  // Scan Kalshi markets
  if (kalshiData?.markets) {
    for (const m of kalshiData.markets) {
      const title = (m.title ?? '').toLowerCase();
      if (!coinKeywords.some(kw => title.includes(kw))) continue;

      const bid  = parseFloat(m.yes_bid_dollars  || '0');
      const ask  = parseFloat(m.yes_ask_dollars  || '0');
      const last = parseFloat(m.last_price_dollars || '0');
      let price  = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask > 0 ? ask : (bid > 0 ? bid : last));
      if (!price || price <= 0) continue;
      const pctYes = +(price * 100).toFixed(1);

      // For price-target markets: if BTC just moved +3%, "BTC above $X" should be higher
      // Simple heuristic: if move strongly supports a direction, look for lag
      const oppConfidence = estimateConfidence(m.title, direction, absMov, pctYes, currentPrice, coin);
      if (oppConfidence < CONF_MIN) continue;

      opps.push({
        source:      'kalshi',
        marketTitle: m.title,
        url:         `https://kalshi.com/markets/${m.ticker}`,
        currentProb: pctYes,
        coin,
        movePct,
        direction,
        confidence:  oppConfidence,
        action:      `Buy YES at ${pctYes}¢ on Kalshi (${coin} just moved ${movePct > 0 ? '+' : ''}${movePct.toFixed(1)}%, market may be lagging)`,
        kellyFrac:   +kelly(oppConfidence / 100, 100 / pctYes).toFixed(3),
        detectedAt:  Date.now(),
      });
    }
  }

  // Scan Polymarket markets
  if (polyData?.markets) {
    for (const m of polyData.markets.filter(m => m.active)) {
      const question = (m.question ?? '').toLowerCase();
      if (!coinKeywords.some(kw => question.includes(kw))) continue;

      let pctYes = null;
      try {
        const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (Array.isArray(prices) && prices[0]) pctYes = +(parseFloat(prices[0]) * 100).toFixed(1);
      } catch {}
      const ltp = parseFloat(m.lastTradePrice || '0');
      if (pctYes == null && ltp > 0) pctYes = +(ltp * 100).toFixed(1);
      if (!pctYes || pctYes <= 0) continue;

      const oppConfidence = estimateConfidence(m.question, direction, absMov, pctYes, currentPrice, coin);
      if (oppConfidence < CONF_MIN) continue;

      opps.push({
        source:      'polymarket',
        marketTitle: m.question,
        url:         m.slug ? `https://polymarket.com/event/${m.slug}` : null,
        currentProb: pctYes,
        coin,
        movePct,
        direction,
        confidence:  oppConfidence,
        action:      `Buy YES at ${pctYes}¢ on Polymarket (${coin} just moved ${movePct > 0 ? '+' : ''}${movePct.toFixed(1)}%)`,
        kellyFrac:   +kelly(oppConfidence / 100, 100 / pctYes).toFixed(3),
        detectedAt:  Date.now(),
      });
    }
  }

  return opps.sort((a, b) => b.confidence - a.confidence);
}

function estimateConfidence(title, direction, movePct, currentProb, currentPrice, coin) {
  // Heuristic: higher confidence if:
  // - large move (>3%) → more likely to force prediction market reprice
  // - market prob is extreme (far from 50%) in unexpected direction
  // - market title explicitly references price targets we crossed

  let conf = 50;

  // Large moves = more confident
  if (movePct >= 5)      conf += 20;
  else if (movePct >= 3) conf += 12;
  else if (movePct >= 2) conf += 5;

  // If move is UP and YES prob is still low — lag opportunity
  if (direction === 'UP' && currentProb < 40)   conf += 10;
  if (direction === 'DOWN' && currentProb > 60)  conf += 10;

  // Title analysis: if it mentions specific price targets
  const t = title?.toLowerCase() ?? '';
  if (t.includes('above') || t.includes('over') || t.includes('exceed')) {
    if (direction === 'UP')   conf += 8;
    if (direction === 'DOWN') conf -= 8;
  }
  if (t.includes('below') || t.includes('under') || t.includes('fall')) {
    if (direction === 'DOWN') conf += 8;
    if (direction === 'UP')   conf -= 8;
  }

  // Already priced in: if prob is near 0 or 100, not much edge
  if (currentProb > 90 || currentProb < 10) conf -= 15;

  return Math.min(95, Math.max(20, Math.round(conf)));
}

function onPriceUpdate(coin, price) {
  const now = Date.now();
  if (!priceHistory[coin]) priceHistory[coin] = [];

  priceHistory[coin].push({ price, ts: now });
  // Keep only last 10 minutes
  priceHistory[coin] = priceHistory[coin].filter(p => now - p.ts < 10 * 60 * 1000);

  // Compare to 5 minutes ago
  const fiveMinAgo = priceHistory[coin].find(p => now - p.ts >= 5 * 60 * 1000 - 5000);
  if (!fiveMinAgo) return; // not enough history yet

  const movePct = ((price - fiveMinAgo.price) / fiveMinAgo.price) * 100;
  if (Math.abs(movePct) < MOVE_THRESH) return;

  // Check cooldown
  const lastAlert = alertCooldown[coin] ?? 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) return;

  console.log(`[mm] ${coin} moved ${movePct.toFixed(2)}% in 5min → scanning prediction markets`);

  const opps = detectInfoLag(coin, +movePct.toFixed(2), price);
  if (!opps.length) {
    console.log(`[mm] no info-lag opps found for ${coin}`);
    return;
  }

  // Save all opportunities
  const existing = readJson(OUT_FILE) ?? { opportunities: [] };
  existing.opportunities = [
    ...opps,
    ...existing.opportunities.filter(o => o.coin !== coin || now - o.detectedAt < 2 * 60 * 60 * 1000),
  ].slice(0, 50);
  existing.updatedAt = now;
  writeJson(OUT_FILE, existing);

  console.log(`[mm] found ${opps.length} info-lag opp(s) for ${coin} (best conf: ${opps[0].confidence}%)`);

  // Alert
  const highConf = opps.filter(o => o.confidence >= ALERT_MIN);
  if (highConf.length) {
    alertCooldown[coin] = now;
    const lines = highConf.slice(0, 3).map(o =>
      `<b>${o.marketTitle?.slice(0, 60)}</b>\n` +
      `Source: ${o.source} | Prob: ${o.currentProb}¢ | Conf: ${o.confidence}%\n` +
      `Action: ${o.action}\n` +
      `Kelly: ${(o.kellyFrac * 100).toFixed(1)}% of bankroll`
    ).join('\n\n');
    sendTelegram(
      `⚡ <b>INFO LAG DETECTED</b>\n${coin} moved ${movePct > 0 ? '+' : ''}${movePct.toFixed(2)}% in 5min\n${highConf.length} market(s) may be lagging:\n\n${lines}`
    );
  }
}

// Binance WebSocket kline stream (1-min candles for price updates)
function connectWebSocket() {
  const streams = SYMBOLS.map(s => `${s.toLowerCase()}@miniTicker`).join('/');
  const url     = `${WS_BASE}${streams}`;
  console.log(`[mm] connecting WebSocket: ${streams}`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[mm] WebSocket connected');
    beat();
  });

  ws.on('message', raw => {
    try {
      const msg  = JSON.parse(raw);
      const data = msg.data ?? msg;
      const sym  = data.s ?? data.symbol;
      if (!sym) return;

      const coin  = SYMBOLS.find(s => s === sym)?.replace('USDT', '');
      const price = parseFloat(data.c ?? data.lastPrice ?? '0');
      if (!coin || !price) return;

      onPriceUpdate(coin, price);
    } catch {}
  });

  ws.on('close', () => {
    console.log('[mm] WebSocket closed — reconnecting in 10s');
    setTimeout(connectWebSocket, 10000);
  });

  ws.on('error', err => {
    console.error('[mm] WebSocket error:', err.message);
  });

  // Heartbeat every 60s
  const hbInterval = setInterval(() => beat(), 60_000);
  ws.on('close', () => clearInterval(hbInterval));
}

// Check if ws module available
function checkDeps() {
  try { require.resolve('ws'); return true; }
  catch { return false; }
}

if (!checkDeps()) {
  console.error('[mm] ws module not installed — run: npm install ws');
  console.log('[mm] falling back to polling mode (REST every 60s)');
  startPollingMode();
} else {
  connectWebSocket();
}

// Polling fallback (no WebSocket)
async function startPollingMode() {
  function get(url) {
    return new Promise(resolve => {
      const req = https.get(url, { headers: { 'User-Agent': 'market-maker/1.0' }, timeout: 8000 }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', function () { this.destroy(); resolve(null); });
    });
  }

  async function pollPrices() {
    beat();
    for (const sym of SYMBOLS) {
      const coin = sym.replace('USDT', '');
      const data = await get(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
      if (data?.price) onPriceUpdate(coin, parseFloat(data.price));
    }
  }

  setInterval(pollPrices, 60_000);
  await pollPrices();
}
