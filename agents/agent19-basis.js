#!/usr/bin/env node
// agent19-basis.js — Cash-and-carry / basis scanner
// Covers: Binance COIN-M, Binance USDT-M, Bybit USDT-M, Kraken FF (flexible futures), OKX, Deribit for BTC/ETH/BNB.
// Applies the 7 filters from Step-1 analysis. Zero Claude, read-only, free.
// v2: executable prices (long spot @ spotAsk, short future @ futureBid).
//     Indicative mid/last values preserved as indicativeBasisPct / netAnnualizedIndicative.
//     No bid/ask → contract excluded; no fallback to mid.
'use strict';

const fs    = require('fs');
const { httpGet: _sharedGet } = require('../lib/httpGet');

// ── CONFIG ─────────────────────────────────────────────────────────────────────
const REFRESH_MS    = 5 * 60_000;
const STARTUP_DELAY = 10_000;
const OUTPUT_FILE   = '/tmp/basis-opportunities.json';
const SPOT_FILE     = '/tmp/exchange-prices.json';

const MIN_DAYS       = 20;      // filter 1: too-near-expiry
const MIN_VOL_STRICT = 500_000; // USD — DEEP/OK tier
const MIN_VOL_THIN   = 100_000; // USD — THIN tier (flag, don't exclude)
const BNB_MAX_CAP    = 50_000;  // filter: BNB capacity hard cap
const CAP_VOL_F      = 0.05;    // capacity = 5% of vol24
const CAP_OI_F       = 0.02;    // capacity = 2% of OI (take min)
const MAX_CAP        = 500_000; // USD, any single opportunity

// TRUE round-trip taker fees — the carry is a 4-FILL trip:
//   1) spot open  (Binance taker ~0.10%)
//   2) future open (venue taker)
//   3) future close / delivery (~free)
//   4) spot close  (Binance taker ~0.10%)   ← previously MISSING
// The future cash-settles at index (USD for USDTM/Bybit/Kraken, in-coin for
// COIN-M/OKX/Deribit inverse) — either way you finish holding the spot leg, so
// realizing a USD basis return REQUIRES selling that spot (~0.10% Binance taker).
// Omitting it understated fees by ~0.10% and over-stated net. Spot is bought AND
// sold on Binance for every venue, so the close leg is a flat 0.0010 across the board.
// bidSpreadPct is NOT subtracted here — it is already baked into the executable leg prices.
const FEES = {
  COINM:   0.00265,  // spot open 0.10% + COIN-M futures 0.05% + delivery 0.015% + spot close 0.10%
  USDTM:   0.00240,  // spot open 0.10% + USDT-M futures 0.04% + spot close 0.10%
  BYBIT:   0.00255,  // spot open 0.10% + Bybit USDT-M linear futures taker 0.055% + spot close 0.10%; delivery ~0
  KRAKEN:  0.00250,  // spot open 0.10% + Kraken Futures taker 0.05% (flexible futures) + spot close 0.10%; delivery ~0
  OKX:     0.00250,  // spot open 0.10% + OKX futures 0.05% + spot close 0.10%
  DERIBIT: 0.00250,  // spot open 0.10% + Deribit futures 0.05% + spot close 0.10%
};

// Per-leg breakdown of the round-trip taker fee above (display only — the UI shows
// "0.155% round-trip (Binance spot 0.10% + Bybit taker 0.055%)"). Each list SUMS
// EXACTLY to FEES[venueKey]; keep it in lockstep with FEES. Never re-summed into
// math — FEES is the single number the basis calc subtracts.
const FEE_LEGS = {
  COINM:   [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'COIN-M futures',  pct: 0.0005 }, { label: 'delivery', pct: 0.00015 }, { label: 'Binance spot close', pct: 0.0010 }],
  USDTM:   [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'USDT-M futures',  pct: 0.0004 }, { label: 'Binance spot close', pct: 0.0010 }],
  BYBIT:   [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'Bybit taker',     pct: 0.00055 }, { label: 'Binance spot close', pct: 0.0010 }],
  KRAKEN:  [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'Kraken taker',    pct: 0.0005 }, { label: 'Binance spot close', pct: 0.0010 }],
  OKX:     [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'OKX futures',     pct: 0.0005 }, { label: 'Binance spot close', pct: 0.0010 }],
  DERIBIT: [{ label: 'Binance spot open',  pct: 0.0010 }, { label: 'Deribit futures', pct: 0.0005 }, { label: 'Binance spot close', pct: 0.0010 }],
};

// Binance COIN-M: contract size in USD
const COINM_CSZ = { BTC: 100, ETH: 10, SOL: 10, XRP: 10, BNB: 10 };

const MONTH_IDX = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

const DISCLAIMER =
  'Basis return is LOCKED only if held to contract expiry on the same exchange. ' +
  'Early exit re-buys the future at an unknown price — locked return disappears. ' +
  'COIN-M (Binance), BTC-USD (OKX): P&L settles in the coin, not USDT. ' +
  'USD return drifts with spot — NOT a clean locked-USD return. ' +
  'Only USDT-M linear quarterlies (Binance & Bybit, BTCUSDT/ETHUSDT) give a clean locked-USDT return. ' +
  'Exchange / counterparty risk over the full hold period. Not financial advice.';

// ── HTTP ───────────────────────────────────────────────────────────────────────
function get(url, ms = 14_000) { return _sharedGet(url, { timeoutMs: ms }); }

function atomicWrite(path, obj) {
  const tmp = path + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Expiry parsers ─────────────────────────────────────────────────────────────

// BTCUSD_260925 → {asset:'BTC', expiry:Date}
function parseBinanceSym(sym, isUSDTM = false) {
  const re = isUSDTM
    ? /^([A-Z]+)USDT_(\d{6})$/
    : /^([A-Z]+)USD_(\d{6})$/;
  const m = sym.match(re);
  if (!m) return null;
  const ymd = m[2];
  const yr = 2000 + parseInt(ymd.slice(0, 2));
  const mo = parseInt(ymd.slice(2, 4)) - 1;
  const dy = parseInt(ymd.slice(4, 6));
  return { asset: m[1], expiry: new Date(Date.UTC(yr, mo, dy, 8, 0, 0)) };
}

// BTC-USD-260925 → {asset:'BTC', expiry:Date}
function parseOKXSym(instId) {
  const parts = instId.split('-');
  if (parts.length !== 3) return null;
  if (parts[1] !== 'USD') return null;
  const ymd = parts[2];
  if (!/^\d{6}$/.test(ymd)) return null;
  const yr = 2000 + parseInt(ymd.slice(0, 2));
  const mo = parseInt(ymd.slice(2, 4)) - 1;
  const dy = parseInt(ymd.slice(4, 6));
  return { asset: parts[0], expiry: new Date(Date.UTC(yr, mo, dy, 8, 0, 0)) };
}

// BTC-25SEP26 → {asset:'BTC', expiry:Date}
function parseDeribitSym(name) {
  const m = name.match(/^([A-Z]+)-(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const mon = MONTH_IDX[m[3]];
  if (mon === undefined) return null;
  const yr  = 2000 + parseInt(m[4]);
  const dy  = parseInt(m[2]);
  return { asset: m[1], expiry: new Date(Date.UTC(yr, mon, dy, 8, 0, 0)) };
}

// ── Capacity + tier ────────────────────────────────────────────────────────────

function tier(vol24Usd, oiUsd) {
  if (vol24Usd >= MIN_VOL_STRICT && (!oiUsd || oiUsd >= 10_000_000)) return 'DEEP';
  if (vol24Usd >= MIN_VOL_STRICT) return 'OK';
  if (vol24Usd >= MIN_VOL_THIN)   return 'THIN';
  return 'VERY THIN';
}

function capacity(vol24Usd, oiUsd, asset) {
  const fromVol = vol24Usd * CAP_VOL_F;
  const fromOI  = oiUsd  ? oiUsd * CAP_OI_F : fromVol;
  let cap = Math.min(fromVol, fromOI, MAX_CAP);
  if (asset === 'BNB') cap = Math.min(cap, BNB_MAX_CAP);
  return Math.round(cap);
}

// ── Contract builder ───────────────────────────────────────────────────────────
//
// Executable basis: long spot @ spotAsk, short dated future @ futureBid.
// If either price is missing/zero the contract is excluded — no mid fallback.
// Fee constants subtract exchange taker fees per leg; bid/ask spread is NOT
// also subtracted (it is already embedded in the executable leg prices above).
// Annualization: basis × 365/daysToExpiry — correct for dated delivery futures
// (no 8-hour funding reset; expiry is the single settlement horizon).

function buildContract({ asset, exchange, venueKey, contract,
                          spotMid, spotBid, spotAsk,
                          futureLast, futureBid, futureAsk,
                          expiryMs, vol24Usd, oiUsd, capacityUsdOverride }) {
  const now = Date.now();

  // Filter 0 (honest-engine): an EXPIRED or unparseable-expiry dated future is a
  // fabricated instrument — its "locked to expiry" return no longer exists. Exclude
  // before any basis math. This also plugs the NaN hole: NaN < MIN_DAYS is false, so a
  // bad expiryMs would otherwise slip past filter 1. Never roll onto an expired leg.
  if (!Number.isFinite(expiryMs) || expiryMs <= now) return null;

  const daysToExpiry = (expiryMs - now) / 86_400_000;

  // Filter 1: daysToExpiry < MIN_DAYS
  if (daysToExpiry < MIN_DAYS) return null;

  // Require real bid/ask on both future legs — book-midpoint indicative needs both;
  // no fallback to last/mark. Spot bid/ask already guaranteed by fetchSpot bookTicker.
  if (!spotAsk || spotAsk <= 0 || !futureBid || futureBid <= 0 || !futureAsk || futureAsk <= 0) return null;

  // Book midpoint for future — structural guarantee: futureMidBook >= futureBid and
  // spotMid <= spotAsk, so indicative >= executable by construction.
  const futureMidBook = (futureBid + futureAsk) / 2;

  // ── Indicative basis (book midpoint) ──────────────────────────────────────
  const indicativeBasisPct      = (futureMidBook - spotMid) / spotMid;
  const grossAnnualized         = indicativeBasisPct * 365 / daysToExpiry;
  const fee                     = FEES[venueKey] || 0.002;
  const netAnnualizedIndicative = (indicativeBasisPct - fee) * 365 / daysToExpiry;

  // ── Executable basis (long spot @ ask, short future @ bid) ───────────────
  const executableBasisPct      = (futureBid - spotAsk) / spotAsk;
  const grossAnnualizedExec     = executableBasisPct * 365 / daysToExpiry;
  // fee subtracted once (taker open on each leg); spread already baked into prices above
  const netAnnualizedExecutable = (executableBasisPct - fee) * 365 / daysToExpiry;

  // bidSpreadPct on future leg — informational only; already baked into executable
  const bidSpreadPct = (futureBid > 0 && futureAsk && futureAsk > 0)
    ? (futureAsk - futureBid) / futureBid
    : null;

  // Backwardation signal (filter 5) — determined from executable basis
  if (executableBasisPct < 0) {
    if (vol24Usd < MIN_VOL_THIN) return null;
    return {
      type:               'backwardation',
      asset,
      exchange,
      contract,
      expiry:             new Date(expiryMs).toISOString().slice(0, 10),
      daysToExpiry:       Math.round(daysToExpiry),
      // Book-mid prices (used for indicative)
      spot:               round2(spotMid),
      future:             round2(futureMidBook),
      futureLast:         futureLast > 0 ? round2(futureLast) : null,
      // Executable leg prices
      spotBid:            spotBid != null ? round2(spotBid) : null,
      spotAsk:            round2(spotAsk),
      futureBid:          round2(futureBid),
      futureAsk:          round2(futureAsk),
      // Basis
      indicativeBasisPct: round4(indicativeBasisPct),
      executableBasisPct: round4(executableBasisPct),
      basis:              round4(indicativeBasisPct),  // backward-compat alias
      annualized:         round4(grossAnnualizedExec), // executable-based for display
      vol24Usd:           Math.round(vol24Usd),
      signal: `${asset} futures trade BELOW spot. Likely staking/yield exceeds risk-free rate. ` +
              `Reverse carry (short spot + long future) collects the basis but requires borrowing ${asset}.`,
    };
  }

  // Filter 2: volume threshold (VERY THIN → exclude from C&C)
  const t = tier(vol24Usd, oiUsd);
  if (t === 'VERY THIN') return null;

  // Filter 3: net annualized must be > 0 — checked on EXECUTABLE basis (conservative)
  if (netAnnualizedExecutable <= 0) return null;

  // Filter 6: coin-margined disclaimer
  const coinMargined = ['COINM', 'OKX', 'DERIBIT'].includes(venueKey);
  const coinMarginedNote = coinMargined
    ? venueKey === 'DERIBIT'
      ? `Inverse/reversed — P&L settles in ${asset}, not USD. USD return drifts with spot; not a clean locked-USD return.`
      : `Coin-margined — P&L settles in ${asset}. USD return drifts with spot price; not a clean locked-USD return.`
    : null;

  // Filter 7: capacity estimate. A venue may pass a REAL order-book-depth capacity
  // (capacityUsdOverride, e.g. Bybit book-walk) — honest-engine: use it verbatim
  // (already MAX_CAP/asset-capped by the caller) instead of the vol/OI proxy. Venues
  // that don't pass it keep the existing vol/OI estimate unchanged (zero regression).
  const hasRealBookDepth = Number.isFinite(capacityUsdOverride);
  const cap = hasRealBookDepth
    ? capacityUsdOverride
    : capacity(vol24Usd, oiUsd, asset);
  // capacitySource — honest provenance of `cap`, so the cashable/speculative gate can
  // key on real executability: 'book' = measured order-book depth within the slip band
  // (directly fillable); 'proxy' = vol/OI estimate (liquidity inferred, not a real book).
  const capacitySource = hasRealBookDepth ? 'book' : 'proxy';
  const expiryDate = new Date(expiryMs).toISOString().slice(0, 10);

  // Headline verdict uses executable (conservative) number
  const verdict = coinMargined
    ? `Net +${(netAnnualizedExecutable * 100).toFixed(2)}%/yr executable. Coin-settled — USD return not locked.`
    : `Locked +${(netAnnualizedExecutable * 100).toFixed(2)}%/yr executable if held to ${expiryDate}. Cash-settled.`;

  return {
    type:                    'contango',
    asset,
    exchange,
    venueKey,
    contract,
    expiry:                  expiryDate,
    daysToExpiry:            Math.round(daysToExpiry),
    // Book-mid prices (used for indicative); futureLast is last/mark, display only
    spot:                    round2(spotMid),
    future:                  round2(futureMidBook),
    futureLast:              futureLast > 0 ? round2(futureLast) : null,
    // Executable leg prices
    spotBid:                 spotBid != null ? round2(spotBid) : null,
    spotAsk:                 round2(spotAsk),
    futureBid:               round2(futureBid),
    futureAsk:               round2(futureAsk),
    // Basis values
    indicativeBasisPct:      round4(indicativeBasisPct),
    executableBasisPct:      round4(executableBasisPct),
    basis:                   round4(indicativeBasisPct),   // backward-compat alias
    // Annualized returns (annualization: × 365/daysToExpiry; correct for dated futures)
    grossAnnualized:         round4(grossAnnualized),
    grossAnnualizedExec:     round4(grossAnnualizedExec),
    fee,
    feeLegs:                 FEE_LEGS[venueKey] || null,   // per-leg breakdown; sums to fee
    netAnnualizedIndicative: round4(netAnnualizedIndicative),
    netAnnualizedExecutable: round4(netAnnualizedExecutable),
    netAnnualized:           round4(netAnnualizedExecutable), // headline = executable
    // Market quality
    vol24Usd:                Math.round(vol24Usd),
    oiUsd:                   oiUsd ? Math.round(oiUsd) : null,
    capacityUsd:             cap,
    capacitySource,
    tier:                    t,
    thinFlag:                t === 'THIN',
    coinMargined,
    coinMarginedNote,
    bidSpreadPct:            bidSpreadPct ? round4(bidSpreadPct) : null,
    verdict,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ── Spot prices ────────────────────────────────────────────────────────────────
// Uses bookTicker to get executable bid/ask on spot leg.
// Fallback (file) provides mid only — bid/ask = null → contracts excluded.

async function fetchSpot() {
  try {
    const syms = encodeURIComponent('["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]');
    const res  = await get(`https://api.binance.com/api/v3/ticker/bookTicker?symbols=${syms}`);
    const out  = {};
    for (const { symbol, bidPrice, askPrice } of (res.data || [])) {
      const asset = symbol.replace('USDT', '');
      const bid   = parseFloat(bidPrice);
      const ask   = parseFloat(askPrice);
      out[asset]  = { bid, ask, mid: (bid + ask) / 2 };
    }
    return out;
  } catch (e) {
    console.warn('[basis] spot bookTicker failed — bid/ask unavailable:', e.message);
    // File fallback: mid only; bid/ask=null means no executable contracts this cycle
    try {
      const raw = JSON.parse(fs.readFileSync(SPOT_FILE, 'utf8'));
      const b   = raw.exchanges?.binance || {};
      const out = {};
      for (const [asset, info] of Object.entries(b)) {
        if (info?.price) out[asset] = { bid: null, ask: null, mid: info.price };
      }
      return out;
    } catch { return {}; }
  }
}

// ── Binance COIN-M ────────────────────────────────────────────────────────────

async function fetchCOINM(spot) {
  // Fetch 24hr ticker (volume/lastPrice) and bookTicker (bid/ask) in parallel
  const [res, btRes] = await Promise.all([
    get('https://dapi.binance.com/dapi/v1/ticker/24hr'),
    get('https://dapi.binance.com/dapi/v1/ticker/bookTicker'),
  ]);
  if (res.status !== 200 || !Array.isArray(res.data)) return [];

  // Build bid/ask map from bookTicker
  const btMap = {};
  for (const x of (Array.isArray(btRes.data) ? btRes.data : [])) {
    const bid = parseFloat(x.bidPrice || 0);
    const ask = parseFloat(x.askPrice || 0);
    if (bid > 0 && ask > 0) btMap[x.symbol] = { bid, ask };
  }

  // Filter: dated (has _), not PERP
  const dated = res.data.filter(x => x.symbol.includes('_') && !x.symbol.includes('PERP'));

  // Fetch OI in parallel for qualifying contracts
  const oiRes = await Promise.allSettled(
    dated.map(x => get(`https://dapi.binance.com/dapi/v1/openInterest?symbol=${x.symbol}`))
  );
  const oiMap = {};
  for (let i = 0; i < dated.length; i++) {
    const r = oiRes[i];
    if (r.status === 'fulfilled' && r.value.data?.openInterest) {
      oiMap[dated[i].symbol] = parseFloat(r.value.data.openInterest);
    }
  }

  const results = [];
  for (const x of dated) {
    const parsed = parseBinanceSym(x.symbol, false);
    if (!parsed) continue;
    const { asset, expiry } = parsed;

    const sp = spot[asset];
    if (!sp?.mid) continue;

    // Filter: only BTC, ETH, BNB, SOL per decision matrix
    if (!['BTC', 'ETH', 'BNB', 'SOL'].includes(asset)) continue;

    const csz      = COINM_CSZ[asset] ?? 10;
    const vol24Usd = parseFloat(x.volume || 0) * csz;
    const oiContr  = oiMap[x.symbol] ?? 0;
    const oiUsd    = oiContr * csz;
    const bt       = btMap[x.symbol];

    const c = buildContract({
      asset,
      exchange:  'Binance COIN-M',
      venueKey:  'COINM',
      contract:  x.symbol,
      spotMid:   sp.mid,
      spotBid:   sp.bid,
      spotAsk:   sp.ask,
      futureLast: parseFloat(x.lastPrice || 0),
      futureBid:  bt?.bid ?? null,
      futureAsk:  bt?.ask ?? null,
      expiryMs:   expiry.getTime(),
      vol24Usd,
      oiUsd,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Binance USDT-M ────────────────────────────────────────────────────────────

async function fetchUSDTM(spot) {
  // Fetch 24hr ticker (volume/lastPrice) and bookTicker (bid/ask) in parallel
  const [res, btRes] = await Promise.all([
    get('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    get('https://fapi.binance.com/fapi/v1/ticker/bookTicker'),
  ]);
  if (res.status !== 200 || !Array.isArray(res.data)) return [];

  const btMap = {};
  for (const x of (Array.isArray(btRes.data) ? btRes.data : [])) {
    const bid = parseFloat(x.bidPrice || 0);
    const ask = parseFloat(x.askPrice || 0);
    if (bid > 0 && ask > 0) btMap[x.symbol] = { bid, ask };
  }

  // Only quarterly dated contracts (symbol has _ and no PERP)
  const dated = res.data.filter(x => x.symbol.includes('_') && !x.symbol.includes('PERP'));

  // Fetch OI for qualifying contracts
  const oiRes = await Promise.allSettled(
    dated.map(x => get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${x.symbol}`))
  );
  const oiMap = {};
  for (let i = 0; i < dated.length; i++) {
    const r = oiRes[i];
    if (r.status === 'fulfilled' && r.value.data?.openInterest) {
      const sym    = dated[i].symbol;
      const parsed = parseBinanceSym(sym, true);
      if (parsed) {
        const oiAsset = parseFloat(r.value.data.openInterest);
        const spMid   = spot[parsed.asset]?.mid ?? 0;
        oiMap[sym]    = oiAsset * spMid;
      }
    }
  }

  const results = [];
  for (const x of dated) {
    const parsed = parseBinanceSym(x.symbol, true);
    if (!parsed) continue;
    const { asset, expiry } = parsed;

    // Only BTC, ETH per decision matrix
    if (!['BTC', 'ETH'].includes(asset)) continue;
    const sp = spot[asset];
    if (!sp?.mid) continue;

    // quoteVolume for USDT-M is in USDT (USD)
    const vol24Usd = parseFloat(x.quoteVolume || 0);
    const oiUsd    = oiMap[x.symbol] ?? null;
    const bt       = btMap[x.symbol];

    const c = buildContract({
      asset,
      exchange:  'Binance USDT-M',
      venueKey:  'USDTM',
      contract:  x.symbol,
      spotMid:   sp.mid,
      spotBid:   sp.bid,
      spotAsk:   sp.ask,
      futureLast: parseFloat(x.lastPrice || 0),
      futureBid:  bt?.bid ?? null,
      futureAsk:  bt?.ask ?? null,
      expiryMs:   expiry.getTime(),
      vol24Usd,
      oiUsd,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Bybit (USDT-M linear dated) ─────────────────────────────────────────────
//
// Bybit v5 tickers (category=linear) returns perpetuals AND dated futures in one
// payload. Dated futures carry a `-DDMMMYY` symbol suffix (BTCUSDT-25SEP26), a
// non-empty deliveryTime (ms epoch), an empty fundingRate (no funding — pure
// delivery basis, verified) and deliveryFeeRate 0. They settle in USDT — a clean
// locked-USDT return, same class as Binance USDT-M (NOT coin-margined). bid1Price/
// ask1Price are the executable book top; turnover24h is already USD volume; expiry
// comes straight from deliveryTime, so no symbol-date parsing is needed.
//
// Honest-engine: capacity is REAL order-book depth only, NEVER OI. We short the
// dated future, which fills into the BID side, so we book-walk each candidate's bid
// ladder (v5 market/orderbook) and sum notional within a 0.5% slippage band. OI is
// not passed at all (oiUsd:null) — it never touches capacity, tier, or display.

// Order-book depth in USD: walk levels from the top, summing price×size while the
// level price stays within `slipTol` of the best. Bybit levels are [price, size]
// strings, size in base coin. Capped at MAX_CAP. Never uses OI.
function bookDepthUsd(levels, slipTol) {
  if (!Array.isArray(levels) || levels.length === 0) return 0;
  const best = parseFloat(levels[0][0]);
  if (!(best > 0)) return 0;
  let usd = 0;
  for (const lvl of levels) {
    const price = parseFloat(lvl[0]);
    const size  = parseFloat(lvl[1]);
    if (!(price > 0) || !(size > 0)) continue;
    if (Math.abs(best - price) / best > slipTol) break;   // beyond the slippage band
    usd += price * size;
    if (usd >= MAX_CAP) return MAX_CAP;
  }
  return Math.round(usd);
}

async function fetchBybit(spot) {
  const res  = await get('https://api.bybit.com/v5/market/tickers?category=linear');
  const list = res.data?.result?.list;
  if (!Array.isArray(list)) return [];

  const now = Date.now();

  // Pre-filter dated BTC/ETH contracts that could qualify, so we only book-walk
  // (one orderbook call each) the ones actually worth pricing.
  const candidates = [];
  for (const x of list) {
    const sym = x.symbol || '';
    const m   = sym.match(/^([A-Z]+)USDT-\d{2}[A-Z]{3}\d{2}$/);  // dated only; skips perps
    if (!m) continue;
    const asset = m[1];
    if (!['BTC', 'ETH'].includes(asset)) continue;               // decision matrix (matches USDT-M)
    if (!spot[asset]?.mid) continue;
    const expiryMs = parseInt(x.deliveryTime || '0', 10);
    if (!Number.isFinite(expiryMs) || expiryMs <= now) continue;
    if ((expiryMs - now) / 86_400_000 < MIN_DAYS) continue;      // filter 1: too near (skip weeklies)
    const vol24Usd = parseFloat(x.turnover24h || 0);             // already USD
    if (vol24Usd < MIN_VOL_THIN) continue;                       // filter 2: VERY THIN never qualifies
    candidates.push({ x, asset, sym, expiryMs, vol24Usd });
  }

  // Real order-book depth for capacity — one orderbook call per candidate, in parallel.
  const bookRes = await Promise.allSettled(
    candidates.map(c => get(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${c.sym}&limit=50`))
  );

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const { x, asset, sym, expiryMs, vol24Usd } = candidates[i];
    const sp  = spot[asset];
    const bid = parseFloat(x.bid1Price || 0);
    const ask = parseFloat(x.ask1Price || 0);

    // Short-the-future leg fills into the BID side → capacity = bid-side depth. Never OI.
    const r    = bookRes[i];
    const bids = (r.status === 'fulfilled' ? r.value.data?.result?.b : null) || [];
    const capacityUsd = bookDepthUsd(bids, 0.005);
    if (capacityUsd <= 0) continue;   // no real book depth → no honest capacity → skip

    const c = buildContract({
      asset,
      exchange:  'Bybit USDT-M',
      venueKey:  'BYBIT',
      contract:  sym,
      spotMid:   sp.mid,
      spotBid:   sp.bid,
      spotAsk:   sp.ask,
      futureLast: parseFloat(x.markPrice || x.lastPrice || 0),
      futureBid:  bid > 0 ? bid : null,
      futureAsk:  ask > 0 ? ask : null,
      expiryMs,
      vol24Usd,
      oiUsd:               null,          // never OI for Bybit
      capacityUsdOverride: capacityUsd,   // REAL order-book depth (book-walk)
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Kraken Futures (FF_ flexible futures — linear, USD-quoted, cash-settled) ────
//
// Kraken has two dated families: FI_ (futures_inverse, coin-settled, and currently
// dead — no bid/ask, 0 vol) and FF_ (flexible_futures, linear USD-quoted, cash-
// settled). Only FF_ is a clean locked-USD lane (the Bybit/USDT-M analog); FI_ is
// SKIPPED entirely. Symbol: FF_XBTUSD_260925 → XBT=BTC, USD quote, YYMMDD expiry.
// contractSize is 1 unit of the base coin, so price×size is USD notional directly.
//
// Honest-engine: capacity is REAL order-book depth only, NEVER OI. Shorting the
// dated future fills into the BID side, so we book-walk the bid ladder within a
// 0.5% band. CAUTION: Kraken's /orderbook returns bids in ASCENDING price order
// (best/highest bid is LAST), so we sort descending before the walk — otherwise the
// book-walk would anchor on a stale far-below-market bid. oiUsd is never passed.
const KRAKEN_ASSET = { XBT: 'BTC', ETH: 'ETH' };

async function fetchKraken(spot) {
  const [instRes, tickRes] = await Promise.all([
    get('https://futures.kraken.com/derivatives/api/v3/instruments'),
    get('https://futures.kraken.com/derivatives/api/v3/tickers'),
  ]);

  // Allowlist: tradeable flexible_futures only (skips FI_ inverse, PF_/PI_ perps).
  const tradeable = new Set();
  for (const i of (instRes.data?.instruments || [])) {
    if (i.type === 'flexible_futures' && i.tradeable) tradeable.add(String(i.symbol).toUpperCase());
  }

  const tickers = tickRes.data?.tickers || [];
  const now = Date.now();

  // Pre-filter dated FF_ BTC/ETH contracts worth pricing, then book-walk each.
  const candidates = [];
  for (const t of tickers) {
    const sym = String(t.symbol || '').toUpperCase();
    const m   = sym.match(/^FF_([A-Z]+)USD_(\d{6})$/);            // FF_ dated only
    if (!m) continue;
    if (!tradeable.has(sym)) continue;                            // tradeable flexible_futures only
    const asset = KRAKEN_ASSET[m[1]];
    if (!asset || !['BTC', 'ETH'].includes(asset)) continue;      // decision matrix (matches Bybit)
    if (!spot[asset]?.mid) continue;

    const ymd = m[2];
    const expiry = new Date(Date.UTC(2000 + parseInt(ymd.slice(0, 2)), parseInt(ymd.slice(2, 4)) - 1, parseInt(ymd.slice(4, 6)), 16, 0, 0));
    const expiryMs = expiry.getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= now) continue;
    if ((expiryMs - now) / 86_400_000 < MIN_DAYS) continue;       // filter 1: too near

    const mark      = parseFloat(t.markPrice || 0);
    const vol24Usd  = parseFloat(t.vol24h || 0) * mark;           // vol24h is in contracts (=coin); ×mark → USD
    if (vol24Usd < MIN_VOL_THIN) continue;                        // filter 2: VERY THIN never qualifies
    candidates.push({ t, asset, sym, expiryMs, vol24Usd, mark });
  }

  // Real order-book depth for capacity — one orderbook call per candidate, in parallel.
  const bookRes = await Promise.allSettled(
    candidates.map(c => get(`https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=${c.sym}`))
  );

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const { t, asset, sym, expiryMs, vol24Usd, mark } = candidates[i];
    const sp  = spot[asset];
    const bid = parseFloat(t.bid || 0);
    const ask = parseFloat(t.ask || 0);

    // Short-the-future leg fills into the BID side → capacity = bid-side depth. Kraken
    // bids are ascending (best last), so sort descending so bookDepthUsd anchors on the
    // real best bid. Levels are [price, size] with size in the base coin. Never OI.
    const r = bookRes[i];
    const rawBids = (r.status === 'fulfilled' ? r.value.data?.orderBook?.bids : null) || [];
    const bids = rawBids.slice().sort((a, b) => b[0] - a[0]);
    const capacityUsd = bookDepthUsd(bids, 0.005);
    if (capacityUsd <= 0) continue;   // no real book depth → no honest capacity → skip

    const c = buildContract({
      asset,
      exchange:  'Kraken FF',
      venueKey:  'KRAKEN',
      contract:  sym,
      spotMid:   sp.mid,
      spotBid:   sp.bid,
      spotAsk:   sp.ask,
      futureLast: mark > 0 ? mark : null,
      futureBid:  bid > 0 ? bid : null,
      futureAsk:  ask > 0 ? ask : null,
      expiryMs,
      vol24Usd,
      oiUsd:               null,          // never OI for Kraken
      capacityUsdOverride: capacityUsd,   // REAL order-book depth (book-walk)
    });
    if (c) results.push(c);
  }
  return results;
}

// ── OKX ───────────────────────────────────────────────────────────────────────

async function fetchOKX(spot) {
  // tickers payload includes last, bidPx, askPx — no extra bookTicker call needed
  const [tickRes, oiBtc, oiEth] = await Promise.all([
    get('https://www.okx.com/api/v5/market/tickers?instType=FUTURES'),
    get('https://www.okx.com/api/v5/public/open-interest?instType=FUTURES&uly=BTC-USD'),
    get('https://www.okx.com/api/v5/public/open-interest?instType=FUTURES&uly=ETH-USD'),
  ]);

  // Build OI map (oiCcy = in coin, multiply by spot mid for USD)
  const oiMap = {};
  for (const [oiData, asset] of [[oiBtc, 'BTC'], [oiEth, 'ETH']]) {
    for (const x of (oiData.data?.data || [])) {
      const spMid = spot[asset]?.mid ?? 0;
      oiMap[x.instId] = parseFloat(x.oiCcy || 0) * spMid;
    }
  }

  const results = [];
  for (const x of (tickRes.data?.data || [])) {
    const instId = x.instId;
    // Filter 4: exclude _UM and XPERP contracts
    if (instId.includes('_UM') || instId.includes('XPERP')) continue;

    const parsed = parseOKXSym(instId);
    if (!parsed) continue;
    const { asset, expiry } = parsed;

    // Decision matrix: BTC and ETH only for OKX
    if (!['BTC', 'ETH'].includes(asset)) continue;
    const sp = spot[asset];
    if (!sp?.mid) continue;

    // vol24Ccy is in the coin (BTC/ETH) — convert to USD using mid
    const vol24Usd = parseFloat(x.volCcy24h || 0) * sp.mid;
    const oiUsd    = oiMap[instId] ?? null;
    const bid      = parseFloat(x.bidPx || 0);
    const ask      = parseFloat(x.askPx || 0);

    const c = buildContract({
      asset,
      exchange:  'OKX',
      venueKey:  'OKX',
      contract:  instId,
      spotMid:   sp.mid,
      spotBid:   sp.bid,
      spotAsk:   sp.ask,
      futureLast: parseFloat(x.last || 0),
      futureBid:  bid > 0 ? bid : null,
      futureAsk:  ask > 0 ? ask : null,
      expiryMs:  expiry.getTime(),
      vol24Usd,
      oiUsd,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Deribit ───────────────────────────────────────────────────────────────────

async function fetchDeribit(spot) {
  // book_summary includes mark_price, last, bid_price, ask_price — no extra call needed
  const [btcRes, ethRes] = await Promise.all([
    get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future'),
    get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=future'),
  ]);

  const results = [];
  for (const [data, asset] of [[btcRes.data?.result, 'BTC'], [ethRes.data?.result, 'ETH']]) {
    if (!Array.isArray(data)) continue;
    const sp = spot[asset];
    if (!sp?.mid) continue;

    for (const x of data) {
      const name = x.instrument_name;
      if (name.includes('PERPETUAL')) continue;

      const parsed = parseDeribitSym(name);
      if (!parsed || parsed.asset !== asset) continue;

      const bid      = parseFloat(x.bid_price || 0);
      const ask      = parseFloat(x.ask_price || 0);
      // vol24_usd and open_interest are in USD for Deribit futures
      const vol24Usd = parseFloat(x.volume_usd || 0);
      const oiUsd    = parseFloat(x.open_interest || 0);

      const c = buildContract({
        asset,
        exchange:  'Deribit',
        venueKey:  'DERIBIT',
        contract:  name,
        spotMid:    sp.mid,
        spotBid:    sp.bid,
        spotAsk:    sp.ask,
        futureLast: parseFloat(x.mark_price || x.last || 0),
        futureBid:  bid > 0 ? bid : null,
        futureAsk:  ask > 0 ? ask : null,
        expiryMs:  parsed.expiry.getTime(),
        vol24Usd,
        oiUsd,
      });
      if (c) results.push(c);
    }
  }
  return results;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan() {
  console.log('[basis] scanning…');
  const t0 = Date.now();

  let spot;
  try { spot = await fetchSpot(); }
  catch (e) { console.error('[basis] spot fetch error:', e.message); return; }

  const [coinm, usdtm, bybit, kraken, okx, deribit] = await Promise.allSettled([
    fetchCOINM(spot),
    fetchUSDTM(spot),
    fetchBybit(spot),
    fetchKraken(spot),
    fetchOKX(spot),
    fetchDeribit(spot),
  ]);

  const all = [
    ...(coinm.status === 'fulfilled'   ? coinm.value   : (console.warn('[basis] COINM:', coinm.reason?.message), [])),
    ...(usdtm.status === 'fulfilled'   ? usdtm.value   : (console.warn('[basis] USDTM:', usdtm.reason?.message), [])),
    ...(bybit.status === 'fulfilled'   ? bybit.value   : (console.warn('[basis] Bybit:', bybit.reason?.message), [])),
    ...(kraken.status === 'fulfilled'  ? kraken.value  : (console.warn('[basis] Kraken:', kraken.reason?.message), [])),
    ...(okx.status === 'fulfilled'     ? okx.value     : (console.warn('[basis] OKX:', okx.reason?.message), [])),
    ...(deribit.status === 'fulfilled' ? deribit.value : (console.warn('[basis] Deribit:', deribit.reason?.message), [])),
  ];

  const opportunities = all
    .filter(c => c && c.type === 'contango')
    .sort((a, b) => b.netAnnualized - a.netAnnualized);

  const backwardation = all
    .filter(c => c && c.type === 'backwardation')
    .sort((a, b) => a.annualized - b.annualized); // most negative first

  const best = opportunities[0] ?? null;

  atomicWrite(OUTPUT_FILE, {
    updatedAt:    new Date().toISOString(),
    agentVersion: 'agent19-basis v2',
    spot: {
      BTC: spot.BTC?.mid ?? null,
      ETH: spot.ETH?.mid ?? null,
      BNB: spot.BNB?.mid ?? null,
      SOL: spot.SOL?.mid ?? null,
    },
    opportunities,
    backwardation,
    summary: {
      count:             opportunities.length,
      bestNetAnnualized: best?.netAnnualized ?? null,
      bestContract:      best?.contract ?? null,
      bestExchange:      best?.exchange ?? null,
      bestAsset:         best?.asset ?? null,
    },
    disclaimer: DISCLAIMER,
  });

  // Parallel history sink (non-fatal): snapshot basis / cash-and-carry board as computed.
  try {
    require('../lib/history-logger').appendSnapshot('basis', Date.now(), opportunities);
  } catch (e) { console.log('[history] basis snapshot skipped:', e.message); }

  console.log(
    `[basis] done in ${Date.now() - t0}ms — ` +
    `${opportunities.length} opportunities, ${backwardation.length} backwardation signals. ` +
    `Best: ${best ? `${best.exchange} ${best.contract} exec=${(best.netAnnualizedExecutable*100).toFixed(2)}%/yr ind=${(best.netAnnualizedIndicative*100).toFixed(2)}%/yr` : 'none'}`
  );
}

async function main() {
  console.log('[agent19] basis scanner v2 starting — executable prices, zero Claude, read-only');
  await sleep(STARTUP_DELAY);
  await scan();
  setInterval(scan, REFRESH_MS);
}

main().catch(e => { console.error('[agent19] fatal:', e); process.exit(1); });
