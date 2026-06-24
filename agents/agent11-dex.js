#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { httpGet: _sharedGet, httpPost: _httpPost } = require('../lib/httpGet');

const OUT      = '/tmp/dex-prices.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';
const INTERVAL = 300_000;  // 5 min — DEX data moves slowly

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent11-dex'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return _sharedGet(url, { timeoutMs: 12_000, headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' } })
    .then(r => r.data).catch(() => null);
}

function post(url, bodyObj) {
  return _httpPost(url, bodyObj, { timeoutMs: 12_000, headers: { 'User-Agent': 'prediction-arb-scanner/1.0' } })
    .then(r => r.data).catch(() => null);
}

// ── DEX fetchers ──────────────────────────────────

async function fetchJupiter() {
  // Jupiter (Solana DEX aggregator) — reliable public API
  const data = await get('https://price.jup.ag/v4/price?ids=BTC,ETH,SOL,BONK,BNB');
  if (!data?.data) return {};
  const r = {};
  for (const [sym, info] of Object.entries(data.data)) {
    if (info.price > 0) r[sym] = { price: info.price, vsToken: info.vsToken };
  }
  return r;
}

async function fetchDydx() {
  // dYdX v3 markets — oracle/index prices for perps
  const data = await get('https://api.dydx.exchange/v3/markets');
  if (!data?.markets) return {};
  const want = { 'BTC-USD':'BTC','ETH-USD':'ETH','SOL-USD':'SOL','BNB-USD':'BNB','XRP-USD':'XRP','DOGE-USD':'DOGE' };
  const r = {};
  for (const [id, m] of Object.entries(data.markets)) {
    const coin = want[id];
    if (!coin) continue;
    const price = parseFloat(m.oraclePrice ?? m.indexPrice ?? '0');
    if (price > 0) {
      r[coin] = {
        price,
        fundingRate: parseFloat(m.nextFundingRate ?? '0') * 100,
        openInterest: parseFloat(m.openInterest ?? '0'),
      };
    }
  }
  return r;
}

async function fetchUniswap() {
  // Uniswap V3 via The Graph hosted service (best-effort — may be rate-limited)
  const query = `{
    tokens(
      where: { id_in: [
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
      ]}
    ) {
      symbol
      tokenDayData(first: 1, orderBy: date, orderDirection: desc) {
        priceUSD
      }
    }
  }`;
  const data = await post('https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3', { query });
  if (!data?.data?.tokens) return {};
  const r = {};
  const coinMap = { WBTC:'BTC', WETH:'ETH' };
  for (const t of data.data.tokens) {
    const coin  = coinMap[t.symbol];
    const price = parseFloat(t.tokenDayData?.[0]?.priceUSD ?? '0');
    if (coin && price > 0) r[coin] = { price };
  }
  return r;
}

async function fetch1inch() {
  // 1inch price API — requires API key in prod, try without
  const tokens = [
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',  // WBTC
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',  // ETH native
  ].join(',');
  const data = await get(`https://api.1inch.dev/price/v1.1/1/${tokens}?currency=USD`);
  if (!data || typeof data !== 'object' || data.error) return {};
  const addrMap = {
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'BTC',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 'ETH',
  };
  const r = {};
  for (const [addr, price] of Object.entries(data)) {
    const coin = addrMap[addr.toLowerCase()];
    const p    = parseFloat(String(price));
    if (coin && p > 0) r[coin] = { price: p };
  }
  return r;
}

// ── CEX reference for spread computation ──────────

function loadCexBinance() {
  try {
    const d = JSON.parse(fs.readFileSync('/tmp/exchange-prices.json', 'utf8'));
    return d.exchanges?.binance ?? {};
  } catch { return {}; }
}

function computeDexCexSpread(dex, cex) {
  const spreads = [];
  for (const [source, prices] of Object.entries(dex)) {
    for (const [coin, info] of Object.entries(prices)) {
      const cexPrice = cex[coin]?.price;
      if (!cexPrice || !info.price || cexPrice <= 0) continue;
      const spreadPct = ((info.price - cexPrice) / cexPrice) * 100;
      spreads.push({
        coin, dex: source, dexPrice: info.price,
        cex: 'binance', cexPrice,
        spreadPct: Math.round(spreadPct * 1000) / 1000,
      });
    }
  }
  return spreads.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
}

// ── Main ──────────────────────────────────────────

async function tick() {
  console.log('[dex] fetching DEX prices (Jupiter, dYdX, Uniswap, 1inch)...');
  const [jupiter, dydx, uniswap, oneinch] = await Promise.all([
    fetchJupiter(), fetchDydx(), fetchUniswap(), fetch1inch(),
  ]);

  const dexPrices = { jupiter, dydx, uniswap, '1inch': oneinch };
  const cex = loadCexBinance();
  const dexCexSpread = computeDexCexSpread(dexPrices, cex);

  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: Date.now(), dex: dexPrices, dexCexSpread }, null, 2));

  const online = Object.entries(dexPrices).filter(([, d]) => Object.keys(d).length > 0).map(([s]) => s);
  const jBtc   = jupiter.BTC?.price;
  const dBtc   = dydx.BTC?.price;
  console.log(`[dex] done — online: ${online.join(', ')||'none'} | Jupiter BTC: $${jBtc?.toLocaleString()??'n/a'} | dYdX BTC: $${dBtc?.toLocaleString()??'n/a'}`);
  beat();
}

tick();
setInterval(tick, INTERVAL);
