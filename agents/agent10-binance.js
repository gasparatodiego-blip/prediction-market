#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');

const OUT          = '/tmp/exchange-prices.json';
const HIST_FILE    = '/tmp/exchange-history.json';
const BINANCE_COMPAT = '/tmp/binance-prices.json'; // keep for /api/crypto backwards-compat
const HB_FILE      = '/tmp/agent-heartbeats.json';
const INTERVAL     = 60_000;
const COINS        = ['BTC','ETH','SOL','BNB','XRP','DOGE'];
const CEX_THRESHOLD = 0.3; // % spread to flag CEX arb

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent10-binance'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
      timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', function() { this.destroy(); resolve(null); });
  });
}

// ── Exchange fetchers ─────────────────────────────

async function fetchBinance() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
  const data = await get(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
  if (!Array.isArray(data)) return {};
  const map = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE' };
  const result = {};
  for (const t of data) {
    const coin = map[t.symbol];
    if (!coin) continue;
    result[coin] = {
      price: parseFloat(t.lastPrice),
      change24hPct: parseFloat(t.priceChangePercent),
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      volume: parseFloat(t.volume),
    };
  }
  return result;
}

async function fetchCoinbase() {
  const pairs = { BTC:'BTC-USD', ETH:'ETH-USD', SOL:'SOL-USD', XRP:'XRP-USD', DOGE:'DOGE-USD' };
  const result = {};
  await Promise.all(Object.entries(pairs).map(async ([coin, pair]) => {
    const data = await get(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const price = parseFloat(data?.data?.amount);
    if (price > 0) result[coin] = { price };
  }));
  return result;
}

async function fetchOKX() {
  const data = await get('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  if (!Array.isArray(data?.data)) return {};
  const want = { 'BTC-USDT':'BTC','ETH-USDT':'ETH','SOL-USDT':'SOL','BNB-USDT':'BNB','XRP-USDT':'XRP','DOGE-USDT':'DOGE' };
  const result = {};
  for (const t of data.data) {
    const coin = want[t.instId];
    if (!coin) continue;
    const price = parseFloat(t.last);
    const open  = parseFloat(t.open24h);
    result[coin] = {
      price,
      change24hPct: open > 0 ? ((price - open) / open) * 100 : 0,
      high24h: parseFloat(t.high24h),
      low24h:  parseFloat(t.low24h),
      volume:  parseFloat(t.volCcy24h),
    };
  }
  return result;
}

async function fetchBybit() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
  const map  = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE' };
  const result = {};
  await Promise.all(syms.map(async sym => {
    const data = await get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`);
    const t    = data?.result?.list?.[0];
    if (!t) return;
    result[map[sym]] = {
      price:        parseFloat(t.lastPrice),
      change24hPct: parseFloat(t.price24hPcnt) * 100,
      high24h:      parseFloat(t.highPrice24h),
      low24h:       parseFloat(t.lowPrice24h),
      volume:       parseFloat(t.volume24h),
    };
  }));
  return result;
}

async function fetchKraken() {
  const data = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD,XDGUSD');
  if (!data?.result) return {};
  const result = {};
  for (const [key, val] of Object.entries(data.result)) {
    const last = parseFloat(val.c?.[0] ?? '0');
    const open = parseFloat(val.o  ?? '0');
    const high = parseFloat(val.h?.[1] ?? '0');
    const low  = parseFloat(val.l?.[1] ?? '0');
    const vol  = parseFloat(val.v?.[1] ?? '0');
    if (last <= 0) continue;
    const entry = { price: last, change24hPct: open > 0 ? ((last - open) / open) * 100 : 0, high24h: high, low24h: low, volume: vol };
    const k = key.toUpperCase();
    if (k.includes('XBT'))               result['BTC']  = entry;
    else if (k.includes('ETH'))          result['ETH']  = entry;
    else if (k.includes('SOL'))          result['SOL']  = entry;
    else if (k.includes('XRP'))          result['XRP']  = entry;
    else if (k.includes('XDG') || k.includes('DOGE')) result['DOGE'] = entry;
  }
  return result;
}

async function fetchGateIO() {
  const data = await get('https://api.gateio.ws/api/v4/spot/tickers');
  if (!Array.isArray(data)) return {};
  const want = { 'BTC_USDT':'BTC','ETH_USDT':'ETH','SOL_USDT':'SOL','BNB_USDT':'BNB','XRP_USDT':'XRP','DOGE_USDT':'DOGE' };
  const result = {};
  for (const t of data) {
    const coin = want[t.currency_pair];
    if (!coin) continue;
    result[coin] = {
      price:        parseFloat(t.last),
      change24hPct: parseFloat(t.change_percentage ?? '0'),
      high24h:      parseFloat(t.high_24h ?? '0'),
      low24h:       parseFloat(t.low_24h  ?? '0'),
      volume:       parseFloat(t.base_volume ?? '0'),
    };
  }
  return result;
}

// ── CEX arb detection ─────────────────────────────

function detectCexArb(exchanges) {
  const arbs = [];
  for (const coin of COINS) {
    const entries = [];
    for (const [ex, data] of Object.entries(exchanges)) {
      const p = data[coin]?.price;
      if (p > 0) entries.push({ exchange: ex, price: p });
    }
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.price - b.price);
    const lo = entries[0], hi = entries[entries.length - 1];
    const spreadPct = ((hi.price - lo.price) / lo.price) * 100;
    if (spreadPct >= CEX_THRESHOLD) {
      arbs.push({ coin, low: lo.exchange, lowPrice: lo.price, high: hi.exchange, highPrice: hi.price, spreadPct: Math.round(spreadPct * 1000) / 1000 });
    }
  }
  return arbs.sort((a, b) => b.spreadPct - a.spreadPct);
}

// ── 1h info-lag detection ─────────────────────────

function updateHistory(exchanges) {
  const now  = Date.now();
  let hist   = {};
  try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
  const binance = exchanges.binance ?? {};
  const infoLag = {};
  for (const coin of COINS) {
    const p = binance[coin]?.price;
    if (!hist[coin]) hist[coin] = [];
    if (p > 0) hist[coin].push({ t: now, p });
    hist[coin] = hist[coin].filter(e => now - e.t <= 3_600_000).slice(-60);
    const window = hist[coin];
    if (window.length < 2) { infoLag[coin] = false; continue; }
    const oldest = window[0].p, newest = window[window.length - 1].p;
    infoLag[coin] = oldest > 0 && Math.abs((newest - oldest) / oldest * 100) >= 3;
  }
  try { fs.writeFileSync(HIST_FILE, JSON.stringify(hist)); } catch {}
  return infoLag;
}

// ── Main ──────────────────────────────────────────

async function tick() {
  console.log('[multi-cex] fetching 6 exchanges...');
  const [binance, coinbase, okx, bybit, kraken, gateio] = await Promise.all([
    fetchBinance(), fetchCoinbase(), fetchOKX(), fetchBybit(), fetchKraken(), fetchGateIO(),
  ]);

  const exchanges = { binance, coinbase, okx, bybit, kraken, gateio };
  const cexArb    = detectCexArb(exchanges);
  const infoLag   = updateHistory(exchanges);
  const now       = Date.now();

  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: now, exchanges, cexArb, infoLag }, null, 2));

  // Backwards-compat: write /tmp/binance-prices.json for /api/crypto
  const bPrices = {};
  for (const coin of COINS) {
    const sym = coin + 'USDT';
    const b   = binance[coin];
    if (!b) continue;
    bPrices[sym] = {
      symbol: sym, price: b.price,
      priceChange24h: 0, priceChangePercent24h: b.change24hPct ?? 0,
      high24h: b.high24h ?? 0, low24h: b.low24h ?? 0, volume: b.volume ?? 0,
      change1hPct: 0, infoLag: infoLag[coin] ?? false,
    };
  }
  fs.writeFileSync(BINANCE_COMPAT, JSON.stringify({ fetchedAt: now, prices: bPrices }, null, 2));

  const arbStr = cexArb.map(a => `${a.coin} ${a.spreadPct.toFixed(2)}%`).join(', ') || 'none';
  console.log(`[multi-cex] BTC $${binance.BTC?.price?.toLocaleString()} | CEX arb: ${arbStr}`);
  beat();
}

tick();
setInterval(tick, INTERVAL);
