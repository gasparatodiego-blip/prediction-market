#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const https = require('https');
const WebSocket = require('ws');

const OUT            = '/tmp/exchange-prices.json';
const HIST_FILE      = '/tmp/exchange-history.json';
const BINANCE_COMPAT = '/tmp/binance-prices.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
const ALERT_FILE     = '/tmp/funding-alert.json';
const POLL_INTERVAL  = 60_000;
const WRITE_THROTTLE = 2_000;  // min ms between WS-triggered writes
const COINS          = ['BTC','ETH','SOL','BNB','XRP','DOGE'];
const CEX_THRESHOLD  = 0.3;
const FUND_THRESHOLD = 0.05;  // % per 8h — "HIGH FUNDING" (= 54.75% APY)
const BASIS_THRESHOLD = 0.3;  // % spot vs futures spread — "CASH & CARRY"
const ALERT_THRESHOLD = 0.01; // % per 8h — Telegram alert trigger
const TG_TOKEN       = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT        = '8844610430';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

// ── In-memory state ───────────────────────────────
let wsData    = {};   // Binance WS prices (real-time)
let restData  = {};   // Other 5 CEX prices (60s REST)
let futures   = {};   // Perp funding rates + mark prices
let cexArb    = [];
let basisTrades = [];
let highFunding = [];
let infoLag   = {};
let lastWrite = 0;

// ── Utilities ─────────────────────────────────────

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
    req.on('timeout', function () { this.destroy(); resolve(null); });
  });
}

// ── Telegram alerts ───────────────────────────────

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const r = JSON.parse(data);
        if (!r.ok) console.error('[tg] send failed:', r.description);
        else console.log('[tg] alert sent OK');
      } catch {}
    });
  });
  req.on('error', err => console.error('[tg] request error:', err.message));
  req.write(body);
  req.end();
}

function checkFundingAlerts(binPerps) {
  // Throttle: one combined alert per 8h
  let alertState = { last_alert_time: 0 };
  try { alertState = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch {}
  const now = Date.now();
  if (now - (alertState.last_alert_time ?? 0) < EIGHT_HOURS_MS) return;

  const rows = [];
  let best = null;  // { coin, fr } with highest |fr| that exceeds threshold

  for (const coin of COINS) {
    const fr = binPerps[coin]?.fundingRate;
    if (typeof fr !== 'number' || isNaN(fr)) continue;

    const absFr  = Math.abs(fr);
    const frStr  = (fr >= 0 ? '+' : '') + fr.toFixed(4) + '%';
    const apy    = Math.round(fr * 3 * 365 * 10) / 10;  // % per year
    const apyAbs = Math.abs(apy);

    let label, emoji;
    if (absFr < ALERT_THRESHOLD) {
      label = 'flat'; emoji = '➖';
    } else if (fr > 0) {
      label = `${apyAbs.toFixed(0)}% APY`;
      emoji = absFr >= 0.05 ? '🔥' : '✅';
    } else {
      label = 'negative';
      emoji = absFr >= 0.05 ? '🔥' : '⚠️';
    }

    rows.push(`${coin}: ${frStr}/8h = ${label} ${emoji}`);

    if (absFr >= ALERT_THRESHOLD) {
      if (!best || absFr > Math.abs(best.fr)) best = { coin, fr };
    }
  }

  if (!best) return;  // nothing above threshold — skip alert

  const bestAbsFr  = Math.abs(best.fr);
  const bestFrStr  = (best.fr >= 0 ? '+' : '') + best.fr.toFixed(4) + '%';
  const bestMonthly = Math.round(5000 * (bestAbsFr / 100) * 3 * 30 * 100) / 100;

  const message =
    `🚀 FUNDING RATE ALERTS\n\n` +
    rows.join('\n') + '\n\n' +
    `Best opportunity: ${best.coin} ${bestFrStr}/8h\n` +
    `On $5,000: $${bestMonthly}/month estimated`;

  sendTelegram(message);

  alertState.last_alert_time = now;
  alertState.last_best       = best;
  try { fs.writeFileSync(ALERT_FILE, JSON.stringify(alertState, null, 2)); } catch {}
  console.log(`[tg] multi-coin funding alert sent — best: ${best.coin} ${bestFrStr}/8h`);
}

// ── Binance WebSocket ─────────────────────────────

const COIN_SYM = { BTC:'btcusdt', ETH:'ethusdt', SOL:'solusdt', BNB:'bnbusdt', XRP:'xrpusdt', DOGE:'dogeusdt' };
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
        price:        parseFloat(t.c),  // last price
        change24hPct: parseFloat(t.P),  // 24h change %
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

// ── CEX REST fetchers ─────────────────────────────

async function fetchBinanceREST() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
  const data = await get(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
  if (!Array.isArray(data)) return;
  const map = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE' };
  for (const t of data) {
    const coin = map[t.symbol];
    if (!coin) continue;
    // Only overwrite WS data if WS is stale (>30s old)
    if (!wsData[coin] || Date.now() - (wsData[coin].wsAt ?? 0) > 30_000) {
      wsData[coin] = { price: parseFloat(t.lastPrice), change24hPct: parseFloat(t.priceChangePercent), high24h: parseFloat(t.highPrice), low24h: parseFloat(t.lowPrice), volume: parseFloat(t.volume) };
    }
  }
}

async function fetchCoinbase() {
  const pairs = { BTC:'BTC-USD', ETH:'ETH-USD', SOL:'SOL-USD', XRP:'XRP-USD', DOGE:'DOGE-USD' };
  const r = {};
  await Promise.all(Object.entries(pairs).map(async ([coin, pair]) => {
    const d = await get(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const p = parseFloat(d?.data?.amount);
    if (p > 0) r[coin] = { price: p };
  }));
  return r;
}

async function fetchOKX() {
  const d = await get('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  if (!Array.isArray(d?.data)) return {};
  const want = { 'BTC-USDT':'BTC','ETH-USDT':'ETH','SOL-USDT':'SOL','BNB-USDT':'BNB','XRP-USDT':'XRP','DOGE-USDT':'DOGE' };
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
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
  const map  = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE' };
  const r = {};
  await Promise.all(syms.map(async sym => {
    const d = await get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`);
    const t = d?.result?.list?.[0];
    if (t) r[map[sym]] = { price: parseFloat(t.lastPrice), change24hPct: parseFloat(t.price24hPcnt) * 100, high24h: parseFloat(t.highPrice24h), low24h: parseFloat(t.lowPrice24h), volume: parseFloat(t.volume24h) };
  }));
  return r;
}

async function fetchKraken() {
  const d = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,SOLUSD,XRPUSD,XDGUSD');
  if (!d?.result) return {};
  const r = {};
  for (const [key, val] of Object.entries(d.result)) {
    const last = parseFloat(val.c?.[0] ?? '0'), open = parseFloat(val.o ?? '0');
    if (last <= 0) continue;
    const entry = { price: last, change24hPct: open > 0 ? ((last - open) / open) * 100 : 0, high24h: parseFloat(val.h?.[1]??'0'), low24h: parseFloat(val.l?.[1]??'0'), volume: parseFloat(val.v?.[1]??'0') };
    const k = key.toUpperCase();
    if (k.includes('XBT'))                         r.BTC  = entry;
    else if (k.includes('ETH'))                    r.ETH  = entry;
    else if (k.includes('SOL'))                    r.SOL  = entry;
    else if (k.includes('XRP'))                    r.XRP  = entry;
    else if (k.includes('XDG') || k.includes('DOGE')) r.DOGE = entry;
  }
  return r;
}

async function fetchGateIO() {
  const d = await get('https://api.gateio.ws/api/v4/spot/tickers');
  if (!Array.isArray(d)) return {};
  const want = { 'BTC_USDT':'BTC','ETH_USDT':'ETH','SOL_USDT':'SOL','BNB_USDT':'BNB','XRP_USDT':'XRP','DOGE_USDT':'DOGE' };
  const r = {};
  for (const t of d) {
    const coin = want[t.currency_pair];
    if (!coin) continue;
    r[coin] = { price: parseFloat(t.last), change24hPct: parseFloat(t.change_percentage??'0'), high24h: parseFloat(t.high_24h??'0'), low24h: parseFloat(t.low_24h??'0'), volume: parseFloat(t.base_volume??'0') };
  }
  return r;
}

// ── Perpetual futures + funding rates ─────────────

async function fetchFutures() {
  const [binF, bybitF, okxF] = await Promise.all([

    // Binance FAPI — premiumIndex has markPrice + fundingRate
    get('https://fapi.binance.com/fapi/v1/premiumIndex').then(data => {
      if (!Array.isArray(data)) return {};
      const map = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL', BNBUSDT:'BNB', XRPUSDT:'XRP', DOGEUSDT:'DOGE' };
      const r = {};
      for (const t of data) {
        const coin = map[t.symbol];
        if (!coin) continue;
        r[coin] = {
          markPrice:   parseFloat(t.markPrice),
          fundingRate: parseFloat(t.lastFundingRate) * 100,  // convert to %
          nextFundingTime: parseInt(t.nextFundingTime ?? '0'),
        };
      }
      return r;
    }).catch(() => ({})),

    // Bybit linear futures
    Promise.all(['BTCUSDT','ETHUSDT','SOLUSDT'].map(sym =>
      get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`)
        .then(d => [sym, d?.result?.list?.[0]]).catch(() => [sym, null])
    )).then(pairs => {
      const map = { BTCUSDT:'BTC', ETHUSDT:'ETH', SOLUSDT:'SOL' };
      const r = {};
      for (const [sym, t] of pairs) {
        if (!t) continue;
        r[map[sym]] = {
          markPrice:   parseFloat(t.markPrice ?? t.lastPrice ?? '0'),
          fundingRate: parseFloat(t.fundingRate ?? '0') * 100,
        };
      }
      return r;
    }),

    // OKX funding rates
    Promise.all(['BTC-USD-SWAP','ETH-USD-SWAP','SOL-USD-SWAP'].map(instId =>
      get(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`)
        .then(d => [instId, d?.data?.[0]]).catch(() => [instId, null])
    )).then(pairs => {
      const map = { 'BTC-USD-SWAP':'BTC','ETH-USD-SWAP':'ETH','SOL-USD-SWAP':'SOL' };
      const r = {};
      for (const [instId, t] of pairs) {
        if (!t) continue;
        r[map[instId]] = { fundingRate: parseFloat(t.fundingRate ?? '0') * 100 };
      }
      return r;
    }),
  ]);

  return { binance: binF, bybit: bybitF, okx: okxF };
}

// ── Analysis ──────────────────────────────────────

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
    const fr        = perps.binance?.[coin]?.fundingRate ?? 0;  // % per 8h
    if (!spotPrice || !mark || spotPrice <= 0) continue;
    const basisPct = ((mark - spotPrice) / spotPrice) * 100;
    if (Math.abs(basisPct) < BASIS_THRESHOLD) continue;

    // 30-day hold annualized + funding bonus
    const holdDays = 30;
    const cashCarryAnnual = basisPct * (365 / holdDays);
    const fundingAnnual   = fr * 3 * 365;  // 3 intervals/day × 365
    // Contango: short perp → collect positive funding too
    // Backwardation: long perp → positive funding is a cost
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
      const fr = info.fundingRate ?? 0;
      if (Math.abs(fr) >= FUND_THRESHOLD) {
        const annualizedApy = Math.round(fr * 3 * 365 * 10) / 10;
        flagged.push({
          coin, exchange: exchName,
          fundingRate:  Math.round(fr * 10000) / 10000,
          annualizedApy,
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

// ── File writer ───────────────────────────────────

function writeOutput() {
  const exchanges = { binance: wsData, ...restData };
  try {
    fs.writeFileSync(OUT, JSON.stringify({
      fetchedAt: Date.now(),
      exchanges, cexArb, infoLag,
      futures, basisTrades, highFunding,
    }, null, 2));
  } catch {}

  // Backwards-compat for /api/crypto legacy reader
  const bPrices = {};
  for (const coin of COINS) {
    const sym = `${coin}USDT`, b = wsData[coin];
    if (!b) continue;
    bPrices[sym] = { symbol: sym, price: b.price, priceChange24h: 0, priceChangePercent24h: b.change24hPct ?? 0, high24h: b.high24h ?? 0, low24h: b.low24h ?? 0, volume: b.volume ?? 0, change1hPct: 0, infoLag: infoLag[coin] ?? false };
  }
  try { fs.writeFileSync(BINANCE_COMPAT, JSON.stringify({ fetchedAt: Date.now(), prices: bPrices }, null, 2)); } catch {}
}

// ── REST poll ─────────────────────────────────────

async function poll() {
  console.log('[multi-cex] REST poll — 6 CEX + 3 perp exchanges...');
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

  const btc = wsData.BTC?.price;
  const arbStr  = cexArb.map(a => `${a.coin} ${a.spreadPct.toFixed(2)}%`).join(', ')  || 'none';
  const bfStr   = basisTrades.map(b => `${b.coin} ${b.basisPct.toFixed(2)}%`).join(', ') || 'none';
  const binFR   = futures.binance?.BTC?.fundingRate?.toFixed(4) ?? '?';
  console.log(`[multi-cex] BTC $${btc?.toLocaleString()} | arb: ${arbStr} | basis: ${bfStr} | BTC funding: ${binFR}%`);
}

// ── Bootstrap ─────────────────────────────────────

connectWS();
poll();
setInterval(poll, POLL_INTERVAL);
