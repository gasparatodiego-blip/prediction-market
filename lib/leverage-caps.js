'use strict';

/**
 * lib/leverage-caps.js — SSOT for REAL per-(perp venue, asset) MAX LEVERAGE + tier-1
 * MAINTENANCE MARGIN, sourced from FREE public venue endpoints (each verified + dated
 * 2026-07-11 in the per-venue comments below).
 *
 * Honest-engine:
 *   • maxLeverage is `null` whenever a venue does NOT expose it on a free public endpoint
 *     (grvt, aster) — NEVER a guessed cap. A null cap makes the row non-leverageable
 *     downstream (effective leverage forced to 1×), so we never claim a leverage a user
 *     can't actually reach.
 *   • maintenanceMarginPct is the venue's REAL published/derived tier-1 rate where the same
 *     public call provides it (binance, gate, bitget, hyperliquid, dydx, lighter, paradex,
 *     edgex, apex). Where it isn't cleanly public we use a documented CONSERVATIVE default
 *     (higher maintenance ⇒ tighter, safer liquidation buffer), tagged in `source`.
 *
 * This module is PURE DATA — no money math. The leverage return-on-equity math is the
 * single source of truth in lib/funding-math.js (perpSpotLeverage) and is applied at
 * request/render time. agents/agent28-perp-spot.js calls refreshCaps() on a throttled
 * cadence and stamps each crowned row with { maxLeverage, maintenanceMarginPct, leverageSource }.
 */

const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'leverage-caps.json');
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // caps change rarely → refresh a venue at most ~4×/day
const FETCH_TIMEOUT_MS = 8_000;

// Conservative tier-1 maintenance-margin % for the few venues that publish maxLeverage but
// not a clean public maintenance rate. Higher = tighter (safer) liquidation buffer. Every
// venue's real tier-1 maintenance for majors sits ≈0.4–0.5% (observed live 2026-07-11), so
// 0.5% is a conservative upper bound — it can only UNDERstate the buffer, never overstate it.
const DEFAULT_MAINTENANCE_PCT = {
  bybit:    0.5,   // real tier-1 via v5/market/risk-limit (per-symbol) — default used to avoid N calls
  okx:      0.5,   // real tier-1 via public/position-tiers (per-instrument) — default used likewise
  extended: 0.5,   // riskFactor model (tier-1 initial 2%); maintenance not separately public → conservative
  pacifica: 0.5,   // maintenance not exposed on /info → conservative
};

// ── low-level fetch (public, no key) ─────────────────────────────────────────────
async function fetchJson(url, opts) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Clean a numeric leverage; return null unless it's a finite cap > 1.
function cleanLev(v) {
  const n = Number(v);
  return isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
}
// Clean a maintenance-margin percent; return null unless finite and in (0, 100).
function cleanMaint(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 && n < 100 ? Math.round(n * 1e4) / 1e4 : null;
}

// ── per-venue adapters — each returns { COIN: { maxLeverage, maintenanceMarginPct, source } } ──
// One bulk call per venue (all instruments) so a refresh is a handful of requests, not N.

// Binance USDⓈ-M: public "friendly" leverage brackets. Tier with notionalFloor 0 = the
// MAX leverage tier; bracketMaintenanceMarginRate is its real tier-1 maintenance rate.
//   https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets  (verified 2026-07-11)
async function fetchBinance() {
  const d = await fetchJson('https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets');
  const arr = d && d.data && Array.isArray(d.data.brackets) ? d.data.brackets : null;
  if (!arr) return {};
  const out = {};
  for (const sym of arr) {
    const s = String(sym.symbol || '');
    if (!s.endsWith('USDT')) continue;                       // USDT-margined perps only
    const coin = s.slice(0, -4);
    const tiers = Array.isArray(sym.riskBrackets) ? sym.riskBrackets : [];
    const t1 = tiers.find(t => Number(t.bracketNotionalFloor) === 0) || tiers[0];
    if (!t1) continue;
    const maxLeverage = cleanLev(t1.maxOpenPosLeverage);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(Number(t1.bracketMaintenanceMarginRate) * 100), source: 'binance:brackets' };
  }
  return out;
}

// Bybit v5 linear instruments: leverageFilter.maxLeverage per symbol (real, public).
//   https://api.bybit.com/v5/market/instruments-info?category=linear  (verified 2026-07-11)
async function fetchBybit() {
  const d = await fetchJson('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
  const arr = d && d.result && Array.isArray(d.result.list) ? d.result.list : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const s = String(it.symbol || '');
    if (!s.endsWith('USDT')) continue;
    const coin = s.slice(0, -4);
    const maxLeverage = cleanLev(it.leverageFilter && it.leverageFilter.maxLeverage);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: DEFAULT_MAINTENANCE_PCT.bybit, source: 'bybit:instruments-info(maint~default)' };
  }
  return out;
}

// OKX SWAP instruments: `lever` = max leverage per instrument (real, public).
//   https://www.okx.com/api/v5/public/instruments?instType=SWAP  (verified 2026-07-11)
async function fetchOkx() {
  const d = await fetchJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  const arr = d && Array.isArray(d.data) ? d.data : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const id = String(it.instId || '');
    if (!id.endsWith('-USDT-SWAP')) continue;
    const coin = id.split('-')[0];
    const maxLeverage = cleanLev(it.lever);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: DEFAULT_MAINTENANCE_PCT.okx, source: 'okx:instruments(maint~default)' };
  }
  return out;
}

// Gate.io USDT futures contracts: leverage_max + maintenance_rate BOTH in one public call.
//   https://api.gateio.ws/api/v4/futures/usdt/contracts  (verified 2026-07-11)
async function fetchGateio() {
  const arr = await fetchJson('https://api.gateio.ws/api/v4/futures/usdt/contracts');
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (const it of arr) {
    const name = String(it.name || '');
    if (!name.endsWith('_USDT')) continue;
    const coin = name.slice(0, -5);
    const maxLeverage = cleanLev(it.leverage_max);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(Number(it.maintenance_rate) * 100), source: 'gateio:contracts' };
  }
  return out;
}

// Bitget USDT-M contracts: maxLever per symbol (real, public). Maintenance (keepMarginRate,
// tier-1 ≈0.4% observed) is only in the per-symbol query-position-lever call → conservative default.
//   https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES  (verified 2026-07-11)
async function fetchBitget() {
  const d = await fetchJson('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES');
  const arr = d && Array.isArray(d.data) ? d.data : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const s = String(it.symbol || '');
    if (!s.endsWith('USDT')) continue;
    const coin = s.slice(0, -4);
    const maxLeverage = cleanLev(it.maxLever);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: 0.5, source: 'bitget:contracts(maint~default 0.5%,tier1≈0.4%)' };
  }
  return out;
}

// Hyperliquid meta: universe[].maxLeverage per asset (real). Maintenance = HALF the initial
// margin at max leverage (Hyperliquid docs) = 100/(2·maxLev) — derived, not guessed.
//   POST https://api.hyperliquid.xyz/info {"type":"meta"}  (verified 2026-07-11)
async function fetchHyperliquid() {
  const d = await fetchJson('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }),
  });
  const arr = d && Array.isArray(d.universe) ? d.universe : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const coin = String(it.name || '');
    const maxLeverage = cleanLev(it.maxLeverage);
    if (!coin || maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(100 / (2 * maxLeverage)), source: 'hyperliquid:meta(maint=½ initial)' };
  }
  return out;
}

// dYdX v4 perpetual markets: initialMarginFraction + maintenanceMarginFraction (real, public).
//   https://indexer.dydx.trade/v4/perpetualMarkets  (verified 2026-07-11)
async function fetchDydx() {
  const d = await fetchJson('https://indexer.dydx.trade/v4/perpetualMarkets');
  const markets = d && d.markets && typeof d.markets === 'object' ? d.markets : null;
  if (!markets) return {};
  const out = {};
  for (const [ticker, m] of Object.entries(markets)) {
    const coin = String(ticker).split('-')[0];
    const imf = Number(m && m.initialMarginFraction);
    const mmf = Number(m && m.maintenanceMarginFraction);
    const maxLeverage = imf > 0 ? cleanLev(1 / imf) : null;
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(mmf * 100), source: 'dydx:perpetualMarkets' };
  }
  return out;
}

// Extended (StarkNet): tradingConfig.maxLeverage per market (real). Maintenance uses the
// venue's risk-factor model (tier-1 initial 2%); the maintenance rate isn't separately public
// → conservative default.
//   https://api.starknet.extended.exchange/api/v1/info/markets  (verified 2026-07-11)
async function fetchExtended() {
  const d = await fetchJson('https://api.starknet.extended.exchange/api/v1/info/markets');
  const arr = d && Array.isArray(d.data) ? d.data : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const name = String(it.name || '');
    if (!name.endsWith('-USD')) continue;
    const coin = name.slice(0, -4);
    const maxLeverage = cleanLev(it.tradingConfig && it.tradingConfig.maxLeverage);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: DEFAULT_MAINTENANCE_PCT.extended, source: 'extended:markets(maint~default)' };
  }
  return out;
}

// Lighter (zkLighter): min_initial_margin_fraction + maintenance_margin_fraction (real; units
// are ×1e4, i.e. 200 ⇒ 2% ⇒ 50× max; 120 ⇒ 1.2% maintenance).
//   https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails  (verified 2026-07-11)
async function fetchLighter() {
  const d = await fetchJson('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails');
  const arr = d && Array.isArray(d.order_book_details) ? d.order_book_details : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const coin = String(it.symbol || '');
    const minInit = Number(it.min_initial_margin_fraction);
    const maint   = Number(it.maintenance_margin_fraction);
    const maxLeverage = minInit > 0 ? cleanLev(1e4 / minInit) : null;
    if (!coin || maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(maint / 100), source: 'lighter:orderBookDetails' };
  }
  return out;
}

// Paradex: delta1_cross_margin_params.imf_base (initial margin fraction) + mmf_factor
// (maintenance = imf × mmf_factor). Both real, public.
//   https://api.prod.paradex.trade/v1/markets  (verified 2026-07-11)
async function fetchParadex() {
  const d = await fetchJson('https://api.prod.paradex.trade/v1/markets');
  const arr = d && Array.isArray(d.results) ? d.results : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const sym = String(it.symbol || '');
    if (!sym.endsWith('-USD-PERP')) continue;
    const coin = sym.split('-')[0];
    const p = it.delta1_cross_margin_params || {};
    const imf = Number(p.imf_base);
    const mmfFactor = Number(p.mmf_factor);
    const maxLeverage = imf > 0 ? cleanLev(1 / imf) : null;
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(imf * mmfFactor * 100), source: 'paradex:markets' };
  }
  return out;
}

// edgeX: riskTierList[0] (tier-1) maxLeverage + maintenanceMarginRate (real, public).
//   https://pro.edgex.exchange/api/v1/public/meta/getMetaData  (verified 2026-07-11)
async function fetchEdgex() {
  const d = await fetchJson('https://pro.edgex.exchange/api/v1/public/meta/getMetaData');
  const arr = d && d.data && Array.isArray(d.data.contractList) ? d.data.contractList : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const name = String(it.contractName || '');
    const coin = name.replace(/USDT$/, '').replace(/USD$/, '');
    const tiers = Array.isArray(it.riskTierList) ? it.riskTierList : [];
    const t1 = tiers.find(t => Number(t.tier) === 1) || tiers[0];
    if (!coin || !t1) continue;
    const maxLeverage = cleanLev(t1.maxLeverage);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(Number(t1.maintenanceMarginRate) * 100), source: 'edgex:getMetaData' };
  }
  return out;
}

// ApeX Omni: displayMaxLeverage + maintenanceMarginRate per perpetual contract (real, public).
//   https://omni.apex.exchange/api/v3/symbols  (verified 2026-07-11)
async function fetchApex() {
  const d = await fetchJson('https://omni.apex.exchange/api/v3/symbols');
  const arr = d && d.data && d.data.contractConfig && Array.isArray(d.data.contractConfig.perpetualContract)
    ? d.data.contractConfig.perpetualContract : null;
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const sym = String(it.symbol || it.crossSymbolName || '');
    if (!/-USDT$/.test(sym)) continue;
    const coin = sym.split('-')[0];
    const maxLeverage = cleanLev(it.displayMaxLeverage);
    if (maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: cleanMaint(Number(it.maintenanceMarginRate) * 100), source: 'apex:symbols' };
  }
  return out;
}

// Pacifica: /info exposes max_leverage per market (real). Maintenance not exposed → conservative default.
//   https://api.pacifica.fi/api/v1/info  (verified 2026-07-11)
async function fetchPacifica() {
  const d = await fetchJson('https://api.pacifica.fi/api/v1/info');
  const arr = Array.isArray(d && d.data) ? d.data : (d && d.data && Array.isArray(d.data.markets) ? d.data.markets : null);
  if (!arr) return {};
  const out = {};
  for (const it of arr) {
    const coin = String(it.symbol || it.market || '');
    const maxLeverage = cleanLev(it.max_leverage);
    if (!coin || maxLeverage == null) continue;
    out[coin] = { maxLeverage, maintenanceMarginPct: DEFAULT_MAINTENANCE_PCT.pacifica, source: 'pacifica:info(maint~default)' };
  }
  return out;
}

// Venues WITHOUT a free public per-asset max-leverage endpoint → intentionally absent, so
// getCap() returns null (honest "—", never a fabricated cap):
//   • aster  — leverageBracket is auth-only (-2014 API-key); exchangeInfo requiredMarginPercent
//              is a fixed 5% placeholder, NOT the real per-asset max → null.
//   • grvt   — instruments payload carries no leverage/margin field → null.
const VENUE_FETCHERS = {
  binance:     fetchBinance,
  bybit:       fetchBybit,
  okx:         fetchOkx,
  gateio:      fetchGateio,
  bitget:      fetchBitget,
  hyperliquid: fetchHyperliquid,
  dydx:        fetchDydx,
  extended:    fetchExtended,
  lighter:     fetchLighter,
  paradex:     fetchParadex,
  edgex:       fetchEdgex,
  apex:        fetchApex,
  pacifica:    fetchPacifica,
};

/** Whether a venue has a real public source (used for logging/introspection). */
function isVenueSupported(venue) {
  return Object.prototype.hasOwnProperty.call(VENUE_FETCHERS, String(venue || '').toLowerCase());
}

// ── cache (data/leverage-caps.json, gitignored, atomic write) ─────────────────────
function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c && typeof c === 'object' && c.venues ? c : { updatedAt: 0, venues: {} };
  } catch { return { updatedAt: 0, venues: {} }; }
}

function writeCache(cache) {
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

/**
 * getCap(cache, venue, coin) → { maxLeverage, maintenanceMarginPct, source }.
 * Always returns the shape; maxLeverage/maintenanceMarginPct are null when unknown (honest).
 */
function getCap(cache, venue, coin) {
  const v = cache && cache.venues && cache.venues[String(venue || '').toLowerCase()];
  const c = v && v.caps && v.caps[String(coin || '').toUpperCase()];
  if (c && typeof c === 'object') {
    return {
      maxLeverage:          typeof c.maxLeverage === 'number' ? c.maxLeverage : null,
      maintenanceMarginPct: typeof c.maintenanceMarginPct === 'number' ? c.maintenanceMarginPct : null,
      source:               typeof c.source === 'string' ? c.source : null,
    };
  }
  return { maxLeverage: null, maintenanceMarginPct: null, source: null };
}

/**
 * refreshCaps(venuesNeeded, { ttlMs, now, log }) → cache.
 * Refreshes (in parallel) only the requested venues whose cached map is missing or older than
 * ttlMs. Unsupported venues are skipped (they stay honestly absent → null caps). Persists the
 * updated cache atomically and returns it. A venue whose fetch fails keeps its prior (possibly
 * empty) map — never overwritten with a fabricated one.
 */
async function refreshCaps(venuesNeeded, opts) {
  const ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL_MS;
  const now   = (opts && opts.now)   || Date.now();
  const log   = (opts && opts.log)   || (() => {});
  const cache = readCache();
  if (!cache.venues) cache.venues = {};

  const wanted = Array.from(new Set((venuesNeeded || []).map(v => String(v || '').toLowerCase())))
    .filter(v => isVenueSupported(v));

  const stale = wanted.filter(v => {
    const entry = cache.venues[v];
    return !entry || !entry.fetchedAt || (now - entry.fetchedAt) > ttlMs;
  });
  if (stale.length === 0) return cache;

  await Promise.all(stale.map(async (venue) => {
    try {
      const caps = await VENUE_FETCHERS[venue]();
      const count = Object.keys(caps || {}).length;
      if (count > 0) {
        cache.venues[venue] = { fetchedAt: now, caps };
        log(`leverage-caps ${venue}: ${count} assets`);
      } else {
        // Keep any prior good map; only stamp the attempt so we don't hammer a flaky endpoint.
        cache.venues[venue] = cache.venues[venue] && cache.venues[venue].caps
          ? { ...cache.venues[venue], fetchedAt: now }
          : { fetchedAt: now, caps: {} };
        log(`leverage-caps ${venue}: 0 assets (kept prior, honest)`);
      }
    } catch (e) {
      log(`leverage-caps ${venue}: error ${e && e.message}`);
    }
  }));

  cache.updatedAt = now;
  try { writeCache(cache); } catch (e) { log(`leverage-caps write error: ${e && e.message}`); }
  return cache;
}

module.exports = {
  CACHE_FILE,
  DEFAULT_TTL_MS,
  DEFAULT_MAINTENANCE_PCT,
  VENUE_FETCHERS,
  isVenueSupported,
  readCache,
  writeCache,
  getCap,
  refreshCaps,
};
