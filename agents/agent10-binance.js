#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const path  = require('path');
const WebSocket = require('ws');
const { httpGet: _sharedGet, httpPost: _httpPost } = require('../lib/httpGet');
const { rlGet: _rlGet, rlPost: _rlPost } = require('../lib/rateLimitedFetch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const { annualize } = require('../lib/funding-math');

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

const OUT            = '/tmp/exchange-prices.json';
const HIST_FILE      = '/tmp/exchange-history.json';
const BINANCE_COMPAT = '/tmp/binance-prices.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const ALERT_FILE     = '/tmp/funding-alert.json';
const POLL_INTERVAL  = 60_000;
const WRITE_THROTTLE = 2_000;
const COINS          = ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK']; // spot + alerts
// Expanded set for perp/funding monitoring (≥2 exchanges each)
const PERP_COINS     = new Set([
  'BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','LINK',
  'UNI','LTC','MATIC','ATOM','NEAR','APT','ARB','OP','SUI','PEPE',
  'TRX','INJ','TIA','WIF','TON',
]);
const CEX_THRESHOLD  = 0.3;
const FUND_THRESHOLD = 0.05;  // % per 8h
const BASIS_THRESHOLD = 0.3;
const ALERT_THRESHOLD = 0.01; // % per 8h
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT        = process.env.TELEGRAM_CHAT_ID;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// dYdX: min USD OI to include a market (filter noise)
const DYDX_MIN_LIQ = 500_000;

let wsData    = {};
let restData  = {};
let futures   = {};
let cexArb    = [];
let basisTrades = [];
let highFunding = [];
let infoLag   = {};
let lastWrite = 0;

// ── Utilities ─────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent10-binance'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return _sharedGet(url, { timeoutMs: 10_000, headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' } })
    .then(r => r.data).catch(() => null);
}

function postJson(hostname, path, body) {
  return _httpPost(`https://${hostname}${path}`, body, { timeoutMs: 10_000, headers: { 'User-Agent': 'prediction-arb-scanner/1.0' } })
    .then(r => r.data).catch(() => null);
}

// Rate-limited variants for venues that need many per-symbol calls (edgeX, Grvt).
// Route every call to that host through the shared per-host limiter (bounded
// concurrency + spacing + 429/Cloudflare backoff) instead of a 20-wide fan-out.
// Same null-on-failure contract as get()/postJson() — a backed-off host returns
// null so the venue is simply absent this cycle (never fabricated).
const RL = { concurrency: 2, spacingMs: 120, timeoutMs: 10_000,
  headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' } };
function rlGetJson(url) {
  return _rlGet(url, RL).then(r => r.data).catch(() => null);
}
function rlPostJson(url, body) {
  return _rlPost(url, body, RL).then(r => r.data).catch(() => null);
}

// ── Telegram alerts ───────────────────────────────────────────────────────────

function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  _httpPost(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body, { timeoutMs: 10_000 })
    .then(r => { if (!r.data?.ok) console.error('[tg] send failed:', r.data?.description); else console.log('[tg] alert sent OK'); })
    .catch(e => console.error('[tg] request error:', e.message));
}

function checkFundingAlerts(binPerps) {
  let alertState = { last_alert_time: 0 };
  try { alertState = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch {}
  const now = Date.now();
  if (now - (alertState.last_alert_time ?? 0) < EIGHT_HOURS_MS) return;

  const rows = [];
  let best = null;

  for (const coin of COINS) {
    const fr = binPerps[coin]?.fundingRate;
    if (typeof fr !== 'number' || isNaN(fr)) continue;
    const absFr  = Math.abs(fr);
    const frStr  = (fr >= 0 ? '+' : '') + fr.toFixed(4) + '%';
    const apy    = Math.round(annualize(fr, 8) * 10) / 10;
    const apyAbs = Math.abs(apy);
    let label, emoji;
    if (absFr < ALERT_THRESHOLD)  { label = 'flat'; emoji = '➖'; }
    else if (fr > 0) { label = `${apyAbs.toFixed(0)}% APY`; emoji = absFr >= 0.05 ? '🔥' : '✅'; }
    else             { label = 'negative'; emoji = absFr >= 0.05 ? '🔥' : '⚠️'; }
    rows.push(`${coin}: ${frStr}/8h = ${label} ${emoji}`);
    if (absFr >= ALERT_THRESHOLD && (!best || absFr > Math.abs(best.fr))) best = { coin, fr };
  }

  if (!best) return;
  const bestAbsFr  = Math.abs(best.fr);
  const bestFrStr  = (best.fr >= 0 ? '+' : '') + best.fr.toFixed(4) + '%';
  const bestMonthly = Math.round(5000 * (bestAbsFr / 100) * 3 * 30 * 100) / 100;
  sendTelegram(`🚀 FUNDING RATE ALERTS\n\n${rows.join('\n')}\n\nBest opportunity: ${best.coin} ${bestFrStr}/8h\nOn $5,000: $${bestMonthly}/month estimated`);
  alertState.last_alert_time = now;
  alertState.last_best       = best;
  try { fs.writeFileSync(ALERT_FILE, JSON.stringify(alertState, null, 2)); } catch {}
  console.log(`[tg] multi-coin funding alert sent — best: ${best.coin} ${bestFrStr}/8h`);
}

// ── Binance WebSocket ──────────────────────────────────────────────────────────

const COIN_SYM = {
  BTC:'btcusdt', ETH:'ethusdt', SOL:'solusdt', BNB:'bnbusdt',
  XRP:'xrpusdt', DOGE:'dogeusdt', AVAX:'avaxusdt', LINK:'linkusdt',
};
const SYM_COIN = Object.fromEntries(Object.entries(COIN_SYM).map(([c,s]) => [s, c]));
const WS_URL   = `wss://stream.binance.com:9443/stream?streams=${Object.values(COIN_SYM).map(s => `${s}@ticker`).join('/')}`;

function connectWS() {
  let ws;
  try { ws = new WebSocket(WS_URL); } catch { return; }
  ws.on('open', () => console.log('[ws] Binance stream connected'));
  ws.on('message', raw => {
    try {
      const msg  = JSON.parse(raw.toString());
      const t    = msg.data ?? msg;
      const coin = SYM_COIN[t.s?.toLowerCase()];
      if (!coin) return;
      wsData[coin] = {
        price:        parseFloat(t.c),
        change24hPct: parseFloat(t.P),
        high24h:      parseFloat(t.h),
        low24h:       parseFloat(t.l),
        volume:       parseFloat(t.v),
        wsAt:         Date.now(),
      };
      const now = Date.now();
      if (now - lastWrite >= WRITE_THROTTLE) { writeOutput(); lastWrite = now; }
    } catch {}
  });
  ws.on('error', err => console.error('[ws] error:', err.message));
  ws.on('close', () => { console.log('[ws] closed — reconnecting in 5s'); setTimeout(connectWS, 5000); });
}

// ── CEX REST fetchers ──────────────────────────────────────────────────────────

async function fetchBinanceREST() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT'];
  const data = await rlGetJson(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
  if (!Array.isArray(data)) return;
  const map = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE', AVAXUSDT:'AVAX', LINKUSDT:'LINK' };
  for (const t of data) {
    const coin = map[t.symbol];
    if (!coin) continue;
    if (!wsData[coin] || Date.now() - (wsData[coin].wsAt ?? 0) > 30_000) {
      wsData[coin] = { price: parseFloat(t.lastPrice), change24hPct: parseFloat(t.priceChangePercent), high24h: parseFloat(t.highPrice), low24h: parseFloat(t.lowPrice), volume: parseFloat(t.volume) };
    }
  }
}

async function fetchCoinbase() {
  const pairs = { BTC:'BTC-USD', ETH:'ETH-USD', SOL:'SOL-USD', XRP:'XRP-USD', DOGE:'DOGE-USD', AVAX:'AVAX-USD', LINK:'LINK-USD' };
  const r = {};
  await Promise.all(Object.entries(pairs).map(async ([coin, pair]) => {
    const d = await get(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const p = parseFloat(d?.data?.amount);
    if (p > 0) r[coin] = { price: p };
  }));
  return r;
}

async function fetchOKX() {
  const d = await rlGetJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  if (!Array.isArray(d?.data)) return {};
  const want = {
    'BTC-USDT':'BTC','ETH-USDT':'ETH','SOL-USDT':'SOL','BNB-USDT':'BNB',
    'XRP-USDT':'XRP','DOGE-USDT':'DOGE','AVAX-USDT':'AVAX','LINK-USDT':'LINK',
  };
  const r = {};
  for (const t of d.data) {
    const coin = want[t.instId];
    if (!coin) continue;
    const price = parseFloat(t.last), open = parseFloat(t.open24h);
    r[coin] = { price, change24hPct: open > 0 ? ((price - open) / open) * 100 : 0, high24h: parseFloat(t.high24h), low24h: parseFloat(t.low24h), volume: parseFloat(t.volCcy24h) };
  }
  return r;
}

async function fetchBybit() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT'];
  const map  = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE', AVAXUSDT:'AVAX', LINKUSDT:'LINK' };
  const r = {};
  await Promise.all(syms.map(async sym => {
    const d = await rlGetJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`);
    const t = d?.result?.list?.[0];
    if (t) r[map[sym]] = { price: parseFloat(t.lastPrice), change24hPct: parseFloat(t.price24hPcnt) * 100, high24h: parseFloat(t.highPrice24h), low24h: parseFloat(t.lowPrice24h), volume: parseFloat(t.volume24h) };
  }));
  return r;
}

async function fetchKraken() {
  const d = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD,XDGUSD,AVAXUSD,LINKUSD');
  if (!d?.result) return {};
  const r = {};
  for (const [key, val] of Object.entries(d.result)) {
    const last = parseFloat(val.c?.[0] ?? '0'), open = parseFloat(val.o ?? '0');
    if (last <= 0) continue;
    const entry = { price: last, change24hPct: open > 0 ? ((last - open) / open) * 100 : 0, high24h: parseFloat(val.h?.[1]??'0'), low24h: parseFloat(val.l?.[1]??'0'), volume: parseFloat(val.v?.[1]??'0') };
    const k = key.toUpperCase();
    if      (k.includes('XBT'))                      r.BTC  = entry;
    else if (k.includes('ETH'))                      r.ETH  = entry;
    else if (k.includes('SOL'))                      r.SOL  = entry;
    else if (k.includes('XRP'))                      r.XRP  = entry;
    else if (k.includes('XDG') || k.includes('DOGE')) r.DOGE = entry;
    else if (k.includes('AVAX'))                     r.AVAX = entry;
    else if (k.includes('LINK'))                     r.LINK = entry;
  }
  return r;
}

async function fetchGateIO() {
  const d = await rlGetJson('https://api.gateio.ws/api/v4/spot/tickers');
  if (!Array.isArray(d)) return {};
  const want = {
    'BTC_USDT':'BTC','ETH_USDT':'ETH','SOL_USDT':'SOL','BNB_USDT':'BNB',
    'XRP_USDT':'XRP','DOGE_USDT':'DOGE','AVAX_USDT':'AVAX','LINK_USDT':'LINK',
  };
  const r = {};
  for (const t of d) {
    const coin = want[t.currency_pair];
    if (!coin) continue;
    r[coin] = { price: parseFloat(t.last), change24hPct: parseFloat(t.change_percentage??'0'), high24h: parseFloat(t.high_24h??'0'), low24h: parseFloat(t.low_24h??'0'), volume: parseFloat(t.base_volume??'0') };
  }
  return r;
}

// ── Perpetual futures + funding rates ──────────────────────────────────────────

function nextHourUTC() {
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
}

const BIN_PERP_MAP = {
  BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB',
  XRPUSDT:'XRP', DOGEUSDT:'DOGE', AVAXUSDT:'AVAX', LINKUSDT:'LINK',
};

async function fetchBinancePerpVol() {
  const syms = [...PERP_COINS].map(c => `${c}USDT`);
  try {
    const data = await rlGetJson(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
    if (!Array.isArray(data)) return {};
    const r = {};
    for (const t of data) {
      const coin = t.symbol?.replace('USDT', '');
      if (coin && PERP_COINS.has(coin)) r[coin] = parseFloat(t.quoteVolume);
    }
    return r;
  } catch { return {}; }
}

async function fetchHyperliquid() {
  try {
    const raw = await postJson('api.hyperliquid.xyz', '/info', JSON.stringify({ type: 'metaAndAssetCtxs' }));
    if (!Array.isArray(raw) || raw.length < 2) return {};
    const meta = raw[0], ctxs = raw[1];
    const WANT = PERP_COINS;
    const r = {};
    for (let i = 0; i < (meta.universe?.length ?? 0); i++) {
      const name = meta.universe[i]?.name;
      if (!WANT.has(name)) continue;
      const ctx = ctxs[i];
      if (!ctx) continue;
      const fr     = parseFloat(ctx.funding);
      const markPx = parseFloat(ctx.markPx) || 0;
      const oiBase = parseFloat(ctx.openInterest) || 0;
      if (!isFinite(fr)) continue;
      r[name] = {
        markPrice:            markPx || null,
        fundingRate:          fr * 100,    // fraction/hr → %/hr
        fundingIntervalHours: 1,
        nextFundingTime:      nextHourUTC(),
        openInterest:         oiBase || null,
        openInterestUsd:      oiBase > 0 && markPx > 0 ? oiBase * markPx : null,
      };
    }
    return r;
  } catch (e) {
    console.error('[hl] fetchHyperliquid error:', e.message);
    return {};
  }
}

async function fetchDydx() {
  try {
    const data = await get('https://indexer.dydx.trade/v4/perpetualMarkets');
    const mkts  = data?.markets ?? {};
    const r = {};
    for (const [name, m] of Object.entries(mkts)) {
      const asset  = name.replace('-USD', '');
      const fr     = parseFloat(m.nextFundingRate ?? '0');
      const price  = parseFloat(m.oraclePrice ?? '0');
      const oi     = parseFloat(m.openInterest ?? '0');
      const vol24  = parseFloat(m.volume24H ?? '0');
      if (!isFinite(fr) || price <= 0) continue;
      const oiUsd = oi * price;
      // Skip markets with no meaningful liquidity
      if (oiUsd < DYDX_MIN_LIQ && vol24 < DYDX_MIN_LIQ / 5) continue;
      r[asset] = {
        markPrice:            price,
        fundingRate:          fr * 100,    // fraction/hr → %/hr
        fundingIntervalHours: 1,           // dYdX v4: hourly
        openInterestUsd:      oiUsd > 0 ? oiUsd : null,
        vol24hUsd:            vol24 > 0   ? vol24  : null,
      };
    }
    console.log(`[dydx] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[dydx] fetch error:', e.message);
    return {};
  }
}

async function fetchGateIOPerps() {
  try {
    const data = await rlGetJson('https://api.gateio.ws/api/v4/futures/usdt/tickers');
    if (!Array.isArray(data)) return {};
    const r = {};
    for (const t of data) {
      const coin = t.contract?.replace('_USDT', '');
      if (!coin || !PERP_COINS.has(coin)) continue;
      const fr = parseFloat(t.funding_rate ?? '0') * 100; // fraction → %
      if (!isFinite(fr)) continue;
      r[coin] = {
        markPrice:            parseFloat(t.mark_price ?? '0') || null,
        fundingRate:          fr,
        fundingIntervalHours: 8,
        openInterestUsd:      null, // contract unit varies; use vol as liquidity proxy
        vol24hUsd:            parseFloat(t.vol_24h_settle ?? t.vol_24h_quote ?? '0') || null,
      };
    }
    console.log(`[gateio-perps] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[gateio-perps] error:', e.message);
    return {};
  }
}

async function fetchBitget() {
  try {
    const data = await rlGetJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    if (!Array.isArray(data?.data)) return {};
    const r = {};
    for (const t of data.data) {
      const symbol = t.symbol ?? '';
      // v2 format: "BTCUSDT" (no _UMCBL suffix)
      if (!symbol.endsWith('USDT')) continue;
      const coin = symbol.slice(0, -4);
      if (!PERP_COINS.has(coin)) continue;
      const fr    = parseFloat(t.fundingRate ?? '0') * 100; // fraction → %
      if (!isFinite(fr)) continue;
      const markPx = parseFloat(t.markPrice    ?? '0');
      const oi     = parseFloat(t.holdingAmount ?? '0');
      r[coin] = {
        markPrice:            markPx || null,
        fundingRate:          fr,
        fundingIntervalHours: 8,
        openInterest:         oi     || null,
        openInterestUsd:      oi > 0 && markPx > 0 ? oi * markPx : null,
        vol24hUsd:            parseFloat(t.usdtVolume ?? '0') || null,
      };
    }
    console.log(`[bitget] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[bitget] error:', e.message);
    return {};
  }
}

async function fetchAster() {
  // Aster perp DEX — Binance-identical public REST (no auth for market data).
  // premiumIndex → per-symbol lastFundingRate/markPrice; fundingInfo → per-symbol
  // interval overrides (default 8h; Binance-style venues return sub-8h entries here);
  // ticker/24hr → USD volume for the liquidity tier. Base confirmed 2026-07-04:
  // https://fapi.asterdex.com
  try {
    const [premium, fundingInfo, tickers] = await Promise.all([
      get('https://fapi.asterdex.com/fapi/v1/premiumIndex'),
      get('https://fapi.asterdex.com/fapi/v1/fundingInfo'),
      get('https://fapi.asterdex.com/fapi/v1/ticker/24hr'),
    ]);
    if (!Array.isArray(premium)) return {};

    // symbol → funding interval (hours). Absent ⇒ 8h default.
    const intervalBySymbol = {};
    if (Array.isArray(fundingInfo)) {
      for (const f of fundingInfo) {
        const h = parseInt(f.fundingIntervalHours ?? '8', 10);
        if (f.symbol && isFinite(h) && h > 0) intervalBySymbol[f.symbol] = h;
      }
    }
    // symbol → 24h quote (USD) volume for liquidity tiering
    const volBySymbol = {};
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        const q = parseFloat(t.quoteVolume ?? '0');
        if (t.symbol && isFinite(q) && q > 0) volBySymbol[t.symbol] = q;
      }
    }

    const r = {};
    for (const t of premium) {
      const sym = t.symbol ?? '';
      if (!sym.endsWith('USDT')) continue;          // USDT-quoted perps only (USDT treated as USD)
      const coin = sym.slice(0, -4);
      if (!PERP_COINS.has(coin)) continue;
      const raw    = parseFloat(t.lastFundingRate);
      const markPx = parseFloat(t.markPrice);
      if (!isFinite(raw)) continue;
      const intervalHours = intervalBySymbol[sym] ?? 8;
      r[coin] = {
        markPrice:            isFinite(markPx) ? markPx : null,
        // Native %/interval + native intervalHours — mirrors Binance (8h) and HL/dYdX
        // (1h): annualize(rate, intervalHours) normalises to %/yr, and the /8h display
        // scales by 8/intervalHours. Positive = longs pay shorts (same as Binance/HL).
        fundingRate:          raw * 100,             // fraction → % per its own funding interval
        fundingIntervalHours: intervalHours,         // 8h default; sub-8h symbols per /fundingInfo
        nextFundingTime:      parseInt(t.nextFundingTime ?? '0') || null,
        vol24hUsd:            volBySymbol[sym] ?? null,
      };
    }
    console.log(`[aster] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[aster] fetch error:', e.message);
    return {};
  }
}

async function fetchParadex() {
  // Paradex — StarkNet CLOB perp DEX, PUBLIC REST (no auth/signature for market
  // data). NOT Binance-style: /markets → PERP list + funding_period_hours;
  // /markets/summary?market=ALL → per-market mark_price/funding_rate/open_interest/
  // volume_24h. funding_rate is Paradex's funding-PERIOD (8h) rate as a fraction —
  // confirmed against /funding/data.funding_rate_8h and the ~0.01%/8h BTC baseline.
  // Base confirmed 2026-07-04: https://api.prod.paradex.trade/v1
  try {
    const [markets, summary] = await Promise.all([
      get('https://api.prod.paradex.trade/v1/markets'),
      get('https://api.prod.paradex.trade/v1/markets/summary?market=ALL'),
    ]);
    const rows = summary?.results;
    if (!Array.isArray(rows)) return {};

    // symbol → funding period hours (default 8; only PERP markets). Mirrors Aster's
    // per-symbol interval-override map built from /fundingInfo.
    const periodBySymbol = {};
    for (const m of markets?.results ?? []) {
      if (m.asset_kind !== 'PERP') continue;
      const h = parseInt(m.funding_period_hours ?? 8, 10);
      if (m.symbol && isFinite(h) && h > 0) periodBySymbol[m.symbol] = h;
    }

    const r = {};
    for (const row of rows) {
      const sym = row.symbol ?? '';
      if (!sym.endsWith('-USD-PERP')) continue;          // USD-quoted perps (USDC settle = USD)
      const coin = sym.slice(0, -'-USD-PERP'.length);
      if (!PERP_COINS.has(coin)) continue;
      const fr   = parseFloat(row.funding_rate);
      if (!isFinite(fr)) continue;
      const mark = parseFloat(row.mark_price);
      const oi   = parseFloat(row.open_interest);
      const vol  = parseFloat(row.volume_24h);
      const intervalHours = periodBySymbol[sym] ?? 8;
      r[coin] = {
        markPrice:            isFinite(mark) ? mark : null,
        // funding_rate is the 8h-period rate as a fraction → ×100 = %/8h. Positive =
        // longs pay shorts (same as Binance/HL). annualize(rate, intervalHours) then
        // normalises to %/yr, mirroring every other venue.
        fundingRate:          fr * 100,
        fundingIntervalHours: intervalHours,
        openInterestUsd:      isFinite(oi) && isFinite(mark) && oi > 0 && mark > 0 ? oi * mark : null,
        vol24hUsd:            isFinite(vol) && vol > 0 ? vol : null,
      };
    }
    console.log(`[paradex] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[paradex] fetch error:', e.message);
    return {};
  }
}

async function fetchEdgex() {
  // edgeX — StarkEx CLOB perp DEX, PUBLIC REST (no auth/signature for market data).
  // getMetaData → contractId↔contractName (BTCUSD…), per-contract fundingRateIntervalMin
  // (240 = 4h — NOT 8h) and taker/maker fees. getTicker?contractId=<id> → fundingRate
  // (per funding interval) / markPrice / openInterest / value (24h USD vol). There is
  // NO bulk ticker (contractName/comma/repeat params all return []), so one getTicker
  // per contract. Base confirmed 2026-07-04: https://pro.edgex.exchange/api/v1
  try {
    const meta = await rlGetJson('https://pro.edgex.exchange/api/v1/public/meta/getMetaData');
    const contracts = meta?.data?.contractList;
    if (!Array.isArray(contracts)) return {};

    // PERP_COINS ∩ tradable USD-quoted contracts → { coin, contractId, intervalHours }.
    // Read the funding interval PER contract (do not assume 8h): 240min ⇒ 4h.
    const wanted = [];
    for (const c of contracts) {
      const name = c.contractName ?? '';
      if (!name.endsWith('USD') || c.enableTrade === false) continue;
      const coin = name.slice(0, -3);
      if (!PERP_COINS.has(coin)) continue;
      const im = parseInt(c.fundingRateIntervalMin ?? '240', 10);
      wanted.push({ coin, contractId: c.contractId, intervalHours: isFinite(im) && im > 0 ? im / 60 : 4 });
    }

    const r = {};
    await Promise.all(wanted.map(async ({ coin, contractId, intervalHours }) => {
      // 22 calls fan out here, but the shared per-host limiter serialises them to a
      // small pool with spacing + 429 backoff, so edgeX's Cloudflare never trips.
      const q = await rlGetJson(`https://pro.edgex.exchange/api/v1/public/quote/getTicker?contractId=${contractId}`);
      const t = Array.isArray(q?.data) ? q.data[0] : null;
      if (!t) return;
      const fr = parseFloat(t.fundingRate);
      if (!isFinite(fr)) return;
      const mark = parseFloat(t.markPrice);
      const oi   = parseFloat(t.openInterest);
      const vol  = parseFloat(t.value);
      r[coin] = {
        markPrice:            isFinite(mark) ? mark : null,
        // fundingRate is edgeX's per-INTERVAL (4h) rate as a fraction → ×100 = %/4h.
        // Positive = longs pay shorts (same as Binance/HL). annualize(rate, intervalHours)
        // and the %/8h display both scale via intervalHours (=4) — mirrors HL/dYdX (=1)
        // and Paradex (=8). No pre-normalisation to 8h here; the engine handles it.
        fundingRate:          fr * 100,
        fundingIntervalHours: intervalHours,
        openInterestUsd:      isFinite(oi) && isFinite(mark) && oi > 0 && mark > 0 ? oi * mark : null,
        vol24hUsd:            isFinite(vol) && vol > 0 ? vol : null,
      };
    }));
    console.log(`[edgex] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[edgex] fetch error:', e.message);
    return {};
  }
}

async function fetchGrvt() {
  // Grvt — hybrid CLOB perp DEX, PUBLIC market-data API (no auth/signature to READ:
  // instruments, ticker, book, funding all confirmed unauthenticated 2026-07-04).
  // JSON-RPC-style POST bodies. Keys on the instrument NAME (BTC_USDT_Perp), derivable
  // from coin — NO numeric id map. Base: https://market-data.grvt.io/full/v1
  //
  // CRITICAL — funding UNIT: Grvt's funding_rate_8h_curr is ALREADY a PERCENT per 8h
  // (e.g. BTC "0.01" = 0.01%/8h), NOT a raw fraction like every other venue. Calibrated
  // live vs Binance (Grvt 0.01/0.0054/-0.0006 ≈ Binance 0.00927/0.00434/-0.00541 %/8h).
  // So NO ×100 here — a fraction reading would 100× it into absurd 500-1000%/yr arbs.
  try {
    const instr = await rlPostJson('https://market-data.grvt.io/full/v1/instruments',
      { kind: ['PERPETUAL'], quote: ['USDT'], is_active: true });
    const list = instr?.result;
    if (!Array.isArray(list)) return {};

    // PERP_COINS ∩ USDT perps → { coin, instrument, intervalHours }. Read funding
    // interval PER instrument from metadata (Grvt is 8h; verify, don't assume).
    const wanted = [];
    for (const it of list) {
      const base = it.base ?? '';
      if (it.quote !== 'USDT' || !PERP_COINS.has(base)) continue;
      const ih = parseInt(it.funding_interval_hours ?? '8', 10);
      wanted.push({ coin: base, instrument: it.instrument, intervalHours: isFinite(ih) && ih > 0 ? ih : 8 });
    }

    const r = {};
    await Promise.all(wanted.map(async ({ coin, instrument, intervalHours }) => {
      // Same shared per-host limiter as edgeX — the ~19-call loop is serialised to a
      // small pool with spacing + 429 backoff instead of fanning out unbounded.
      const q = await rlPostJson('https://market-data.grvt.io/full/v1/ticker', { instrument });
      const t = q?.result;
      if (!t) return;
      const fr = parseFloat(t.funding_rate_8h_curr);
      if (!isFinite(fr)) return;
      const mark = parseFloat(t.mark_price);
      const oi   = parseFloat(t.open_interest);
      const vol  = parseFloat(t.buy_volume_24h_q) + parseFloat(t.sell_volume_24h_q);
      r[coin] = {
        markPrice:            isFinite(mark) ? mark : null,
        // funding_rate_8h_curr is ALREADY %/8h (see header) — store as-is, NO ×100.
        // Positive = longs pay shorts. intervalHours from instrument metadata (8h).
        fundingRate:          fr,
        fundingIntervalHours: intervalHours,
        openInterestUsd:      isFinite(oi) && isFinite(mark) && oi > 0 && mark > 0 ? oi * mark : null,
        vol24hUsd:            isFinite(vol) && vol > 0 ? vol : null,
      };
    }));
    console.log(`[grvt] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[grvt] fetch error:', e.message);
    return {};
  }
}

async function fetchLighter() {
  // Lighter (zkLighter) — CLOB perp DEX, PUBLIC read-only REST (no auth for market data).
  // Base confirmed 2026-07-04: https://mainnet.zklighter.elliot.ai. Routed through the
  // shared per-host limiter (rlGetJson) from the start — fresh host, 429-proofed. One bulk
  // /funding-rates call covers every market; agent15 keys depth/history on a numeric
  // market_id map (like edgeX), but agent10 needs none — /funding-rates carries `symbol`.
  //
  // CRITICAL — funding UNIT: /funding-rates aggregates MANY venues (filter exchange==='lighter')
  // and reports each on an 8h-NORMALIZED FRACTION basis (calibrated live: its Hyperliquid row
  // 0.0001 == HL's real hourly 0.0000125 ×8; and its Lighter row ×12.5 == Lighter's own native
  // hourly `fundings` history exactly). Lighter settles HOURLY, so native %/hr = raw / 8 * 100,
  // stored with fundingIntervalHours=1. BTC 0.000096 → 0.0012 %/hr → 0.0096%/8h ≈ baseline.
  // Reading raw as a native hourly fraction would 8× it into phantom arbs — do NOT.
  try {
    const j = await rlGetJson('https://mainnet.zklighter.elliot.ai/api/v1/funding-rates');
    const rows = j?.funding_rates;
    if (!Array.isArray(rows)) return {};
    const r = {};
    for (const row of rows) {
      if (row.exchange !== 'lighter') continue;
      const coin = row.symbol ?? '';
      if (!PERP_COINS.has(coin)) continue;
      const raw = parseFloat(row.rate);              // 8h-normalized fraction
      if (!isFinite(raw)) continue;
      r[coin] = {
        markPrice:            null,                   // /funding-rates carries no mark/OI/vol
        // 8h-normalized fraction → native %/hr (see header). Positive = longs pay shorts.
        fundingRate:          raw / 8 * 100,
        fundingIntervalHours: 1,                      // Lighter settles hourly (top of UTC hour)
        openInterestUsd:      null,
        vol24hUsd:            null,
      };
    }
    console.log(`[lighter] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[lighter] fetch error:', e.message);
    return {};
  }
}

async function fetchExtended() {
  // Extended (extended.exchange) — StarkNet CLOB perp DEX, PUBLIC REST (markets/funding/
  // depth all confirmed unauthenticated 2026-07-04). Keys on the market NAME (BTC-USD,
  // derivable from coin) — NO numeric id map. Routed through the shared per-host limiter
  // (rlGetJson) from the start. One bulk /info/markets call covers every market.
  // Base: https://api.starknet.extended.exchange/api/v1
  //
  // Funding UNIT: marketStats.fundingRate is a raw FRACTION per HOUR (BTC 0.000013 ≈ HL's
  // 0.0000125/hr). Extended settles HOURLY (hourlyFundingRateCap; funding history rows 1h
  // apart). So ×100 → %/hr, stored with fundingIntervalHours=1 (same as dYdX/HL). BTC →
  // 0.0104%/8h ≈ baseline. Reading it as %/hr or 8h-normalized would mis-scale it.
  // NOTE: marketStats.nextFundingRate is MISNAMED — its value is the next-funding TIMESTAMP
  // (ms), captured into nextFundingTime for the per-leg countdown.
  try {
    const j = await rlGetJson('https://api.starknet.extended.exchange/api/v1/info/markets');
    const list = j?.data;
    if (!Array.isArray(list)) return {};
    const r = {};
    for (const m of list) {
      if (m.type !== 'PERPETUAL' || m.status !== 'ACTIVE') continue;
      const name = m.name ?? '';
      if (!name.endsWith('-USD')) continue;
      const coin = name.slice(0, -4);
      if (!PERP_COINS.has(coin)) continue;
      const st = m.marketStats || {};
      const fr = parseFloat(st.fundingRate);
      if (!isFinite(fr)) continue;
      const mark = parseFloat(st.markPrice);
      const oi   = parseFloat(st.openInterest);   // already USD
      const vol  = parseFloat(st.dailyVolume);    // already USD
      const nft  = Number(st.nextFundingRate);    // misnamed: next-funding TIMESTAMP (ms)
      r[coin] = {
        markPrice:            isFinite(mark) && mark > 0 ? mark : null,
        // raw fraction/hr → %/hr (×100). Positive = longs pay shorts. Hourly settlement.
        fundingRate:          fr * 100,
        fundingIntervalHours: 1,
        openInterestUsd:      isFinite(oi) && oi > 0 ? oi : null,
        vol24hUsd:            isFinite(vol) && vol > 0 ? vol : null,
        nextFundingTime:      Number.isFinite(nft) && nft > 0 ? nft : null,
      };
    }
    console.log(`[extended] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[extended] fetch error:', e.message);
    return {};
  }
}

async function fetchPacifica() {
  // Pacifica (pacifica.fi) — Solana CLOB perp DEX, PUBLIC REST (markets/funding/depth all
  // confirmed unauthenticated 2026-07-05; real walkable L2 book at /book). Keys on the
  // market SYMBOL (BTC, derivable from coin) — NO numeric id map. Routed through the shared
  // per-host limiter (rlGetJson) from the start. One bulk /info/prices call covers every
  // market. Base: https://api.pacifica.fi/api/v1
  //
  // Funding UNIT: `funding` is a raw FRACTION per HOUR (BTC 0.0000125 == HL's baseline hourly
  // fraction; funding_rate history rows are 1h apart). So ×100 → %/hr, stored with
  // fundingIntervalHours=1 (same as dYdX/HL/Extended). BTC → 0.01%/8h ≈ baseline. `next_funding`
  // is a predicted RATE, not a timestamp — Pacifica exposes no next-funding time, so leave
  // nextFundingTime null and the countdown falls back to the UTC-hourly boundary (path b).
  try {
    const j = await rlGetJson('https://api.pacifica.fi/api/v1/info/prices');
    const list = j?.data;
    if (!Array.isArray(list)) return {};
    const r = {};
    for (const m of list) {
      const coin = m.symbol ?? '';
      if (!PERP_COINS.has(coin)) continue;
      const fr = parseFloat(m.funding);
      if (!isFinite(fr)) continue;
      const mark = parseFloat(m.mark);
      const oiCoins = parseFloat(m.open_interest);   // base units → ×mark for USD
      const vol     = parseFloat(m.volume_24h);      // already USD
      r[coin] = {
        markPrice:            isFinite(mark) && mark > 0 ? mark : null,
        // raw fraction/hr → %/hr (×100). Positive = longs pay shorts. Hourly settlement.
        fundingRate:          fr * 100,
        fundingIntervalHours: 1,
        openInterestUsd:      isFinite(oiCoins) && isFinite(mark) && oiCoins > 0 && mark > 0 ? oiCoins * mark : null,
        vol24hUsd:            isFinite(vol) && vol > 0 ? vol : null,
      };
    }
    console.log(`[pacifica] ${Object.keys(r).length} markets`);
    return r;
  } catch (e) {
    console.error('[pacifica] fetch error:', e.message);
    return {};
  }
}

async function fetchFutures() {
  const [binF, bybitF, okxF, hlF] = await Promise.all([

    // Binance FAPI — premiumIndex returns ALL perps; filter by PERP_COINS
    rlGetJson('https://fapi.binance.com/fapi/v1/premiumIndex').then(data => {
      if (!Array.isArray(data)) return {};
      const r = {};
      for (const t of data) {
        if (!t.symbol.endsWith('USDT')) continue;
        const coin = t.symbol.slice(0, -4);
        if (!PERP_COINS.has(coin)) continue;
        r[coin] = {
          markPrice:            parseFloat(t.markPrice),
          fundingRate:          parseFloat(t.lastFundingRate) * 100,
          fundingIntervalHours: 8,
          nextFundingTime:      parseInt(t.nextFundingTime ?? '0'),
        };
      }
      return r;
    }).catch(() => ({})),

    // Bybit — single bulk call for all linear perps, filter by PERP_COINS
    rlGetJson('https://api.bybit.com/v5/market/tickers?category=linear').then(data => {
      const list = data?.result?.list;
      if (!Array.isArray(list)) return {};
      const r = {};
      for (const t of list) {
        if (!t.symbol.endsWith('USDT')) continue;
        const coin = t.symbol.slice(0, -4);
        if (!PERP_COINS.has(coin)) continue;
        r[coin] = {
          markPrice:            parseFloat(t.markPrice  ?? t.lastPrice ?? '0'),
          fundingRate:          parseFloat(t.fundingRate ?? '0') * 100,
          fundingIntervalHours: 8,
          openInterestUsd:      parseFloat(t.openInterestValue ?? '0') || null,
          vol24hUsd:            parseFloat(t.turnover24h        ?? '0') || null,
        };
      }
      return r;
    }).catch(() => ({})),

    // OKX USDT SWAP — parallel requests for PERP_COINS
    (async () => {
      const coins = [...PERP_COINS];
      const pairs = await Promise.all(
        coins.map(c =>
          rlGetJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${c}-USDT-SWAP`)
            .then(d => [c, d?.data?.[0]])
            .catch(() => [c, null])
        )
      );
      const r = {};
      for (const [coin, t] of pairs) {
        if (!t) continue;
        r[coin] = {
          fundingRate:          parseFloat(t.fundingRate ?? '0') * 100,
          fundingIntervalHours: 8,
        };
      }
      return r;
    })(),

    fetchHyperliquid(),
  ]);

  // Secondary parallel: Binance vol, dYdX, Gate.io perps, Bitget perps, Aster, Paradex, edgeX, Grvt, Lighter, Extended, Pacifica
  const [dydxF, binVol, gateF, bitF, asterF, paradexF, edgexF, grvtF, lighterF, extendedF, pacificaF] = await Promise.all([
    fetchDydx(),
    fetchBinancePerpVol(),
    fetchGateIOPerps(),
    fetchBitget(),
    fetchAster(),
    fetchParadex(),
    fetchEdgex(),
    fetchGrvt(),
    fetchLighter(),
    fetchExtended(),
    fetchPacifica(),
  ]);

  // Merge Binance vol into rate data
  for (const [coin, vol] of Object.entries(binVol)) {
    if (binF[coin]) binF[coin].vol24hUsd = vol;
  }

  const out = { binance: binF, bybit: bybitF, okx: okxF };
  if (Object.keys(hlF).length   > 0) out.hyperliquid = hlF;
  if (Object.keys(dydxF).length > 0) out.dydx        = dydxF;
  if (Object.keys(gateF).length > 0) out.gateio       = gateF;
  if (Object.keys(bitF).length  > 0) out.bitget       = bitF;
  if (Object.keys(asterF).length > 0) out.aster       = asterF;
  if (Object.keys(paradexF).length > 0) out.paradex   = paradexF;
  if (Object.keys(edgexF).length > 0) out.edgex       = edgexF;
  if (Object.keys(grvtF).length > 0) out.grvt         = grvtF;
  if (Object.keys(lighterF).length > 0) out.lighter   = lighterF;
  if (Object.keys(extendedF).length > 0) out.extended = extendedF;
  if (Object.keys(pacificaF).length > 0) out.pacifica = pacificaF;
  return out;
}

// ── Analysis ──────────────────────────────────────────────────────────────────

function detectCexArb(exchanges) {
  const arbs = [];
  for (const coin of COINS) {
    const entries = Object.entries(exchanges)
      .map(([ex, d]) => ({ exchange: ex, price: d[coin]?.price ?? 0 }))
      .filter(e => e.price > 0);
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

function detectBasis(spot, perps) {
  const trades = [];
  for (const coin of ['BTC','ETH','SOL','BNB','XRP']) {
    const spotPrice = spot[coin]?.price;
    const mark      = perps.binance?.[coin]?.markPrice;
    const fr        = perps.binance?.[coin]?.fundingRate ?? 0;
    if (!spotPrice || !mark || spotPrice <= 0) continue;
    const basisPct = ((mark - spotPrice) / spotPrice) * 100;
    if (Math.abs(basisPct) < BASIS_THRESHOLD) continue;
    const holdDays = 30;
    const cashCarryAnnual = basisPct * (365 / holdDays);
    const fundingAnnual   = annualize(fr, 8);
    const totalAnnual = basisPct > 0
      ? cashCarryAnnual + Math.max(0, fundingAnnual)
      : cashCarryAnnual - Math.max(0, fundingAnnual);
    trades.push({
      coin, spot: spotPrice, futures: mark,
      basisPct:        Math.round(basisPct * 1000) / 1000,
      direction:       basisPct > 0 ? 'contango' : 'backwardation',
      exchange:        'binance',
      fundingRate:     Math.round(fr * 10000) / 10000,
      annualizedReturn: Math.round(totalAnnual * 10) / 10,
      profitPerUnit:   Math.round(Math.abs(spotPrice * basisPct / 100) * 100) / 100,
    });
  }
  return trades;
}

function detectHighFunding(perps) {
  const flagged = [];
  for (const [exchName, data] of Object.entries(perps)) {
    for (const [coin, info] of Object.entries(data)) {
      const fr            = info.fundingRate ?? 0;
      const intervalHours = info.fundingIntervalHours ?? 8;
      if (Math.abs(fr) >= FUND_THRESHOLD) {
        flagged.push({
          coin, exchange: exchName,
          fundingRate:   Math.round(fr * 10000) / 10000,
          annualizedApy: Math.round(annualize(fr, intervalHours) * 10) / 10,
          fundingIntervalHours: intervalHours,
        });
      }
    }
  }
  return flagged.sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));
}

function updateInfoLag() {
  const now = Date.now();
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch {}
  const result = {};
  for (const coin of COINS) {
    const p = wsData[coin]?.price;
    if (!hist[coin]) hist[coin] = [];
    if (p > 0) hist[coin].push({ t: now, p });
    hist[coin] = hist[coin].filter(e => now - e.t <= 3_600_000).slice(-60);
    const w = hist[coin];
    result[coin] = w.length >= 2 && w[0].p > 0 && Math.abs((w[w.length-1].p - w[0].p) / w[0].p * 100) >= 3;
  }
  try { fs.writeFileSync(HIST_FILE, JSON.stringify(hist)); } catch {}
  return result;
}

// ── File writer ────────────────────────────────────────────────────────────────

function writeOutput() {
  const exchanges = { binance: wsData, ...restData };
  // Atomic write (temp + rename): concurrent readers (agent15, /api/crypto, …) never
  // catch a half-written file. Same content as before (pretty JSON) — I/O path only.
  try {
    atomicWriteJson(OUT, {
      fetchedAt: Date.now(),
      exchanges, cexArb, infoLag,
      futures, basisTrades, highFunding,
    }, { pretty: true });
  } catch {}

  const bPrices = {};
  for (const coin of COINS) {
    const sym = `${coin}USDT`, b = wsData[coin];
    if (!b) continue;
    bPrices[sym] = { symbol: sym, price: b.price, priceChange24h: 0, priceChangePercent24h: b.change24hPct ?? 0, high24h: b.high24h ?? 0, low24h: b.low24h ?? 0, volume: b.volume ?? 0, change1hPct: 0, infoLag: infoLag[coin] ?? false };
  }
  try { fs.writeFileSync(BINANCE_COMPAT, JSON.stringify({ fetchedAt: Date.now(), prices: bPrices }, null, 2)); } catch {}
}

// ── REST poll ──────────────────────────────────────────────────────────────────

async function poll() {
  console.log('[multi-cex] REST poll — 6 CEX + 4 perp venues (Binance/Bybit/OKX/HL/dYdX)...');
  await fetchBinanceREST();
  const [coinbase, okx, bybit, kraken, gateio] = await Promise.all([
    fetchCoinbase(), fetchOKX(), fetchBybit(), fetchKraken(), fetchGateIO(),
  ]);
  restData    = { coinbase, okx, bybit, kraken, gateio };
  futures     = await fetchFutures();

  const allExchanges = { binance: wsData, ...restData };
  cexArb      = detectCexArb(allExchanges);
  basisTrades = detectBasis(wsData, futures);
  highFunding = detectHighFunding(futures);
  infoLag     = updateInfoLag();

  checkFundingAlerts(futures.binance ?? {});

  writeOutput();
  lastWrite = Date.now();
  beat();

  const btc    = wsData.BTC?.price;
  const arbStr = cexArb.map(a => `${a.coin} ${a.spreadPct.toFixed(2)}%`).join(', ')      || 'none';
  const bfStr  = basisTrades.map(b => `${b.coin} ${b.basisPct.toFixed(2)}%`).join(', ')  || 'none';
  const binFR  = futures.binance?.BTC?.fundingRate?.toFixed(4) ?? '?';
  const dydxFR = futures.dydx?.BTC?.fundingRate?.toFixed(4)    ?? 'N/A';
  console.log(`[multi-cex] BTC $${btc?.toLocaleString()} | arb: ${arbStr} | basis: ${bfStr} | BTC Bin FR: ${binFR}% | dYdX FR: ${dydxFR}%`);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

connectWS();
poll();
setInterval(poll, POLL_INTERVAL);
