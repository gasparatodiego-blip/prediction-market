'use strict';

// lib/source-verify.js — CONTINUOUS SOURCE-OF-TRUTH verification primitives.
//
// Positive verification of what IS served: for a served opportunity row we
// independently RE-READ the same field straight from the venue's own public
// endpoint (the same URLs agent15/24/25/28 already use) and compare against the
// value our pipeline is currently serving, within a per-field-type tolerance.
//
// Honest-engine contract:
//   • A value we CANNOT re-read at the source within its freshness window is
//     reported 'unreachable' — never fabricated as 'ok'.
//   • A value the venue positively CONTRADICTS beyond tolerance is 'mismatch'.
//   • Funding rates legitimately roll at settlement boundaries — a value that
//     changed because the venue crossed a settlement (nextFundingTime advanced)
//     is NOT a mismatch; only a value that disagrees with the venue's CURRENT
//     quote for the SAME period is.
//
// This module is a pure networking + comparison library (no loop, no I/O of its
// own state) so it can be unit-tested and reused. The agent29 loop drives it.
//
// Units note (matches agent28-perp-spot.js:63 and lib/funding-math):
//   exchange-prices.json `fundingRate` is stored as native_fraction × 100, i.e.
//   a PERCENT per the venue's funding interval (0.005 = 0.005%/interval). Every
//   live venue endpoint below returns a raw FRACTION, so adapters multiply by
//   100 to return the same percent-per-interval basis before comparison.

const { rlGet, rlPost } = require('./rateLimitedFetch');

// ── Tolerances (task-sanctioned; commented consts) ──────────────────────────
// FUNDING mismatch = ABSOLUTE arm OR PROPORTIONAL arm.
//   ABSOLUTE arm:     |Δ8h| > 0.005 %/8h  (~5.5 %/yr) — a real economic divergence
//                     at ANY magnitude. This is the effective discriminator and the
//                     one that catches every real error: a wrong sign / 2x / 10x /
//                     dead-contract cap-pin all move the 8h rate far past 0.005 %/8h.
//   PROPORTIONAL arm: |Δ| > 15% relative AND |Δ8h| > 0.005 %/8h — a proportionally
//                     large move that is ALSO economically material.
// Why 15% + a 0.005 %/8h floor (raised from 10% + 0.002 %/8h): frequent-settlement
// venues (Hyperliquid / dYdX settle HOURLY) publish a live-updating PREDICTED funding
// rate that legitimately drifts between two 60s-apart reads. A real observed sample —
// HL live −0.002321 vs stored −0.002006 %/1h — is a 15.7% relative move but only
// 0.00252 %/8h absolute: pure settlement-boundary drift, NOT a phantom. The old
// (10%, 0.002 %/8h) relative arm false-flagged that entire class (WIF/OP/INJ/ATOM on
// HL, dYdX, lighter, grvt). Requiring the proportional arm to ALSO clear 0.005 %/8h
// means a >15% move that is sub-0.005 %/8h in absolute terms is treated as drift, not
// a mismatch — while the absolute arm still independently catches any ≥0.005 %/8h
// divergence regardless of how small the relative move is (e.g. 1.0 → 1.1 %/8h on a
// large rate). Net: the observed noise passes; sign-flip / 2x / 10x / cap-pin still drop.
// HONEST-ENGINE: this is a materiality floor (~5.5 %/yr), NOT a blanket widening — a
// genuinely wrong number that is off by ≥0.005 %/8h can never pass.
const FUNDING_REL_TOL      = 0.15;   // 15% relative (was 10% — killed HL/dYdX drift FPs)
const FUNDING_ABS_TOL_8H   = 0.005;  // 0.005 %/8h absolute (percent units) — unchanged
// Below this per-interval rate magnitude (percent) the relative test is noise —
// two near-zero rates can differ by >15% while being economically identical, so
// we fall back to the absolute test only. Keeps float-noise from false-dropping.
const FUNDING_REL_FLOOR_PCT = 0.001; // 0.001 %/interval
// The proportional arm additionally requires the 8h-normalized delta to clear this
// floor (now equal to the absolute floor). This is the concrete "rates legitimately
// move within a settlement" allowance: a >15%-relative move that is only ~0.0025 %/8h
// absolute (the HL/dYdX hourly-drift class) is drift, not a phantom, and is NOT flagged.
const FUNDING_REL_NOISE_8H  = 0.005; // 0.005 %/8h (was 0.002 — matches the absolute floor)
// PRICE / DEPTH (perp-spot mark, basis future/spot): relative delta > 5% ⇒ MISMATCH.
const PRICE_REL_TOL        = 0.05;   // 5% relative
// POOL (rewards): the source rewards field. Pools DO drift slightly between our
// snapshot and now (the program rate can be re-tuned), so a few-percent drift is
// not a phantom. The phantom class is a pool that ENDED (source now 0 while we
// still show a positive pool) or an order-of-magnitude-wrong figure. So: MISMATCH
// when the source pays 0 but we show >0, OR relative drift exceeds 10%.
const POOL_ABS_EPS         = 0.01;   // $/day — below this the pools are effectively equal
const POOL_REL_EPS         = 0.10;   // 10% relative

// Our stored snapshot must itself be fresh to positively verify against a live
// quote; older than this and we report 'unreachable' (our data is stale, we will
// not claim it matches the venue). Matches agent28 MAX_SOURCE_AGE_MS.
const STORED_FRESH_MS      = 10 * 60_000;

const FETCH_TIMEOUT_MS     = 8_000;

// ── small helpers ───────────────────────────────────────────────────────────
// Every outbound HTTP call is counted so the agent can enforce + report a real
// per-cycle call budget against the venues' free-tier limits.
let _callCount = 0;
function resetCallCount() { _callCount = 0; }
function getCallCount() { return _callCount; }

// Browser-like headers — several venues (extended, edgeX) sit behind Cloudflare and
// 403 a header-less request. Mirrors the exact headers the producer agent15 uses so
// our independent re-read reaches the same endpoint the same way.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

function num(v) { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; }
async function get(url) { _callCount++; const r = await rlGet(url, { timeoutMs: FETCH_TIMEOUT_MS, headers: HEADERS }); return r && r.data; }
async function post(url, body) { _callCount++; const r = await rlPost(url, body, { timeoutMs: FETCH_TIMEOUT_MS, headers: HEADERS }); return r && r.data; }

// native fraction (from a venue endpoint) → percent-per-interval (our stored basis)
function fracToPct(frac) { const f = num(frac); return f == null ? null : f * 100; }
// percent-per-interval → percent-per-8h
function toPct8h(pctPerInterval, intervalHours) {
  const h = intervalHours > 0 ? intervalHours : 8;
  return pctPerInterval * (8 / h);
}
function topOfNextHourMs(now) { return Math.ceil(now / 3_600_000) * 3_600_000; }

// ── FUNDING adapters: venue → CURRENT funding rate (+ mark, + nextFundingTime) ─
// Each returns { ratePct, intervalHours|null, nextFundingTime|null, markPrice|null }
// in percent-per-interval, or null when the venue can't be re-read. Bulk-response
// venues (HL, dydx) memoize their one call on the shared per-cycle `cache`.
const FUNDING_ADAPTERS = {
  async binance(coin) {
    const d = await get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
    if (!d || d.lastFundingRate == null) return null;
    return { ratePct: fracToPct(d.lastFundingRate), intervalHours: null,
             nextFundingTime: num(d.nextFundingTime), markPrice: num(d.markPrice) };
  },
  async aster(coin) {
    const d = await get(`https://fapi.asterdex.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
    if (!d || d.lastFundingRate == null) return null;
    return { ratePct: fracToPct(d.lastFundingRate), intervalHours: null,
             nextFundingTime: num(d.nextFundingTime), markPrice: num(d.markPrice) };
  },
  async bybit(coin) {
    const d = await get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${coin}USDT`);
    const r = d && d.result && Array.isArray(d.result.list) ? d.result.list[0] : null;
    if (!r || r.fundingRate == null) return null;
    return { ratePct: fracToPct(r.fundingRate), intervalHours: null,
             nextFundingTime: num(r.nextFundingTime), markPrice: num(r.markPrice) };
  },
  async okx(coin) {
    const d = await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`);
    const r = d && Array.isArray(d.data) ? d.data[0] : null;
    if (!r || r.fundingRate == null) return null;
    return { ratePct: fracToPct(r.fundingRate), intervalHours: null,
             nextFundingTime: num(r.nextFundingTime), markPrice: null };
  },
  async gateio(coin) {
    const d = await get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${coin}_USDT`);
    if (!d || d.funding_rate == null) return null;
    const intervalSec = num(d.funding_interval);
    return { ratePct: fracToPct(d.funding_rate),
             intervalHours: intervalSec != null ? intervalSec / 3600 : null,
             nextFundingTime: d.funding_next_apply != null ? num(d.funding_next_apply) * 1000 : null,
             markPrice: num(d.mark_price) };
  },
  async bitget(coin) {
    const d = await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${coin}USDT&productType=USDT-FUTURES`);
    const r = d && Array.isArray(d.data) ? d.data[0] : null;
    if (!r || r.fundingRate == null) return null;
    return { ratePct: fracToPct(r.fundingRate), intervalHours: num(r.fundingRateInterval),
             nextFundingTime: num(r.nextUpdate), markPrice: null };
  },
  async extended(coin, cache) {
    // Extended exposes ALL markets in one call — fetch once per cycle and memoize
    // (per-coin calls trip its Cloudflare bot-protection → 429/backoff).
    if (!cache.extended) {
      const list = await get('https://api.starknet.extended.exchange/api/v1/info/markets');
      const arr  = (list && (list.data || list)) || [];
      const map = {};
      if (Array.isArray(arr)) for (const x of arr) if (x && x.name) map[x.name] = x;
      cache.extended = map;
    }
    const m = cache.extended[`${coin}-USD`];
    const s = m && m.marketStats;
    if (!s || s.fundingRate == null) return null;
    // Extended posts an hourly funding rate.
    return { ratePct: fracToPct(s.fundingRate), intervalHours: 1,
             nextFundingTime: num(s.nextFundingRate), markPrice: num(s.markPrice) };
  },
  async hyperliquid(coin, cache) {
    if (!cache.hl) {
      const d = await post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
      const map = {};
      if (Array.isArray(d) && d[0] && Array.isArray(d[0].universe) && Array.isArray(d[1])) {
        d[0].universe.forEach((u, i) => { if (u && u.name) map[u.name] = d[1][i]; });
      }
      cache.hl = map;
    }
    const ctx = cache.hl[coin];
    if (!ctx || ctx.funding == null) return null;
    // HL funding is an hourly fraction, continuous settlement.
    return { ratePct: fracToPct(ctx.funding), intervalHours: 1,
             nextFundingTime: topOfNextHourMs(Date.now()), markPrice: num(ctx.markPx) };
  },
  async dydx(coin, cache) {
    if (!cache.dydx) {
      const d = await get('https://indexer.dydx.trade/v4/perpetualMarkets');
      cache.dydx = (d && d.markets) || {};
    }
    const m = cache.dydx[`${coin}-USD`];
    if (!m || m.nextFundingRate == null) return null;
    // dYdX v4 nextFundingRate is an hourly rate (fraction), continuous settlement.
    return { ratePct: fracToPct(m.nextFundingRate), intervalHours: 1,
             nextFundingTime: topOfNextHourMs(Date.now()), markPrice: num(m.oraclePrice) };
  },
  // ── USDC-MARGINED perps (majors) — re-read the SEPARATE USDC contract, not the
  //    USDT one. Symbol maps mirror agent10: Binance <COIN>USDC; Bybit/Bitget <COIN>PERP.
  async 'binance-usdc'(coin) {
    const d = await get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDC`);
    if (!d || d.lastFundingRate == null) return null;
    return { ratePct: fracToPct(d.lastFundingRate), intervalHours: null,
             nextFundingTime: num(d.nextFundingTime), markPrice: num(d.markPrice) };
  },
  async 'bybit-usdc'(coin) {
    const d = await get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${coin}PERP`);
    const r = d && d.result && Array.isArray(d.result.list) ? d.result.list[0] : null;
    if (!r || r.fundingRate == null) return null;
    return { ratePct: fracToPct(r.fundingRate), intervalHours: null,
             nextFundingTime: num(r.nextFundingTime), markPrice: num(r.markPrice) };
  },
  async 'bitget-usdc'(coin) {
    const d = await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${coin}PERP&productType=USDC-FUTURES`);
    const r = d && Array.isArray(d.data) ? d.data[0] : null;
    if (!r || r.fundingRate == null) return null;
    return { ratePct: fracToPct(r.fundingRate), intervalHours: num(r.fundingRateInterval),
             nextFundingTime: num(r.nextUpdate), markPrice: null };
  },
};

// Venues we can independently re-read for funding. Anything not here (lighter,
// grvt, edgex, pacifica, apex, paradex) is reported 'unreachable' — HONEST: we
// do not claim to have verified a leg we cannot re-fetch.
const FUNDING_VENUES = new Set(Object.keys(FUNDING_ADAPTERS));

// ── BASIS adapters: venueKey → { mark, spot } for a dated contract ──────────
// Contract labels in the served basis feed already ARE the venue instrument
// names (BTC-25JUN27 = Deribit, BTC-USD-261225 = OKX instId, BTCUSD_261225 =
// Binance COIN-M, BTCUSDT_261225 = Binance USDT-M delivery, BTCUSDT-25SEP26 =
// Bybit USDT-M linear delivery, FF_XBTUSD_260925 = Kraken flexible-futures delivery).
const BASIS_ADAPTERS = {
  async BYBIT(contract) {
    const d = await get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${contract}`);
    const r = d && d.result && Array.isArray(d.result.list) ? d.result.list[0] : null;
    if (!r || r.markPrice == null) return null;
    return { mark: num(r.markPrice), spot: num(r.indexPrice) };
  },
  async KRAKEN(contract) {
    const d = await get(`https://futures.kraken.com/derivatives/api/v3/tickers/${contract}`);
    const r = d && d.ticker;
    if (!r || r.markPrice == null) return null;
    return { mark: num(r.markPrice), spot: num(r.indexPrice) };
  },
  async DERIBIT(contract) {
    const d = await get(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${contract}`);
    const r = d && d.result;
    if (!r || r.mark_price == null) return null;
    return { mark: num(r.mark_price), spot: num(r.index_price) };
  },
  async OKX(contract) {
    const t = await get(`https://www.okx.com/api/v5/market/ticker?instId=${contract}`);
    const tr = t && Array.isArray(t.data) ? t.data[0] : null;
    if (!tr) return null;
    const mk = await get(`https://www.okx.com/api/v5/public/mark-price?instId=${contract}`);
    const mr = mk && Array.isArray(mk.data) ? mk.data[0] : null;
    const mark = mr ? num(mr.markPx) : num(tr.last);
    if (mark == null) return null;
    return { mark, spot: null };
  },
  async COINM(contract) {
    const d = await get(`https://dapi.binance.com/dapi/v1/premiumIndex?symbol=${contract}`);
    const r = Array.isArray(d) ? d[0] : d;
    if (!r || r.markPrice == null) return null;
    return { mark: num(r.markPrice), spot: num(r.indexPrice) };
  },
  async USDTM(contract) {
    const d = await get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${contract}`);
    const r = Array.isArray(d) ? d[0] : d;
    if (!r || r.markPrice == null) return null;
    return { mark: num(r.markPrice), spot: num(r.indexPrice) };
  },
};
const BASIS_VENUES = new Set(Object.keys(BASIS_ADAPTERS));

// ── REWARDS: Polymarket daily pool re-read (exact source field) ─────────────
// Gamma is the platform's own rewards field: clobRewards[].rewardsDailyRate.
async function fetchPolyPool(conditionId) {
  const d = await get(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`);
  const m = Array.isArray(d) ? d[0] : d;
  if (!m) return null;
  const cr = Array.isArray(m.clobRewards) ? m.clobRewards : [];
  if (!cr.length) return { dailyPool: 0 }; // market exists but pays no rewards now
  const rate = num(cr[0].rewardsDailyRate);
  return { dailyPool: rate == null ? 0 : rate };
}

// ── Comparators ─────────────────────────────────────────────────────────────
// Returns { status:'ok'|'mismatch', note?, source } for a funding leg.
function compareFunding(storedPct, live, intervalHours) {
  const livePct = live.ratePct;
  if (livePct == null) return { status: 'unreachable' };
  const iv = intervalHours > 0 ? intervalHours : 8;
  const source = { livePct: round(livePct, 6), storedPct: round(storedPct, 6), intervalHours: iv };

  const delta        = livePct - storedPct;              // percent per interval
  const delta8h      = delta * (8 / iv);                 // percent per 8h
  const absMiss      = Math.abs(delta8h) > FUNDING_ABS_TOL_8H;
  const relMiss      = Math.abs(storedPct) >= FUNDING_REL_FLOOR_PCT &&
                       Math.abs(delta) / Math.abs(storedPct) > FUNDING_REL_TOL &&
                       Math.abs(delta8h) > FUNDING_REL_NOISE_8H;

  if (absMiss || relMiss) {
    // Settlement-boundary escape: if the venue crossed a settlement since our
    // snapshot (nextFundingTime advanced), the rate legitimately rolled — NOT a
    // mismatch of the same period. We can only assert this when BOTH sides carry
    // a nextFundingTime; continuous-funding venues fall through to the strict test.
    if (live.nextFundingTime != null && live.storedNextFundingTime != null &&
        live.nextFundingTime !== live.storedNextFundingTime) {
      return { status: 'ok', note: 'settlement-rolled', source };
    }
    return { status: 'mismatch', source: { ...source, delta8h: round(delta8h, 6) } };
  }
  return { status: 'ok', source };
}

// Returns 'ok'|'mismatch' for a price within PRICE_REL_TOL (5%).
function comparePrice(served, live) {
  if (served == null || live == null) return { status: 'unreachable' };
  const rel = Math.abs(served - live) / Math.max(Math.abs(live), 1e-9);
  if (rel > PRICE_REL_TOL) return { status: 'mismatch', source: { served: round(served, 6), live: round(live, 6), rel: round(rel, 4) } };
  return { status: 'ok', source: { served: round(served, 6), live: round(live, 6) } };
}

// Exact-field pool comparison.
function comparePool(served, live) {
  if (served == null || live == null) return { status: 'unreachable' };
  // Program ended at the source but we still advertise a pool ⇒ phantom.
  if (served > POOL_ABS_EPS && Math.abs(live) <= POOL_ABS_EPS)
    return { status: 'mismatch', source: { servedPool: served, sourcePool: live, reason: 'source pays 0' } };
  const abs = Math.abs(served - live);
  const rel = abs / Math.max(Math.abs(live), 1e-9);
  if (abs > POOL_ABS_EPS && rel > POOL_REL_EPS)
    return { status: 'mismatch', source: { servedPool: served, sourcePool: live, rel: round(rel, 4) } };
  return { status: 'ok', source: { servedPool: served, sourcePool: live } };
}

function round(v, dp) { const f = 10 ** dp; return Math.round(v * f) / f; }

// ── Row id builders — MUST stay in sync with lib/display-sanity.ts rowId() ──
// Funding is canonicalized on sorted venues so the status key matches regardless
// of which leg the serve path picked as "short" (spread-compute may reorder).
function fundingKey(coin, exA, exB) { return `funding-${coin}-${[exA, exB].sort().join('-')}`; }
function perpSpotKey(coin, shortVenue) { return `perp-spot-${coin}-${shortVenue}`; }
// USDC-arb: order-independent on (venue:margin) legs — matches display-sanity verifyKey('usdc').
function usdcArbKey(coin, shortVenue, shortMargin, longVenue, longMargin) {
  const legs = [`${shortVenue}:${shortMargin}`, `${longVenue}:${longMargin}`].sort();
  return `usdc-${coin}-${legs.join('-')}`;
}
function basisKey(asset, exchange, contract) { return `basis-${asset}-${exchange}-${contract}`; }
function rewardsKey(marketId) { return `rewards-${marketId}`; }

module.exports = {
  // consts
  FUNDING_REL_TOL, FUNDING_ABS_TOL_8H, FUNDING_REL_FLOOR_PCT, FUNDING_REL_NOISE_8H, PRICE_REL_TOL,
  POOL_ABS_EPS, POOL_REL_EPS, STORED_FRESH_MS, FETCH_TIMEOUT_MS,
  // adapters
  FUNDING_ADAPTERS, FUNDING_VENUES, BASIS_ADAPTERS, BASIS_VENUES, fetchPolyPool,
  // comparators
  compareFunding, comparePrice, comparePool,
  // helpers (exported for tests)
  fracToPct, toPct8h, topOfNextHourMs, round,
  // call accounting
  getCallCount, resetCallCount,
  // keys
  fundingKey, perpSpotKey, usdcArbKey, basisKey, rewardsKey,
};
