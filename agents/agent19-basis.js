#!/usr/bin/env node
// agent19-basis.js — Cash-and-carry / basis scanner
// Covers: Binance COIN-M, Binance USDT-M, OKX, Deribit for BTC/ETH/BNB.
// Applies the 7 filters from Step-1 analysis. Zero Claude, read-only, free.
'use strict';

const fs    = require('fs');
const https = require('https');

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

// Round-trip taker fees (open spot + open future; delivery at expiry ~free)
const FEES = {
  COINM:   0.00165,  // spot 0.10% + COIN-M futures 0.05% + delivery 0.015%
  USDTM:   0.00140,  // spot 0.10% + USDT-M futures 0.04%
  OKX:     0.00150,  // spot 0.10% + OKX futures 0.05%
  DERIBIT: 0.00150,  // spot on Binance 0.10% + Deribit futures 0.05%
};

// Binance COIN-M: contract size in USD
const COINM_CSZ = { BTC: 100, ETH: 10, SOL: 10, XRP: 10, BNB: 10 };

const MONTH_IDX = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

const DISCLAIMER =
  'Basis return is LOCKED only if held to contract expiry on the same exchange. ' +
  'Early exit re-buys the future at an unknown price — locked return disappears. ' +
  'COIN-M (Binance), BTC-USD (OKX): P&L settles in the coin, not USDT. ' +
  'USD return drifts with spot — NOT a clean locked-USD return. ' +
  'Only Binance USDT-M (BTCUSDT/ETHUSDT quarterly) gives a clean locked-USDT return. ' +
  'Exchange / counterparty risk over the full hold period. Not financial advice.';

// ── HTTP ───────────────────────────────────────────────────────────────────────
function get(url, ms = 14_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: ms }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        const body = Buffer.concat(buf).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error(`${res.statusCode} parse: ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

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
  // Only handle BTC-USD-YYMMDD and ETH-USD-YYMMDD (3 parts, no _UM / XPERP)
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

function buildContract({ asset, exchange, venueKey, contract, spot, future, expiryMs,
                          vol24Usd, oiUsd, bidSpreadPct }) {
  const now = Date.now();
  const daysToExpiry = (expiryMs - now) / 86_400_000;

  // Filter 1: daysToExpiry < MIN_DAYS
  if (daysToExpiry < MIN_DAYS) return null;

  const basis           = (future - spot) / spot;
  const grossAnnualized = basis * 365 / daysToExpiry;
  const fee             = FEES[venueKey] || 0.002;
  const netAnnualized   = (basis - fee) * 365 / daysToExpiry;

  // Filter 4: exclude XPERP — already handled upstream (never passed in)

  // Backwardation signal (filter 5)
  if (basis < 0) {
    if (vol24Usd < MIN_VOL_THIN) return null; // too thin to surface even as signal
    return {
      type:          'backwardation',
      asset,
      exchange,
      contract,
      expiry:        new Date(expiryMs).toISOString().slice(0, 10),
      daysToExpiry:  Math.round(daysToExpiry),
      spot,
      future,
      basis:         round4(basis),
      annualized:    round4(grossAnnualized),
      vol24Usd:      Math.round(vol24Usd),
      signal:        `${asset} futures trade BELOW spot. Likely staking/yield exceeds risk-free rate. ` +
                     `Reverse carry (short spot + long future) collects the basis but requires borrowing ${asset}.`,
    };
  }

  // Filter 2: volume threshold (VERY THIN → exclude from C&C)
  const t = tier(vol24Usd, oiUsd);
  if (t === 'VERY THIN') return null;

  // Filter 3: net annualized must be > 0
  if (netAnnualized <= 0) return null;

  // Filter 6: coin-margined disclaimer
  // COIN-M = coin-settled (BTC/ETH collateral, USD-denominated contracts)
  // Binance USDT-M = linear, cash-settled in USDT → CLEAN USD (only one)
  // Binance COIN-M / OKX BTC-USD / Deribit std futures = INVERSE / coin-settled
  // Deribit: instrument_type=reversed, settlement_currency=BTC/ETH — NOT USD
  const coinMargined = ['COINM', 'OKX', 'DERIBIT'].includes(venueKey);
  const coinMarginedNote = coinMargined
    ? venueKey === 'DERIBIT'
      ? `Inverse/reversed — P&L settles in ${asset}, not USD. USD return drifts with spot; not a clean locked-USD return.`
      : `Coin-margined — P&L settles in ${asset}. USD return drifts with spot price; not a clean locked-USD return.`
    : null;

  // Filter 7: capacity estimate
  const cap = capacity(vol24Usd, oiUsd, asset);

  const expiryDate = new Date(expiryMs).toISOString().slice(0, 10);
  const verdict    = coinMargined
    ? `Net +${(netAnnualized * 100).toFixed(2)}%/yr. Coin-settled — USD return not locked.`
    : `Locked +${(netAnnualized * 100).toFixed(2)}%/yr if held to ${expiryDate}. Cash-settled.`;

  return {
    type:             'contango',
    asset,
    exchange,
    venueKey,
    contract,
    expiry:           expiryDate,
    daysToExpiry:     Math.round(daysToExpiry),
    spot:             round2(spot),
    future:           round2(future),
    basis:            round4(basis),
    grossAnnualized:  round4(grossAnnualized),
    fee,
    netAnnualized:    round4(netAnnualized),
    vol24Usd:         Math.round(vol24Usd),
    oiUsd:            oiUsd ? Math.round(oiUsd) : null,
    capacityUsd:      cap,
    tier:             t,
    thinFlag:         t === 'THIN',
    coinMargined,
    coinMarginedNote,
    bidSpreadPct:     bidSpreadPct ? round4(bidSpreadPct) : null,
    verdict,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ── Spot prices ────────────────────────────────────────────────────────────────

async function fetchSpot() {
  // Primary: try exchange-prices.json for BTC/ETH
  let btc = null, eth = null;
  try {
    const raw = JSON.parse(fs.readFileSync(SPOT_FILE, 'utf8'));
    const b   = raw.exchanges?.binance || {};
    btc = b.BTC?.price ?? null;
    eth = b.ETH?.price ?? null;
  } catch { /* file missing */ }

  // Always fetch fresh for BNB/SOL/XRP (not guaranteed in spot file)
  try {
    const syms  = encodeURIComponent('["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]');
    const res   = await get(`https://api.binance.com/api/v3/ticker/price?symbols=${syms}`);
    const prices = {};
    for (const { symbol, price } of (res.data || [])) {
      prices[symbol] = parseFloat(price);
    }
    // Prefer live fetch over file for BTC/ETH too
    return {
      BTC: prices.BTCUSDT ?? btc,
      ETH: prices.ETHUSDT ?? eth,
      BNB: prices.BNBUSDT ?? null,
      SOL: prices.SOLUSDT ?? null,
      XRP: prices.XRPUSDT ?? null,
    };
  } catch (e) {
    console.warn('[basis] spot fetch failed, using file:', e.message);
    return { BTC: btc, ETH: eth, BNB: null, SOL: null, XRP: null };
  }
}

// ── Binance COIN-M ────────────────────────────────────────────────────────────

async function fetchCOINM(spot) {
  const res = await get('https://dapi.binance.com/dapi/v1/ticker/24hr');
  if (res.status !== 200 || !Array.isArray(res.data)) return [];

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

    const spotPrice = spot[asset];
    if (!spotPrice) continue;

    // Filter: only BTC, ETH, BNB, SOL per decision matrix
    if (!['BTC', 'ETH', 'BNB', 'SOL'].includes(asset)) continue;

    const csz      = COINM_CSZ[asset] ?? 10;
    const vol24Usd = parseFloat(x.volume || 0) * csz;
    const oiContr  = oiMap[x.symbol] ?? 0;
    const oiUsd    = oiContr * csz;
    const future   = parseFloat(x.lastPrice || 0);

    if (future <= 0) continue;

    const c = buildContract({
      asset,
      exchange:    'Binance COIN-M',
      venueKey:    'COINM',
      contract:    x.symbol,
      spot:        spotPrice,
      future,
      expiryMs:    expiry.getTime(),
      vol24Usd,
      oiUsd,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Binance USDT-M ────────────────────────────────────────────────────────────

async function fetchUSDTM(spot) {
  const res = await get('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (res.status !== 200 || !Array.isArray(res.data)) return [];

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
      const sym = dated[i].symbol;
      const parsed = parseBinanceSym(sym, true);
      if (parsed) {
        // OI in the asset (BTC/ETH)
        const oiAsset = parseFloat(r.value.data.openInterest);
        const sp = spot[parsed.asset] ?? 0;
        oiMap[sym] = oiAsset * sp;
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
    const spotPrice = spot[asset];
    if (!spotPrice) continue;

    // quoteVolume for USDT-M is in USDT (USD)
    const vol24Usd = parseFloat(x.quoteVolume || 0);
    const oiUsd    = oiMap[x.symbol] ?? null;
    const future   = parseFloat(x.lastPrice || 0);

    if (future <= 0) continue;

    const c = buildContract({
      asset,
      exchange: 'Binance USDT-M',
      venueKey: 'USDTM',
      contract: x.symbol,
      spot:     spotPrice,
      future,
      expiryMs: expiry.getTime(),
      vol24Usd,
      oiUsd,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── OKX ───────────────────────────────────────────────────────────────────────

async function fetchOKX(spot) {
  // Fetch tickers + OI for BTC-USD and ETH-USD in parallel
  const [tickRes, oiBtc, oiEth] = await Promise.all([
    get('https://www.okx.com/api/v5/market/tickers?instType=FUTURES'),
    get('https://www.okx.com/api/v5/public/open-interest?instType=FUTURES&uly=BTC-USD'),
    get('https://www.okx.com/api/v5/public/open-interest?instType=FUTURES&uly=ETH-USD'),
  ]);

  // Build OI map (oiCcy = in coin, multiply by spot for USD)
  const oiMap = {};
  for (const [oiData, asset] of [[oiBtc, 'BTC'], [oiEth, 'ETH']]) {
    for (const x of (oiData.data?.data || [])) {
      const sp = spot[asset] ?? 0;
      oiMap[x.instId] = parseFloat(x.oiCcy || 0) * sp;
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
    const spotPrice = spot[asset];
    if (!spotPrice) continue;

    // vol24Ccy is in the coin (BTC/ETH) — convert to USD
    const vol24Usd = parseFloat(x.volCcy24h || 0) * spotPrice;
    const oiUsd    = oiMap[instId] ?? null;
    const future   = parseFloat(x.last || 0);
    const bid      = parseFloat(x.bidPx || 0);
    const ask      = parseFloat(x.askPx || 0);
    const bidSpreadPct = (bid > 0 && ask > 0) ? (ask - bid) / bid : null;

    if (future <= 0) continue;

    const c = buildContract({
      asset,
      exchange:    'OKX',
      venueKey:    'OKX',
      contract:    instId,
      spot:        spotPrice,
      future,
      expiryMs:    expiry.getTime(),
      vol24Usd,
      oiUsd,
      bidSpreadPct,
    });
    if (c) results.push(c);
  }
  return results;
}

// ── Deribit ───────────────────────────────────────────────────────────────────

async function fetchDeribit(spot) {
  const [btcRes, ethRes] = await Promise.all([
    get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future'),
    get('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=future'),
  ]);

  const results = [];
  for (const [data, asset] of [[btcRes.data?.result, 'BTC'], [ethRes.data?.result, 'ETH']]) {
    if (!Array.isArray(data)) continue;
    const spotPrice = spot[asset];
    if (!spotPrice) continue;

    for (const x of data) {
      const name = x.instrument_name;
      if (name.includes('PERPETUAL')) continue;

      const parsed = parseDeribitSym(name);
      if (!parsed || parsed.asset !== asset) continue;

      const future   = parseFloat(x.mark_price || x.last || 0);
      // vol24_usd and open_interest are in USD for Deribit futures
      const vol24Usd = parseFloat(x.volume_usd || 0);
      const oiUsd    = parseFloat(x.open_interest || 0);
      const bid      = parseFloat(x.bid_price || 0);
      const ask      = parseFloat(x.ask_price || 0);
      const bidSpreadPct = (bid > 0 && ask > 0) ? (ask - bid) / bid : null;

      if (future <= 0) continue;

      const c = buildContract({
        asset,
        exchange:    'Deribit',
        venueKey:    'DERIBIT',
        contract:    name,
        spot:        spotPrice,
        future,
        expiryMs:    parsed.expiry.getTime(),
        vol24Usd,
        oiUsd,
        bidSpreadPct,
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

  const [coinm, usdtm, okx, deribit] = await Promise.allSettled([
    fetchCOINM(spot),
    fetchUSDTM(spot),
    fetchOKX(spot),
    fetchDeribit(spot),
  ]);

  const all = [
    ...(coinm.status === 'fulfilled'   ? coinm.value   : (console.warn('[basis] COINM:', coinm.reason?.message), [])),
    ...(usdtm.status === 'fulfilled'   ? usdtm.value   : (console.warn('[basis] USDTM:', usdtm.reason?.message), [])),
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
    updatedAt:      new Date().toISOString(),
    agentVersion:   'agent19-basis v1',
    spot:           { BTC: spot.BTC, ETH: spot.ETH, BNB: spot.BNB, SOL: spot.SOL },
    opportunities,
    backwardation,
    summary: {
      count:              opportunities.length,
      bestNetAnnualized:  best?.netAnnualized ?? null,
      bestContract:       best?.contract ?? null,
      bestExchange:       best?.exchange ?? null,
      bestAsset:          best?.asset ?? null,
    },
    disclaimer: DISCLAIMER,
  });

  console.log(
    `[basis] done in ${Date.now() - t0}ms — ` +
    `${opportunities.length} opportunities, ${backwardation.length} backwardation signals. ` +
    `Best: ${best ? `${best.exchange} ${best.contract} net=${(best.netAnnualized*100).toFixed(2)}%/yr` : 'none'}`
  );
}

async function main() {
  console.log('[agent19] basis scanner starting — zero Claude, read-only');
  await sleep(STARTUP_DELAY);
  await scan();
  setInterval(scan, REFRESH_MS);
}

main().catch(e => { console.error('[agent19] fatal:', e); process.exit(1); });
