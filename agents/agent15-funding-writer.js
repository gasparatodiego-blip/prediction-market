#!/usr/bin/env node
'use strict';

/**
 * agent15-funding-writer
 *
 * Every 60 s:
 *   1. Read /tmp/exchange-prices.json (written by agent10)
 *   2. Refresh settled funding-rate history (every 15 min) from venue APIs
 *   3. Compute cross-exchange FUNDING SPREAD arb — headline from TRAILING SETTLED
 *      rates, never from a single predicted spike
 *      — spike flag: |predicted − median| > 3× median (per leg)
 *      — confirmed flag: ≥2 of last 3 settlements in same direction as trailing avg
 *      — predictedGrossApy stored separately for transparency
 *   4. Merge into /tmp/unified-opportunities.json atomically
 *      — PRESERVES type=CASHABLE/SIGNAL/SPORTS, REPLACES type=FUNDING
 *
 * All 7 venues (Binance, Bybit, OKX, Bitget, Gate.io, Hyperliquid, dYdX) now have
 * settled funding-history fetchers (HISTORY_FETCHERS). A leg only falls back to
 * trailingRate = predictedRate (oneLegUnverified = true → verdict = 'PARTIAL —
 * 1 leg unverified' → fullyConfirmed = false) when its history fetch actually
 * comes back empty (API error/outage) — never as a hardcoded per-venue skip.
 *
 * Zero Claude calls. No trades. Read-only + math only.
 */

const fs = require('fs');
const { httpGet, httpPost } = require('../lib/httpGet');
const { rlGet, rlPost } = require('../lib/rateLimitedFetch');
const {
  annualize,
  venueFeePct,
  roundTripFeeByVenue,
  netApy30d,
  breakevenDays,
  spreadStatus,
} = require('../lib/funding-math');

const EXCHANGE_FILE      = '/tmp/exchange-prices.json';
const UNIFIED_FILE       = '/tmp/unified-opportunities.json';
const HISTORY_CACHE_FILE = '/tmp/funding-history-cache.json';
const HB_FILE            = '/tmp/agent-heartbeats.json';
const INTERVAL_MS        = 60_000;

// Spread filter
const THRESHOLD_APY      = 3.0;           // min trailing gross %/yr to emit
const MAX_GROSS_APY      = 200;           // sanity cap on trailing
const MIN_LIQ_USD        = 500_000;
const MAX_DATA_AGE       = 5 * 60_000;

// Anti-spike / persistence
const HISTORY_N          = 8;            // settled periods to average
const HISTORY_REFRESH_MS = 15 * 60_000;  // refresh history cache every 15 min
const SPIKE_MULT         = 3;            // |pred − median| > SPIKE_MULT × |median| → spike
const SPIKE_ABS_FLOOR    = 0.01;         // %/interval — min deviation to flag (avoids near-zero noise)
const SPIKE_ABS_MIN_RATE = 0.02;         // %/interval — min predicted rate magnitude to flag
const CONFIRM_LOOK       = 3;            // last N settlements to check direction
const CONFIRM_MIN        = 2;            // need ≥ this many same-direction as trailing
const HOURLY_SPIKE_ANN   = 115;          // %/yr — extreme threshold for hourly venues (no history)

// Slip-curve sizing
const SIZE_LADDER         = [500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000];
const SLIPPAGE_AMORT_DAYS = 14;          // amortize round-trip entry+exit cost over 14 days
const MULT_REFRESH_MS     = 15 * 60_000; // contract multiplier cache refresh cadence

let historyCache     = null;
let historyFetchedAt = 0;
let multCache        = { okx: {}, gateio: {}, bitget: {} };
let multFetchedAt    = 0;
let edgexIdCache     = {};   // coin → edgeX numeric contractId (endpoints don't accept coin/name)
let edgexIdFetchedAt = 0;
let lighterIdCache   = {};   // coin → Lighter numeric market_id (endpoints reject coin/name)
let lighterIdFetchedAt = 0;
let lastGoodExchangeData = null;    // last successfully-parsed exchange-prices snapshot (safe-read fallback)
let backfillAttempted = new Set();  // venues we've already force-backfilled once (self-heal latch)
let isRunning        = false;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url) {
  return httpGet(url, {
    timeoutMs: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
  }).then(r => r.data).catch(() => null);
}

function post(url, body) {
  return httpPost(url, body, {
    timeoutMs: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
  }).then(r => r.data).catch(() => null);
}

// Rate-limited variants for edgeX/Grvt per-symbol loops (metadata, depth, history) so
// this process — like agent10 — never fans out a burst at those hosts and backs off on
// 429/challenge. Same null-on-failure contract; a backed-off host is simply absent.
const RL = { concurrency: 2, spacingMs: 120, timeoutMs: 12_000,
  headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' } };
function rlGetJson(url) {
  return rlGet(url, RL).then(r => r.data).catch(() => null);
}
function rlPostJson(url, body) {
  return rlPost(url, body, RL).then(r => r.data).catch(() => null);
}

// ── Contract multiplier cache ─────────────────────────────────────────────────
// OKX books report qty in contracts (ctVal coins each).
// Gate.io books report qty in contracts (quanto_multiplier coins each).
// Bitget books report qty in contracts (sizeMultiplier coins each).
// Binance/Bybit report qty directly in base-currency units — no multiplier needed.

async function refreshMultiplierCache() {
  console.log('[funding-depth] refreshing contract multiplier caches…');
  const [okxInst, gateContracts, bitgetContracts] = await Promise.all([
    rlGetJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP'),
    rlGetJson('https://api.gateio.ws/api/v4/futures/usdt/contracts'),
    rlGetJson('https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures'),
  ]);

  const fresh = { okx: {}, gateio: {}, bitget: {} };
  for (const inst of okxInst?.data ?? []) {
    const m = inst.instId?.match(/^([A-Z0-9]+)-USDT-SWAP$/);
    if (m && isFinite(parseFloat(inst.ctVal))) fresh.okx[m[1]] = parseFloat(inst.ctVal);
  }
  for (const c of gateContracts ?? []) {
    const m = c.name?.match(/^([A-Z0-9]+)_USDT$/);
    if (m && isFinite(parseFloat(c.quanto_multiplier))) fresh.gateio[m[1]] = parseFloat(c.quanto_multiplier);
  }
  for (const c of bitgetContracts?.data ?? []) {
    const m = c.symbol?.match(/^([A-Z0-9]+)USDT$/);
    if (m && isFinite(parseFloat(c.sizeMultiplier))) fresh.bitget[m[1]] = parseFloat(c.sizeMultiplier);
  }

  // Merge: new entries overwrite; failed fetches keep stale values
  Object.assign(multCache.okx,    fresh.okx);
  Object.assign(multCache.gateio, fresh.gateio);
  Object.assign(multCache.bitget, fresh.bitget);
  multFetchedAt = Date.now();
  const total = Object.keys(multCache.okx).length + Object.keys(multCache.gateio).length + Object.keys(multCache.bitget).length;
  console.log(`[funding-depth] multipliers ready: ${total} coin-exchange pairs`);
}

// ── edgeX contractId cache ────────────────────────────────────────────────────
// edgeX depth + funding-history endpoints key on the numeric contractId, NOT the
// coin/name (contractName/comma/repeat params all return []). So resolve coin →
// contractId from getMetaData and cache it, refreshed on the same cadence as the
// multiplier cache. Must be populated BEFORE the first history/depth fetch.

async function refreshEdgexIdCache() {
  const meta = await rlGetJson('https://pro.edgex.exchange/api/v1/public/meta/getMetaData');
  const contracts = meta?.data?.contractList;
  if (!Array.isArray(contracts)) return;
  const fresh = {};
  for (const c of contracts) {
    const name = c.contractName ?? '';
    if (!name.endsWith('USD') || c.enableTrade === false) continue;
    if (c.contractId) fresh[name.slice(0, -3)] = c.contractId;
  }
  if (Object.keys(fresh).length) {
    Object.assign(edgexIdCache, fresh);   // failed fetch keeps stale ids
    edgexIdFetchedAt = Date.now();
    console.log(`[funding-depth] edgeX contractIds ready: ${Object.keys(edgexIdCache).length} coins`);
  }
}

// Lighter depth + funding-history endpoints key on the numeric market_id, NOT the
// coin/symbol. Resolve coin → market_id from /orderBooks (symbol IS the coin) and
// cache it, refreshed before the first history/depth fetch — same pattern as edgeX.
async function refreshLighterIdCache() {
  const ob = await rlGetJson('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
  const books = ob?.order_books;
  if (!Array.isArray(books)) return;
  const fresh = {};
  for (const m of books) {
    if (m.market_type !== 'perp' || m.status !== 'active') continue;
    if (m.symbol != null && Number.isFinite(m.market_id)) fresh[m.symbol] = m.market_id;
  }
  if (Object.keys(fresh).length) {
    Object.assign(lighterIdCache, fresh);   // failed fetch keeps stale ids
    lighterIdFetchedAt = Date.now();
    console.log(`[funding-depth] Lighter market_ids ready: ${Object.keys(lighterIdCache).length} coins`);
  }
}

// ── Per-exchange depth fetchers ───────────────────────────────────────────────
// Each returns { bids: [price, qty][], asks: [price, qty][], mid } (raw levels, coins).
// bids sorted descending (best bid first), asks ascending (best ask first).
// Returns null on fetch failure.

async function depthBinance(coin) {
  const d = await rlGetJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${coin}USDT&limit=100`);
  if (!Array.isArray(d?.bids) || !d.bids.length || !Array.isArray(d?.asks) || !d.asks.length) return null;
  const bids = d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks = d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthBybit(coin) {
  const d = await rlGetJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${coin}USDT&limit=200`);
  const bRaw = d?.result?.b, aRaw = d?.result?.a;
  if (!Array.isArray(bRaw) || !bRaw.length || !Array.isArray(aRaw) || !aRaw.length) return null;
  const bids = bRaw.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks = aRaw.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthOkx(coin) {
  const d    = await rlGetJson(`https://www.okx.com/api/v5/market/books?instId=${coin}-USDT-SWAP&sz=100`);
  const book = d?.data?.[0];
  if (!Array.isArray(book?.bids) || !book.bids.length || !Array.isArray(book?.asks) || !book.asks.length) return null;
  const mult = multCache.okx[coin] ?? 1;
  const bids = book.bids.map(([p, q]) => [parseFloat(p), parseFloat(q) * mult]);
  const asks = book.asks.map(([p, q]) => [parseFloat(p), parseFloat(q) * mult]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthBitget(coin) {
  const d    = await rlGetJson(`https://api.bitget.com/api/v2/mix/market/orderbook?symbol=${coin}USDT&productType=usdt-futures&limit=100`);
  const bRaw = d?.data?.bids, aRaw = d?.data?.asks;
  if (!Array.isArray(bRaw) || !bRaw.length || !Array.isArray(aRaw) || !aRaw.length) return null;
  const mult = multCache.bitget[coin] ?? 1;
  const bids = bRaw.map(([p, q]) => [parseFloat(p), parseFloat(q) * mult]);
  const asks = aRaw.map(([p, q]) => [parseFloat(p), parseFloat(q) * mult]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthGateio(coin) {
  const d = await rlGetJson(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${coin}_USDT&limit=100`);
  if (!Array.isArray(d?.bids) || !d.bids.length || !Array.isArray(d?.asks) || !d.asks.length) return null;
  const mult = multCache.gateio[coin] ?? 1;
  const bids = d.bids.map(e => [parseFloat(e.p), Math.abs(parseFloat(e.s)) * mult]);
  const asks = d.asks.map(e => [parseFloat(e.p), Math.abs(parseFloat(e.s)) * mult]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

// Hyperliquid & dYdX are perps DEXes that report order-book size directly in
// BASE units (coins) — exactly like Binance/Bybit, and UNLIKE OKX/Gate/Bitget
// which report contracts and need a multiplier. So NO contract multiplier is
// applied here: parseFloat(sz)/parseFloat(size) is already coin qty, and
// vwapWalk's `price * qty` yields USD notional. Treating size as USD, or
// applying a phantom multiplier, would mis-scale capacity by orders of
// magnitude — verified against depthBinance, which likewise passes the raw
// base-unit qty straight through with no multiplier.

async function depthHyperliquid(coin) {
  // POST l2Book → { levels: [ bids[], asks[] ] }, each level = { px, sz, n }.
  const d = await post('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin });
  const levels = d?.levels;
  if (!Array.isArray(levels) || levels.length < 2) return null;
  const bids = (levels[0] || [])
    .map(l => [parseFloat(l.px), parseFloat(l.sz)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = (levels[1] || [])
    .map(l => [parseFloat(l.px), parseFloat(l.sz)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthDydx(coin) {
  // GET v4 orderbook → { bids: [{price,size}], asks: [{price,size}] }; ticker "<SYM>-USD".
  const d = await get(`https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${coin}-USD`);
  const bidsRaw = d?.bids, asksRaw = d?.asks;
  if (!Array.isArray(bidsRaw) || !bidsRaw.length || !Array.isArray(asksRaw) || !asksRaw.length) return null;
  const bids = bidsRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = asksRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthAster(coin) {
  // Aster is a perp DEX with a Binance-identical L2 book: size is already in BASE
  // units (coins), so no contract multiplier — parseFloat(qty) straight through,
  // same as depthBinance. USDT is treated as USD.
  const d = await get(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${coin}USDT&limit=100`);
  if (!Array.isArray(d?.bids) || !d.bids.length || !Array.isArray(d?.asks) || !d.asks.length) return null;
  const bids = d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks = d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthGrvt(coin) {
  // Grvt CLOB L2 book via POST /book → result.{bids,asks} = [{ price, size, num_orders }],
  // size already in BASE units (coins) — same [{price,size}] object shape as dYdX, no
  // contract multiplier. bids desc / asks asc (sorted defensively). Quote USDT = USD.
  // Keys on the instrument name (derivable) — no id map.
  const d    = await rlPostJson('https://market-data.grvt.io/full/v1/book', { instrument: `${coin}_USDT_Perp`, depth: 100 });
  const book = d?.result;
  const bRaw = book?.bids, aRaw = book?.asks;
  if (!Array.isArray(bRaw) || !bRaw.length || !Array.isArray(aRaw) || !aRaw.length) return null;
  const bids = bRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = aRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthLighter(coin) {
  // Lighter CLOB L2 via GET /orderBookOrders → { asks, bids } as arrays of INDIVIDUAL
  // orders { price, remaining_base_amount }. remaining_base_amount is BASE units (coins),
  // no multiplier. Orders (not aggregated levels) are fine for vwapWalk — it sums
  // price*qty per entry. bids desc / asks asc (sorted defensively). Quote USDC = USD.
  // Keys on the numeric market_id (endpoints reject coin/name) — resolved via lighterIdCache.
  const marketId = lighterIdCache[coin];
  if (marketId == null) return null;
  const d    = await rlGetJson(`https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=${marketId}&limit=100`);
  const aRaw = d?.asks, bRaw = d?.bids;
  if (!Array.isArray(bRaw) || !bRaw.length || !Array.isArray(aRaw) || !aRaw.length) return null;
  const bids = bRaw
    .map(o => [parseFloat(o.price), parseFloat(o.remaining_base_amount)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = aRaw
    .map(o => [parseFloat(o.price), parseFloat(o.remaining_base_amount)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthExtended(coin) {
  // Extended CLOB L2 via GET /info/markets/<name>/orderbook → data.{bid,ask} = [{ qty, price }],
  // qty in BASE units (coins), no multiplier. bid desc / ask asc (sorted defensively).
  // Quote USD. Keys on the market NAME (derivable) — no id map.
  const d    = await rlGetJson(`https://api.starknet.extended.exchange/api/v1/info/markets/${coin}-USD/orderbook`);
  const book = d?.data;
  const bRaw = book?.bid, aRaw = book?.ask;
  if (!Array.isArray(bRaw) || !bRaw.length || !Array.isArray(aRaw) || !aRaw.length) return null;
  const bids = bRaw
    .map(o => [parseFloat(o.price), parseFloat(o.qty)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = aRaw
    .map(o => [parseFloat(o.price), parseFloat(o.qty)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthEdgex(coin) {
  // edgeX StarkEx CLOB L2 book: data[0].{asks,bids} = [{ price, size }], size already
  // in BASE units (coins) — same as Binance/Aster/Paradex, no contract multiplier.
  // asks ascending / bids descending (sorted defensively). Quote is USD. Needs the
  // numeric contractId (endpoints reject coin/name) — resolved via edgexIdCache.
  const contractId = edgexIdCache[coin];
  if (!contractId) return null;
  const d    = await rlGetJson(`https://pro.edgex.exchange/api/v1/public/quote/getDepth?contractId=${contractId}&level=200`);
  const book = Array.isArray(d?.data) ? d.data[0] : null;
  const aRaw = book?.asks, bRaw = book?.bids;
  if (!Array.isArray(aRaw) || !aRaw.length || !Array.isArray(bRaw) || !bRaw.length) return null;
  const bids = bRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  const asks = aRaw
    .map(l => [parseFloat(l.price), parseFloat(l.size)])
    .filter(([p, q]) => isFinite(p) && p > 0 && isFinite(q) && q > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

async function depthParadex(coin) {
  // Paradex StarkNet CLOB L2 book: { bids: [[price, size]], asks: [[price, size]] }
  // — size is already in BASE units (coins), same as Binance/Aster, so no contract
  // multiplier. bids descending / asks ascending per the API. Quote is USDC = USD,
  // so price * size is USD notional straight through.
  const d = await get(`https://api.prod.paradex.trade/v1/orderbook/${coin}-USD-PERP?depth=100`);
  if (!Array.isArray(d?.bids) || !d.bids.length || !Array.isArray(d?.asks) || !d.asks.length) return null;
  const bids = d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks = d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  return { bids, asks, mid: (bids[0][0] + asks[0][0]) / 2 };
}

const DEPTH_FETCHERS = {
  binance:     depthBinance,
  bybit:       depthBybit,
  okx:         depthOkx,
  bitget:      depthBitget,
  gateio:      depthGateio,
  hyperliquid: depthHyperliquid,
  dydx:        depthDydx,
  aster:       depthAster,
  paradex:     depthParadex,
  edgex:       depthEdgex,
  grvt:        depthGrvt,
  lighter:     depthLighter,
  extended:    depthExtended,
};

// Walk `levels` [[price, qty_coins], ...] to fill `targetUsd` of notional.
// Returns { fillable, vwap } — vwap is null if nothing filled.
function vwapWalk(levels, targetUsd) {
  let remaining  = targetUsd;
  let totalPaid  = 0;
  let totalCoins = 0;

  for (const [price, qty] of levels) {
    if (remaining <= 0) break;
    const levelUsd = price * qty;
    if (levelUsd <= remaining) {
      totalPaid  += levelUsd;
      totalCoins += qty;
      remaining  -= levelUsd;
    } else {
      totalPaid  += remaining;
      totalCoins += remaining / price;
      remaining   = 0;
    }
  }

  return { fillable: remaining <= 0, vwap: totalCoins > 0 ? totalPaid / totalCoins : null };
}

// Compute slip curve for a pair. Each SIZE_LADDER point models:
//   entry: sell N into shortBook.bids + buy N from longBook.asks
//   exit:  buy N from shortBook.asks + sell N into longBook.bids   (N = size/2)
// Returns an array of curve points. If either book is null → all RED sentinels.
function computeSlipCurve(shortBook, longBook, grossApy) {
  if (!shortBook || !longBook) {
    return SIZE_LADDER.map(size => ({
      size,
      fillable:      false,
      slipBps:       null,
      slipUsd:       null,
      grossDayUsd:   +(grossApy / 100 * size / 365).toFixed(4),
      netDayUsd:     null,
      slipOverGross: null,
      state:         'RED',
    }));
  }

  return SIZE_LADDER.map(size => {
    const N          = size / 2;
    const sBid       = vwapWalk(shortBook.bids, N);
    const lAsk       = vwapWalk(longBook.asks,  N);
    const sAsk       = vwapWalk(shortBook.asks, N);
    const lBid       = vwapWalk(longBook.bids,  N);
    const fillable   = sBid.fillable && lAsk.fillable && sAsk.fillable && lBid.fillable;
    const grossDayUsd = +(grossApy / 100 * size / 365).toFixed(4);

    if (!fillable) {
      return { size, fillable: false, slipBps: null, slipUsd: null, grossDayUsd, netDayUsd: null, slipOverGross: null, state: 'RED' };
    }

    // Dollar slippage = VWAP deviation from mid × notional (always ≥ 0)
    const eSlipS = Math.max(0, (shortBook.mid - sBid.vwap) / shortBook.mid * N);
    const eSlipL = Math.max(0, (lAsk.vwap - longBook.mid)  / longBook.mid  * N);
    const xSlipS = Math.max(0, (sAsk.vwap - shortBook.mid) / shortBook.mid * N);
    const xSlipL = Math.max(0, (longBook.mid - lBid.vwap)  / longBook.mid  * N);
    const slipUsd = eSlipS + eSlipL + xSlipS + xSlipL;

    const slipBps      = +(slipUsd / size * 10_000).toFixed(2);
    const netDayUsd    = +(grossDayUsd - slipUsd / SLIPPAGE_AMORT_DAYS).toFixed(4);
    const slipOverGross = grossDayUsd > 0
      ? +(slipUsd / (grossDayUsd * SLIPPAGE_AMORT_DAYS) * 100).toFixed(1)
      : Infinity;

    const state = slipOverGross <= 30  ? 'GREEN'
                : slipOverGross <= 100 ? 'YELLOW'
                :                        'RED';

    return { size, fillable: true, slipBps, slipUsd: +slipUsd.toFixed(4), grossDayUsd, netDayUsd, slipOverGross, state };
  });
}

// Enrich confirmed opps in place: compute slipCurve[], greenCapacityUsd,
// slipCurveMaxFillable. capacityUsd = greenCapacityUsd (honest green-only capacity).
async function enrichWithDepth(opps) {
  const pairs = new Set();
  for (const opp of opps) {
    const parts   = opp.id.split('-');
    const coin    = parts[1];
    const shortEx = parts[2];
    const longEx  = parts[3];
    if (DEPTH_FETCHERS[shortEx]) pairs.add(`${coin}|${shortEx}`);
    if (DEPTH_FETCHERS[longEx])  pairs.add(`${coin}|${longEx}`);
  }

  const bookMap = {};
  await Promise.all([...pairs].map(async key => {
    const [coin, exchange] = key.split('|');
    bookMap[key] = await DEPTH_FETCHERS[exchange](coin);
  }));

  const ok = Object.values(bookMap).filter(v => v !== null).length;
  console.log(`[funding-depth] fetched ${pairs.size} pairs → ${ok} ok, ${pairs.size - ok} failed`);

  for (const opp of opps) {
    const parts     = opp.id.split('-');
    const coin      = parts[1];
    const shortEx   = parts[2];
    const longEx    = parts[3];
    const shortBook = bookMap[`${coin}|${shortEx}`] ?? null;
    const longBook  = bookMap[`${coin}|${longEx}`]  ?? null;

    const grossApy  = opp.grossROI ?? opp.annualizedROI ?? 0;
    const slipCurve = computeSlipCurve(shortBook, longBook, grossApy);

    let slipCurveMaxFillable = null;
    let greenCapacityUsd     = 0;
    for (const pt of slipCurve) {
      if (pt.fillable) slipCurveMaxFillable = pt.size;
      if (pt.state === 'GREEN') greenCapacityUsd = pt.size;
    }

    opp.slipCurve            = slipCurve;
    opp.greenCapacityUsd     = greenCapacityUsd;
    opp.slipCurveMaxFillable = slipCurveMaxFillable;
    opp.capacityUsd          = greenCapacityUsd;
    opp.depthThin            = greenCapacityUsd === 0;
    opp.depthNote            = greenCapacityUsd === 0
      ? (shortBook && longBook
          ? 'THIN · slippage > 30% of yield at all sizes'
          : 'THIN · depth unavailable')
      : null;
  }
}

// ── Venue history fetchers ────────────────────────────────────────────────────
// Return array of settled funding rates in % (newest first), length ≤ n.
// All raw API values are fractions → ×100 for consistency with exchange-prices.json.

async function fetchBinanceHistory(coin, n) {
  // Binance returns oldest-first → sort by time descending
  const d = await rlGetJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}USDT&limit=${n}`);
  if (!Array.isArray(d)) return [];
  return d
    .sort((a, b) => (b.fundingTime ?? 0) - (a.fundingTime ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchBybitHistory(coin, n) {
  // Bybit returns newest-first
  const d = await rlGetJson(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${coin}USDT&limit=${n}`);
  const list = d?.result?.list;
  if (!Array.isArray(list)) return [];
  return list
    .sort((a, b) => Number(b.fundingRateTimestamp ?? 0) - Number(a.fundingRateTimestamp ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchOkxHistory(coin, n) {
  // OKX returns newest-first; use realizedRate (settled), not fundingRate (predicted at that time)
  const d = await rlGetJson(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${coin}-USDT-SWAP&limit=${n}`);
  if (!Array.isArray(d?.data)) return [];
  return d.data
    .sort((a, b) => Number(b.fundingTime ?? 0) - Number(a.fundingTime ?? 0))
    .map(e => parseFloat(e.realizedRate ?? e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchBitgetHistory(coin, n) {
  // Bitget returns newest-first
  const d = await rlGetJson(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${coin}USDT&productType=USDT-FUTURES&pageSize=${n}`);
  if (!Array.isArray(d?.data)) return [];
  return d.data
    .sort((a, b) => Number(b.fundingTime ?? 0) - Number(a.fundingTime ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchGateHistory(coin, n) {
  // Gate.io returns newest-first; sort by timestamp to be safe
  const d = await rlGetJson(`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${coin}_USDT&limit=${n}`);
  if (!Array.isArray(d)) return [];
  return d
    .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
    .map(e => parseFloat(e.r) * 100)
    .filter(v => isFinite(v));
}

async function fetchHyperliquidHistory(coin, n) {
  // HL's fundingHistory endpoint takes a startTime window, not a `limit` — funding
  // settles hourly, so (n + buffer) hours back comfortably covers n settlements
  // even with a couple of gaps. legAnalytics() only reads historyRates.slice(0, n),
  // so returning a few extra is harmless; we still cap explicitly for parity with
  // the other fetchers' `limit=n` behavior.
  const startTime = Date.now() - (n + 4) * 3_600_000;
  const d = await post('https://api.hyperliquid.xyz/info', {
    type: 'fundingHistory',
    coin,
    startTime,
  });
  if (!Array.isArray(d)) return [];
  // fundingRate is a raw fraction for HL's HOURLY settlement — same unit as the
  // predicted `ctx.funding` value agent10's fetchHyperliquid() stores (×100 → %/hr,
  // intervalHours=1). No 8h normalization: each venue's history stays in its own
  // native per-settlement unit, and annualize() scales it using that venue's own
  // intervalHours (1 for HL) — mirrors exactly how fetchOkxHistory's realizedRate
  // is annualized via OKX's own intervalHours.
  return d
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v))
    .slice(0, n);
}

async function fetchDydxHistory(coin, n) {
  // dYdX v4 indexer ticker format is "<ASSET>-USD" (mirrors agent10's fetchDydx(),
  // which derives the internal symbol via `name.replace('-USD', '')`).
  const d = await get(`https://indexer.dydx.trade/v4/historicalFunding/${coin}-USD?limit=${n}`);
  const list = d?.historicalFunding;
  if (!Array.isArray(list)) return [];
  // rate is a raw fraction for dYdX's HOURLY settlement — same unit as the
  // predicted `nextFundingRate` agent10's fetchDydx() stores (×100 → %/hr,
  // intervalHours=1). No 8h normalization needed — see fetchHyperliquidHistory
  // for why each venue's history stays in its own native per-settlement unit.
  return list
    .sort((a, b) => new Date(b.effectiveAt ?? 0).getTime() - new Date(a.effectiveAt ?? 0).getTime())
    .map(e => parseFloat(e.rate) * 100)
    .filter(v => isFinite(v))
    .slice(0, n);
}

async function fetchAsterHistory(coin, n) {
  // Aster is Binance-identical: /fapi/v1/fundingRate returns SETTLED rates
  // oldest-first → sort by fundingTime descending. Raw fraction → ×100 (%), kept
  // in the venue's own per-settlement unit (legAnalytics annualizes via the venue's
  // fundingIntervalHours), exactly like fetchBinanceHistory.
  const d = await get(`https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=${coin}USDT&limit=${n}`);
  if (!Array.isArray(d)) return [];
  return d
    .sort((a, b) => (b.fundingTime ?? 0) - (a.fundingTime ?? 0))
    .map(e => parseFloat(e.fundingRate) * 100)
    .filter(v => isFinite(v));
}

async function fetchGrvtHistory(coin, n) {
  // Grvt funding settles every 8h (funding_interval_hours=8). POST /funding returns
  // REAL settled per-period rates (funding_time in ns, 8h apart) — sorted newest-first
  // defensively. CRITICAL: funding_rate is ALREADY a PERCENT per 8h (calibrated vs
  // Binance), so NO ×100 here — unlike every other venue's fetcher. Kept in the venue's
  // own per-settlement unit (legAnalytics annualizes via fundingIntervalHours=8), like
  // fetchBinanceHistory otherwise.
  const d = await rlPostJson('https://market-data.grvt.io/full/v1/funding', { instrument: `${coin}_USDT_Perp`, limit: n });
  const rows = d?.result;
  if (!Array.isArray(rows)) return [];
  return rows
    .sort((a, b) => Number(b.funding_time ?? 0) - Number(a.funding_time ?? 0))
    .map(e => parseFloat(e.funding_rate))
    .filter(v => isFinite(v));
}

async function fetchLighterHistory(coin, n) {
  // Lighter settles funding HOURLY (top of each UTC hour). GET /fundings returns real
  // settled per-hour rates whose `rate` field is ALREADY a PERCENT per hour (native %/hr,
  // cross-validated: == /funding-rates' 8h-normalized value ×12.5). So NO conversion here
  // — kept in the venue's own per-settlement unit (legAnalytics annualizes via
  // fundingIntervalHours=1), exactly like fetchDydxHistory (also hourly). Needs numeric
  // market_id + a time window; (n+4)h back comfortably covers n hourly settlements.
  const marketId = lighterIdCache[coin];
  if (marketId == null) return [];
  const end   = Date.now();
  const start = end - (n + 4) * 3_600_000;
  const d = await rlGetJson(`https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=${marketId}&resolution=1h&start_timestamp=${start}&end_timestamp=${end}&count_back=${n}`);
  const rows = d?.fundings;
  if (!Array.isArray(rows)) return [];
  return rows
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .map(e => parseFloat(e.rate))
    .filter(v => isFinite(v))
    .slice(0, n);
}

async function fetchExtendedHistory(coin, n) {
  // Extended settles funding HOURLY. GET /info/<name>/funding returns the real settled
  // 1-hour rates ({ f, T }), whose `f` is the SAME raw FRACTION per hour as marketStats
  // .fundingRate (cross-validated: current == history[0]). ×100 → %/hr, kept in the
  // venue's own per-settlement unit (legAnalytics annualizes via fundingIntervalHours=1),
  // exactly like fetchDydxHistory (also hourly). Name-derivable — no id map; (n+4)h window
  // comfortably covers n hourly settlements.
  const end   = Date.now();
  const start = end - (n + 4) * 3_600_000;
  const d = await rlGetJson(`https://api.starknet.extended.exchange/api/v1/info/${coin}-USD/funding?startTime=${start}&endTime=${end}&limit=${n}`);
  const rows = d?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .sort((a, b) => (b.T ?? 0) - (a.T ?? 0))
    .map(e => parseFloat(e.f) * 100)
    .filter(v => isFinite(v))
    .slice(0, n);
}

async function fetchEdgexHistory(coin, n) {
  // edgeX funding settles every 4h (fundingRateIntervalMin=240). getFundingRatePage
  // returns a DENSE snapshot stream where many rows share one settled `fundingTime`,
  // so dedupe by fundingTime → one realized rate per settled 4h period, newest-first,
  // capped at n. Raw fraction → ×100 (%/4h), kept in the venue's own per-settlement
  // unit (legAnalytics annualizes via fundingIntervalHours=4), exactly like the other
  // venues. Real published rates — never fabricated. Needs numeric contractId.
  const contractId = edgexIdCache[coin];
  if (!contractId) return [];
  const d = await rlGetJson(`https://pro.edgex.exchange/api/v1/public/funding/getFundingRatePage?contractId=${contractId}&size=500`);
  const rows = d?.data?.dataList;
  if (!Array.isArray(rows) || !rows.length) return [];
  const seen = new Set();
  const out  = [];
  for (const row of rows) {                 // API returns newest-first
    const t = row.fundingTime;
    if (seen.has(t)) continue;
    seen.add(t);
    const v = parseFloat(row.fundingRate);
    if (isFinite(v)) out.push(v * 100);
    if (out.length >= n) break;
  }
  return out;
}

async function fetchParadexHistory(coin, n) {
  // Paradex funding is CONTINUOUS (accrues ~every 5s), published as an 8h-normalized
  // rate in `funding_rate_8h` — there are no discrete 8h settlements like Binance's
  // /fundingRate. So we pull the realized funding_rate_8h series (newest-first) and
  // evenly downsample to n points across the returned window: the honest trailing
  // analogue of the other venues' N settled rates. One call per coin, same as the
  // others. Raw fraction → ×100 (%/8h), kept in the venue's own per-settlement unit
  // (legAnalytics annualizes via fundingIntervalHours=8). Values are real published
  // rates — never fabricated; a thin/flat series simply yields trailing ≈ current.
  const d = await get(`https://api.prod.paradex.trade/v1/funding/data?market=${coin}-USD-PERP&page_size=1000`);
  const rows = d?.results;
  if (!Array.isArray(rows) || !rows.length) return [];
  const step = Math.max(1, Math.floor(rows.length / n));
  const out  = [];
  for (let i = 0; i < rows.length && out.length < n; i += step) {
    const v = parseFloat(rows[i].funding_rate_8h);
    if (isFinite(v)) out.push(v * 100);
  }
  return out;
}

const HISTORY_FETCHERS = {
  binance:     fetchBinanceHistory,
  bybit:       fetchBybitHistory,
  okx:         fetchOkxHistory,
  bitget:      fetchBitgetHistory,
  gateio:      fetchGateHistory,
  hyperliquid: fetchHyperliquidHistory,
  dydx:        fetchDydxHistory,
  aster:       fetchAsterHistory,
  paradex:     fetchParadexHistory,
  edgex:       fetchEdgexHistory,
  grvt:        fetchGrvtHistory,
  lighter:     fetchLighterHistory,
  extended:    fetchExtendedHistory,
};

// ── History cache management ──────────────────────────────────────────────────

async function refreshHistoryCache(futures) {
  console.log('[funding-hist] refreshing settled funding-rate history…');

  const tasks = [];
  for (const [exchange, coins] of Object.entries(futures)) {
    const fetcher = HISTORY_FETCHERS[exchange];
    if (!fetcher) continue;
    for (const coin of Object.keys(coins || {})) {
      tasks.push({ exchange, coin, fetcher });
    }
  }

  const fresh = {};
  await Promise.all(tasks.map(async ({ exchange, coin, fetcher }) => {
    try {
      const rates = await fetcher(coin, HISTORY_N);
      if (!rates.length) return;
      if (!fresh[exchange]) fresh[exchange] = {};
      fresh[exchange][coin] = rates;
    } catch { /* silent: old cache entry kept */ }
  }));

  // Merge: new fetch overwrites; failed fetches keep old entry
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8')).data || {}; } catch {}

  for (const [exchange, coins] of Object.entries(fresh)) {
    if (!existing[exchange]) existing[exchange] = {};
    Object.assign(existing[exchange], coins);
  }

  historyCache     = existing;
  historyFetchedAt = Date.now();

  const total = Object.values(historyCache).reduce((s, v) => s + Object.keys(v).length, 0);
  console.log(`[funding-hist] cache ready: ${total} coin-venue pairs (${tasks.length} fetched)`);

  try { fs.writeFileSync(HISTORY_CACHE_FILE, JSON.stringify({ fetchedAt: historyFetchedAt, data: historyCache })); } catch {}
  return historyCache;
}

function loadHistoryCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_CACHE_FILE, 'utf8'));
    historyCache     = raw.data || {};
    historyFetchedAt = raw.fetchedAt || 0;
    const total = Object.values(historyCache).reduce((s, v) => s + Object.keys(v).length, 0);
    console.log(`[funding-hist] loaded cache from disk: ${total} coin-venue pairs (age ${Math.round((Date.now() - historyFetchedAt) / 60_000)}m)`);
  } catch {
    historyCache     = {};
    historyFetchedAt = 0;
  }
}

// ── Per-leg analytics ─────────────────────────────────────────────────────────

function computeMedian(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/**
 * Given a venue leg's predicted rate and settled history, compute:
 *   trailingRate  — avg of last HISTORY_N settled rates (used for headline)
 *   medianRate    — median of last HISTORY_N settled rates
 *   spike         — predicted deviates far from median (transient spike)
 *   confirmed     — recent settlements mostly agree with trailing direction
 *
 * @param {number}   predictedRate  — current ticker rate, %/interval
 * @param {number}   intervalHours
 * @param {number[]} historyRates   — settled rates newest-first, %
 */
function legAnalytics(predictedRate, intervalHours, historyRates) {
  if (!historyRates.length) {
    // No settled history (HL, dYdX, or fetch failed).
    // Treat hourly venues as confirmed unless the rate is extreme.
    const annPred  = annualize(predictedRate, intervalHours);
    const extreme  = Math.abs(annPred) > (intervalHours === 1 ? HOURLY_SPIKE_ANN : 50);
    return {
      trailingRate:     predictedRate,
      medianRate:       predictedRate,
      historyAvailable: false,
      spike:            false,
      confirmed:        !extreme,
    };
  }

  const recent      = historyRates.slice(0, HISTORY_N);
  const trailingRate = recent.reduce((s, r) => s + r, 0) / recent.length;
  const medianRate   = computeMedian(recent);

  // Spike: predicted deviates > SPIKE_MULT × |median| from median, and rate is non-trivial
  const deviation  = Math.abs(predictedRate - medianRate);
  const threshold  = Math.max(SPIKE_MULT * Math.abs(medianRate), SPIKE_ABS_FLOOR);
  const spike      = deviation > threshold && Math.abs(predictedRate) > SPIKE_ABS_MIN_RATE;

  // Confirmed: ≥ CONFIRM_MIN of last CONFIRM_LOOK settlements in same direction as trailing
  const direction  = trailingRate >= 0 ? 1 : -1;
  const lookback   = recent.slice(0, Math.min(CONFIRM_LOOK, recent.length));
  const sameDir    = lookback.filter(r => (r > 0 ? 1 : r < 0 ? -1 : 0) === direction).length;
  const confirmed  = sameDir >= Math.min(CONFIRM_MIN, lookback.length);

  return { trailingRate, medianRate, historyAvailable: true, spike, confirmed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent15-funding'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function venueLabel(exchange, isDex) {
  if (exchange === 'dydx')        return 'dYdX (DEX)';
  if (exchange === 'hyperliquid') return 'Hyperliquid (DEX)';
  if (exchange === 'edgex')       return 'edgeX (DEX)';
  if (exchange === 'gateio')      return 'Gate.io';
  if (exchange === 'bitget')      return 'Bitget';
  return isDex ? `${cap(exchange)} (DEX)` : cap(exchange);
}

function liquidityUsd(data) {
  return Math.max(data?.openInterestUsd ?? 0, data?.vol24hUsd ?? 0);
}

function liqTier(usd) {
  if (usd >= 50_000_000) return 'DEEP';
  if (usd >= 10_000_000) return 'OK';
  if (usd >= 1_000_000)  return 'THIN';
  return 'VERY THIN';
}

function dexBridgeNote(shortVenue, longVenue) {
  const venues = new Set([shortVenue, longVenue]);
  const notes  = [];
  if (venues.has('hyperliquid')) notes.push('HL: USDC bridge ~10 min + ~$1-5 ETH gas one-time');
  if (venues.has('dydx'))        notes.push('dYdX: USDC bridge via Noble ~5 min + ~$3-10 gas');
  return notes.join('; ');
}

// ── Cross-exchange funding spread ─────────────────────────────────────────────
//
// For each coin on ≥2 venues:
//   trailingA = avg of last HISTORY_N SETTLED rates on venue A
//   trailingB = avg of last HISTORY_N SETTLED rates on venue B
//   grossApy  = |annualize(trailingA) − annualize(trailingB)|   ← HEADLINE
//   predictedGrossApy = |annualize(predictedA) − annualize(predictedB)|   ← transparency only
//
// Spike/confirmation flags are computed per-leg from history. If any leg is
// spiked or unconfirmed, verdict = 'SPIKE — predicted, unconfirmed'.

function crossExchangeSpread(futures, hCache) {
  // Build byExchange: coin → [{ exchange, fr (predicted), intervalHours, isDex }]
  const byExchange = {};
  for (const [ex, coins] of Object.entries(futures)) {
    const isDex = ex === 'hyperliquid' || ex === 'dydx' || ex === 'aster' || ex === 'paradex' || ex === 'edgex' || ex === 'grvt' || ex === 'lighter' || ex === 'extended';
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr            = data?.fundingRate;
      const intervalHours = data?.fundingIntervalHours ?? 8;
      if (fr == null || typeof fr !== 'number' || !isFinite(fr)) continue;
      if (!byExchange[coin]) byExchange[coin] = [];
      byExchange[coin].push({ exchange: ex, fr, intervalHours, isDex });
    }
  }

  const opps = [];

  for (const [coin, list] of Object.entries(byExchange)) {
    if (list.length < 2) continue;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];

        // Per-leg analytics from settled history
        const histA  = (hCache[A.exchange] || {})[coin] || [];
        const histB  = (hCache[B.exchange] || {})[coin] || [];
        const analA  = legAnalytics(A.fr, A.intervalHours, histA);
        const analB  = legAnalytics(B.fr, B.intervalHours, histB);

        // Trailing-based annualized rates → headline
        const annTrailA      = annualize(analA.trailingRate, A.intervalHours);
        const annTrailB      = annualize(analB.trailingRate, B.intervalHours);
        const trailingGrossApy = Math.abs(annTrailA - annTrailB);

        // Predicted-based (for transparency / notes)
        const annPredA       = annualize(A.fr, A.intervalHours);
        const annPredB       = annualize(B.fr, B.intervalHours);
        const predictedGrossApy = Math.abs(annPredA - annPredB);

        // Emit only if trailing spread is meaningful; if predicted is inflated
        // but trailing is trivial, this is pure noise — skip silently.
        if (trailingGrossApy < THRESHOLD_APY) continue;
        if (trailingGrossApy > MAX_GROSS_APY)  continue;

        // SHORT = higher trailing annualized (collect), LONG = lower (pay less / collect)
        const [shortSide, longSide, analShort, analLong] =
          annTrailA >= annTrailB
            ? [A, B, analA, analB]
            : [B, A, analB, analA];

        // Spike / confirmation flags
        const spikeFlag        = analShort.spike || analLong.spike;
        const allConfirmed     = analShort.confirmed && analLong.confirmed;
        const oneLegUnverified = !analShort.historyAvailable || !analLong.historyAvailable;
        const fullyConfirmed   = allConfirmed && !oneLegUnverified && !spikeFlag;

        const totalFees  = roundTripFeeByVenue(shortSide.exchange, longSide.exchange);
        const net30d     = netApy30d(trailingGrossApy, totalFees);
        // Honest-engine: payback recovers entry+exit fees from NET $/day (after
        // fees), not gross. net30d and totalFees are both %/yr → basis-consistent.
        // Non-positive net has no valid payback → null (renders "—", never cashable).
        const beDays     = net30d > 0 ? breakevenDays(net30d, totalFees) : null;
        const status     = beDays === null ? 'MARGINAL' : spreadStatus(beDays);
        const hasDexLeg  = shortSide.isDex || longSide.isDex;

        // Liquidity
        const shortData  = (futures[shortSide.exchange] || {})[coin] || {};
        const longData   = (futures[longSide.exchange]  || {})[coin] || {};
        const shortLiq   = liquidityUsd(shortData);
        const longLiq    = liquidityUsd(longData);
        const minLiq     = shortLiq > 0 && longLiq > 0
          ? Math.min(shortLiq, longLiq)
          : Math.max(shortLiq, longLiq);
        if (minLiq > 0 && minLiq < MIN_LIQ_USD) continue;
        const capUsd     = minLiq > 0 ? Math.round(Math.min(minLiq * 0.01, 500_000)) : null;
        const tier       = minLiq > 0 ? liqTier(minLiq) : null;
        const thinFlag   = tier === 'THIN' || tier === 'VERY THIN';

        // Reset cadence note
        const resetParts = [];
        if (shortSide.intervalHours === 1) resetParts.push(`${shortSide.exchange} resets HOURLY`);
        if (longSide.intervalHours  === 1) resetParts.push(`${longSide.exchange} resets HOURLY`);
        const resetNote = resetParts.length > 0
          ? resetParts.join('; ') + ' — these legs can flip every hour. CEX legs every 8h.'
          : 'Both legs reset every 8h.';

        const shortFeePct = venueFeePct(shortSide.exchange);
        const longFeePct  = venueFeePct(longSide.exchange);
        const feeNote = `Round-trip fees: ${shortSide.exchange} ${shortFeePct}%/leg + ${longSide.exchange} ${longFeePct}%/leg × 2 = ${totalFees.toFixed(3)}%`;

        const bridgeNoteStr = hasDexLeg ? dexBridgeNote(shortSide.exchange, longSide.exchange) : '';

        // Spike transparency note
        let spikeNote = '';
        if (spikeFlag) {
          const spikeLeg = analShort.spike ? shortSide.exchange : longSide.exchange;
          const spikePredAnn = analShort.spike
            ? +annPredA.toFixed(1) : +annPredB.toFixed(1);
          const spikeTrailAnn = analShort.spike
            ? +annTrailA.toFixed(1) : +annTrailB.toFixed(1);
          spikeNote = `SPIKE FLAG: ${spikeLeg} predicted rate annualizes to ${spikePredAnn >= 0 ? '+' : ''}${spikePredAnn}%/yr vs trailing avg ${spikeTrailAnn >= 0 ? '+' : ''}${spikeTrailAnn}%/yr — headline uses trailing.`;
        }

        // Verdict — severity order: SPIKE > PARTIAL > THIN > HARVEST
        let verdict;
        if (spikeFlag || !allConfirmed) {
          verdict = 'SPIKE — predicted, unconfirmed';
        } else if (oneLegUnverified) {
          verdict = 'PARTIAL — 1 leg unverified';
        } else if (thinFlag) {
          verdict = 'HARVEST · thin — not executable at size';
        } else {
          verdict = 'HARVEST · variable';
        }

        opps.push({
          type:             'FUNDING',
          id:               `funding-${coin}-${shortSide.exchange}-${longSide.exchange}`,
          question:         `${coin}/USDT Funding Spread`,
          legs: [
            {
              platform:       venueLabel(shortSide.exchange, shortSide.isDex),
              side:           'SHORT',
              price:          +shortSide.fr.toFixed(6),
              intervalHours:  shortSide.intervalHours,
              isDex:          shortSide.isDex,
              url:            null,
              // ── Anti-spike fields ──
              predictedRate:  +shortSide.fr.toFixed(6),
              trailingRate:   +analShort.trailingRate.toFixed(6),
              medianRate:     +analShort.medianRate.toFixed(6),
              historyAvailable: analShort.historyAvailable,
              spike:          analShort.spike,
              confirmed:      analShort.confirmed,
            },
            {
              platform:       venueLabel(longSide.exchange, longSide.isDex),
              side:           'LONG',
              price:          +longSide.fr.toFixed(6),
              intervalHours:  longSide.intervalHours,
              isDex:          longSide.isDex,
              url:            null,
              // ── Anti-spike fields ──
              predictedRate:  +longSide.fr.toFixed(6),
              trailingRate:   +analLong.trailingRate.toFixed(6),
              medianRate:     +analLong.medianRate.toFixed(6),
              historyAvailable: analLong.historyAvailable,
              spike:          analLong.spike,
              confirmed:      analLong.confirmed,
            },
          ],
          // ── Headline numbers (trailing-based — honest engine) ──
          annualizedROI:      +trailingGrossApy.toFixed(2),
          netROI:             net30d,
          grossROI:           +trailingGrossApy.toFixed(2),
          // ── Raw predicted (for transparency) ──
          predictedGrossApy:  +predictedGrossApy.toFixed(2),
          // ── Spike/confirmation flags ──
          spikeFlag,
          allConfirmed,
          oneLegUnverified,
          fullyConfirmed,
          // ── Existing fields ──
          spread:             null,
          daysToResolution:   null,
          resolutionDate:     null,
          capacityUsd:        capUsd,
          lockupFlag:         null,
          verdict,
          confidence:         (spikeFlag || !allConfirmed) ? 0.3
                            : oneLegUnverified             ? 0.5
                            : trailingGrossApy > 10        ? 0.7
                            :                               0.85,
          note:               [feeNote, resetNote, spikeNote, bridgeNoteStr].filter(Boolean).join(' '),
          hasDexLeg,
          totalFeesPct:       +totalFees.toFixed(3),
          breakevenDays:      beDays,
          status,
          liquidityTier:      tier,
          oiUsd:              minLiq > 0 ? Math.round(minLiq) : null,
          thinFlag,
          fundingIntervalHoursShort: shortSide.intervalHours,
          fundingIntervalHoursLong:  longSide.intervalHours,
        });
      }
    }
  }

  return opps.sort((a, b) => b.annualizedROI - a.annualizedROI);
}

// ── Atomic type-preserving merge ──────────────────────────────────────────────

const TYPE_RANK = { CASHABLE: 0, SPORTS: 1, FUNDING: 2, SIGNAL: 3 };

function mergeUnifiedFunding(allFundingOpps) {
  let existing = { generatedAt: null, sources: {}, summary: {}, opportunities: [] };
  try {
    existing = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
  } catch { /* file absent or corrupt — start fresh */ }

  const kept   = (existing.opportunities || []).filter(o => o.type !== 'FUNDING');
  const merged = [...kept, ...allFundingOpps];

  merged.sort((a, b) => {
    const ra = TYPE_RANK[a.type] ?? 9, rb = TYPE_RANK[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.annualizedROI !== null && b.annualizedROI !== null) return b.annualizedROI - a.annualizedROI;
    if (a.annualizedROI !== null) return -1;
    if (b.annualizedROI !== null) return 1;
    return 0;
  });

  const allROIs        = merged.map(o => o.annualizedROI).filter(v => v != null);
  const bestAnnualized = allROIs.length ? Math.max(...allROIs) : null;

  const result = {
    generatedAt: existing.generatedAt ?? null,
    sources: {
      ...(existing.sources ?? {}),
      funding: {
        updatedAt:  Date.now(),
        emitCount:  allFundingOpps.length,
        totalFound: allFundingOpps.length,
        threshold:  THRESHOLD_APY,
      },
    },
    summary: {
      total:          merged.length,
      cashable:       merged.filter(o => o.type === 'CASHABLE').length,
      signal:         merged.filter(o => o.type === 'SIGNAL').length,
      sports:         merged.filter(o => o.type === 'SPORTS').length,
      funding:        allFundingOpps.length,
      bestAnnualized,
    },
    opportunities: merged,
  };

  const tmpPath = UNIFIED_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  fs.renameSync(tmpPath, UNIFIED_FILE);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

// Safe read of exchange-prices.json. agent10 now writes it atomically, so partial
// reads should never happen — but defense in depth: on a transient parse failure retry
// once after a short delay, and if still failing reuse the last successfully-parsed
// snapshot rather than crashing the cycle or fabricating/zeroing data. Never returns a
// partial/garbage object; returns null only when there is no prior good snapshot.
async function readExchangeData() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
      lastGoodExchangeData = data;   // remember last good; the age check below gates staleness
      return data;
    } catch {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 150)); continue; }
      if (lastGoodExchangeData) {
        console.log('[funding] exchange-prices unreadable this tick — reusing last good snapshot');
        return lastGoodExchangeData;
      }
      console.log('[funding] exchange-prices unreadable and no prior snapshot — skip cycle');
      return null;
    }
  }
}

async function run() {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!fs.existsSync(EXCHANGE_FILE)) {
      console.log('[funding] exchange-prices.json not found — waiting for agent10');
      return;
    }

    const data = await readExchangeData();
    if (!data) return;                       // no readable data and no snapshot → skip cycle
    const ageMs = Date.now() - (data.fetchedAt || 0);

    if (ageMs > MAX_DATA_AGE) {
      console.log(`[funding] exchange data ${Math.round(ageMs / 60_000)}m old — skip`);
      return;
    }

    // edgeX + Lighter depth/history endpoints key on a numeric id (not coin), so those
    // id maps MUST be ready before refreshHistoryCache/enrichWithDepth run.
    if (Date.now() - edgexIdFetchedAt > MULT_REFRESH_MS || !Object.keys(edgexIdCache).length) {
      await refreshEdgexIdCache();
    }
    if (Date.now() - lighterIdFetchedAt > MULT_REFRESH_MS || !Object.keys(lighterIdCache).length) {
      await refreshLighterIdCache();
    }
    if (!historyCache) loadHistoryCacheFromDisk();
    // Refresh settled history on the normal cadence. Plus a generic one-shot backfill:
    // if a venue is live in `futures` and has a history fetcher but is missing from the
    // history cache — because its data landed AFTER the last refresh (startup race:
    // agent10 writes a venue's futures a beat after we refreshed, or a late contractId
    // map) — force a single extra refresh so its legs don't sit at PARTIAL for a full
    // 15-min cycle. Latched per-venue (backfillAttempted) so a genuinely dead history
    // endpoint can't spin the refresh every 60s. Covers edgeX, Grvt, and any future venue.
    const backfillVenues = Object.keys(data.futures || {}).filter(v =>
      HISTORY_FETCHERS[v] && !backfillAttempted.has(v) &&
      historyCache && !Object.keys(historyCache[v] || {}).length);
    if (Date.now() - historyFetchedAt > HISTORY_REFRESH_MS || backfillVenues.length) {
      for (const v of backfillVenues) backfillAttempted.add(v);
      await refreshHistoryCache(data.futures || {});
    }
    // Refresh contract multipliers at the same cadence (needed for depth accuracy)
    if (Date.now() - multFetchedAt > MULT_REFRESH_MS) {
      await refreshMultiplierCache();
    }

    const allOpps = crossExchangeSpread(data.futures || {}, historyCache || {});

    // Enrich confirmed opps with real order-book depth, cap capacityUsd, set depthThin
    const confirmedOpps = allOpps.filter(o => o.fullyConfirmed);
    if (confirmedOpps.length > 0) {
      await enrichWithDepth(confirmedOpps);
    }

    const spikedCount = allOpps.filter(o => o.spikeFlag || !o.allConfirmed).length;
    const thinCount   = confirmedOpps.filter(o => o.depthThin).length;
    console.log(`[funding] ${allOpps.length} pairs ≥${THRESHOLD_APY}%/yr — ${spikedCount} spike/unconfirmed — ${thinCount}/${confirmedOpps.length} confirmed THIN (green=$0):`);
    for (const o of allOpps.slice(0, 10)) {
      const spikeMark = (o.spikeFlag || !o.allConfirmed) ? ' ⚠SPIKE' : '';
      const predNote  = o.spikeFlag ? ` [pred:${o.predictedGrossApy}%]` : '';
      const greenMark = o.greenCapacityUsd != null ? ` 🟢$${Math.round(o.greenCapacityUsd/1000)}k` : '';
      const maxMark   = o.slipCurveMaxFillable != null ? `/max$${Math.round(o.slipCurveMaxFillable/1000)}k` : '';
      console.log(`  ${o.id}: trailing:+${o.annualizedROI}%/yr${predNote}  cap:${o.capacityUsd != null ? '$'+Math.round(o.capacityUsd/1000)+'k' : 'null'}${greenMark}${maxMark}  ${o.status}${spikeMark}`);
    }

    mergeUnifiedFunding(allOpps);
    beat();

  } catch (e) {
    console.error('[funding] error:', e.message, e.stack?.split('\n')[1] ?? '');
  } finally {
    isRunning = false;
  }
}

run();
setInterval(run, INTERVAL_MS);
