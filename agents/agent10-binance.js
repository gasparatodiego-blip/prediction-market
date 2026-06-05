#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT       = '/tmp/binance-prices.json';
const HB_FILE   = '/tmp/agent-heartbeats.json';
const INTERVAL  = 60_000;
const SYMBOLS   = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
const URL       = `https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(SYMBOLS)}`;

// Price history for 1h change detection (rolling 60 entries = 60 min)
const HISTORY_FILE = '/tmp/binance-history.json';
const MAX_HISTORY  = 60;

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent10-binance'] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function fetchJson(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'prediction-arb-scanner/1.0' }, timeout: 10000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
}

function saveHistory(hist) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2)); } catch {}
}

async function tick() {
  const raw = await fetchJson(URL);
  if (!Array.isArray(raw)) {
    console.error('[binance] fetch failed');
    beat();
    return;
  }

  const hist = loadHistory();
  const now  = Date.now();

  const prices = {};
  for (const t of raw) {
    const sym   = t.symbol;
    const price = parseFloat(t.lastPrice);

    // Rolling 1h history per symbol
    if (!hist[sym]) hist[sym] = [];
    hist[sym].push({ t: now, p: price });
    if (hist[sym].length > MAX_HISTORY) hist[sym] = hist[sym].slice(-MAX_HISTORY);

    // 1h change: compare to oldest entry within 60 min window
    const window = hist[sym].filter(e => now - e.t <= 3_600_000);
    const oldest = window[0];
    const change1h = oldest && oldest.p > 0
      ? ((price - oldest.p) / oldest.p) * 100
      : 0;

    prices[sym] = {
      symbol:               sym,
      price,
      priceChange24h:       parseFloat(t.priceChange),
      priceChangePercent24h: parseFloat(t.priceChangePercent),
      high24h:              parseFloat(t.highPrice),
      low24h:               parseFloat(t.lowPrice),
      volume:               parseFloat(t.volume),
      change1hPct:          Math.round(change1h * 100) / 100,
      infoLag:              Math.abs(change1h) >= 3,  // flag if ≥3% in 1h
    };
  }

  saveHistory(hist);
  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: now, prices }, null, 2));
  console.log(`[binance] saved — BTC $${prices['BTCUSDT']?.price?.toLocaleString()} | ETH $${prices['ETHUSDT']?.price?.toLocaleString()}`);
  beat();
}

tick();
setInterval(tick, INTERVAL);
