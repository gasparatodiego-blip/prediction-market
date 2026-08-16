#!/usr/bin/env node
/**
 * Fetch OFFICIAL PUBLIC base-tier fee schedules for the dated-futures venues used
 * by the cash & carry engine, and persist them with provenance.
 *
 * Ground rule: a fee is recorded ONLY if an unauthenticated, documented public
 * endpoint returned it. Where a venue puts its fee schedule behind auth, the fee is
 * recorded UNKNOWN together with the verbatim API rejection as evidence. Blog posts,
 * docs-page scrapes and remembered numbers are NOT sources and are never used.
 *
 * Measured 2026-07-19:
 *   Deribit  — public. get_instrument returns maker_commission/taker_commission
 *              per instrument, for futures AND spot.
 *   Bybit    — PARTIAL. instruments-info publicly returns deliveryFeeRate for dated
 *              contracts, but no maker/taker; those need /v5/account/fee-rate (auth).
 *   OKX      — auth only (/api/v5/account/trade-fee).
 *   Binance  — auth only (/sapi/v1/asset/tradeFee).
 *
 * Base tier is the honest WORST case: a real account at volume tier or with fee
 * discounts (BNB, promos, maker rebates) pays less. Never present it as the
 * user's actual fee.
 *
 * Read-only. Writes data/venue-fees-official.json.
 */

const fs = require('fs');
const path = require('path');
const { rlGet } = require('../lib/rateLimitedFetch');

const OUT = path.join(__dirname, '..', 'data', 'venue-fees-official.json');
const BASIS_FILE = '/tmp/basis-opportunities.json';

const RL = {
  deribit: { host: 'deribit.com',     minIntervalMs: 300 },
  bybit:   { host: 'api.bybit.com',   minIntervalMs: 300 },
  okx:     { host: 'okx.com',         minIntervalMs: 300 },
  binance: { host: 'api.binance.com', minIntervalMs: 300 },
};

const num = v => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : null));

async function get(url, rl) {
  try { const r = await rlGet(url, rl); return { ok: true, data: r.data }; }
  catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
}

// ── Deribit: fully public per-instrument commissions ────────────────────────
async function deribit(contracts) {
  const url = n => `https://www.deribit.com/api/v2/public/get_instrument?instrument_name=${n}`;
  const perInstrument = {};
  for (const c of contracts) {
    const r = await get(url(c), RL.deribit);
    const x = r.ok && r.data && r.data.result;
    if (!x) { perInstrument[c] = { status: 'UNKNOWN', reason: 'FETCH_FAILED', detail: r.error || 'no result' }; continue; }
    perInstrument[c] = {
      status: 'OK',
      makerFee: num(x.maker_commission),
      takerFee: num(x.taker_commission),
      blockTradeFee: num(x.block_trade_commission),
      contractSize: num(x.contract_size),
      settlementCurrency: x.settlement_currency || null,
      instrumentType: x.instrument_type || null,
      source: url(c),
    };
  }
  // Spot leg, if a Deribit-native single-venue carry is wanted.
  const spotName = 'BTC_USDT';
  const rs = await get(url(spotName), RL.deribit);
  const sx = rs.ok && rs.data && rs.data.result;
  const spot = sx
    ? { status: 'OK', instrument: spotName, makerFee: num(sx.maker_commission),
        takerFee: num(sx.taker_commission), source: url(spotName),
        note: sx.taker_commission === 0
          ? 'API reports 0 taker on this spot pair. Recorded exactly as returned; Deribit has run zero-fee spot periods. Verify before sizing on it.'
          : null }
    : { status: 'UNKNOWN', reason: 'FETCH_FAILED', detail: rs.error || 'no result' };

  return {
    venue: 'Deribit',
    feesPublic: true,
    datedFutures: { status: 'OK', perInstrument,
      source: 'https://www.deribit.com/api/v2/public/get_instrument',
      note: 'maker_commission/taker_commission are per-instrument and public. Inverse (coin-settled) contracts.' },
    spot,
    hasSpotMarket: true,
    singleVenueCarry: 'POSSIBLE',
    singleVenueNote: 'Deribit lists BTC_USDC/BTC_USDT/BTC_USDE spot alongside dated futures, so spot+future can sit in one account. '
                   + 'Spot depth is far thinner than Binance; the live engine prices the spot leg on Binance instead.',
  };
}

// ── Bybit: delivery fee public, maker/taker auth-gated ──────────────────────
async function bybit(contracts) {
  const perInstrument = {};
  for (const c of contracts) {
    const url = `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${c}`;
    const r = await get(url, RL.bybit);
    const x = r.ok && r.data && r.data.result && r.data.result.list && r.data.result.list[0];
    perInstrument[c] = x
      ? { status: 'PARTIAL', deliveryFeeRate: num(x.deliveryFeeRate),
          makerFee: null, takerFee: null,
          reason: 'MAKER_TAKER_AUTH_GATED', settleCoin: x.settleCoin || null, source: url }
      : { status: 'UNKNOWN', reason: 'FETCH_FAILED', detail: r.error || 'no result' };
  }
  const probe = await get('https://api.bybit.com/v5/account/fee-rate?category=linear&symbol=BTCUSDT-25SEP26', RL.bybit);
  return {
    venue: 'Bybit',
    feesPublic: false,
    datedFutures: {
      status: 'UNKNOWN', makerFee: null, takerFee: null,
      reason: 'AUTH_REQUIRED',
      authEvidence: JSON.stringify(probe.ok ? probe.data : probe.error).slice(0, 240),
      authEndpoint: 'https://api.bybit.com/v5/account/fee-rate',
      publiclyAvailable: 'deliveryFeeRate only', perInstrument,
      source: 'https://api.bybit.com/v5/market/instruments-info?category=linear',
    },
    spot: { status: 'UNKNOWN', reason: 'AUTH_REQUIRED', makerFee: null, takerFee: null },
    hasSpotMarket: true,
    singleVenueCarry: 'POSSIBLE',
    singleVenueNote: 'Bybit lists spot and linear dated futures under one unified account.',
  };
}

// ── OKX: auth only ──────────────────────────────────────────────────────────
async function okx() {
  const probe = await get('https://www.okx.com/api/v5/account/trade-fee?instType=FUTURES&instFamily=BTC-USD', RL.okx);
  const specUrl = 'https://www.okx.com/api/v5/public/instruments?instType=FUTURES&uly=BTC-USD';
  const spec = await get(specUrl, RL.okx);
  const one = spec.ok && spec.data && spec.data.data && spec.data.data[0];
  return {
    venue: 'OKX',
    feesPublic: false,
    datedFutures: {
      status: 'UNKNOWN', makerFee: null, takerFee: null,
      reason: 'AUTH_REQUIRED',
      authEvidence: JSON.stringify(probe.ok ? probe.data : probe.error).slice(0, 240),
      authEndpoint: 'https://www.okx.com/api/v5/account/trade-fee',
      publiclyAvailable: 'contract specs only (no fee fields)',
      specSample: one ? { instId: one.instId, ctVal: one.ctVal, ctType: one.ctType } : null,
      source: specUrl,
    },
    spot: { status: 'UNKNOWN', reason: 'AUTH_REQUIRED', makerFee: null, takerFee: null },
    hasSpotMarket: true,
    singleVenueCarry: 'POSSIBLE',
    singleVenueNote: 'OKX lists SPOT BTC-USDT and inverse dated futures in one account.',
  };
}

// ── Binance: auth only ──────────────────────────────────────────────────────
async function binance() {
  const probe = await get('https://api.binance.com/sapi/v1/asset/tradeFee?symbol=BTCUSDT', RL.binance);
  return {
    venue: 'Binance',
    feesPublic: false,
    datedFutures: {
      status: 'UNKNOWN', makerFee: null, takerFee: null,
      reason: 'AUTH_REQUIRED',
      authEvidence: JSON.stringify(probe.ok ? probe.data : probe.error).slice(0, 240),
      authEndpoint: 'https://api.binance.com/sapi/v1/asset/tradeFee',
      publiclyAvailable: 'exchangeInfo symbol filters only (no fee fields)',
      source: 'https://api.binance.com/api/v3/exchangeInfo',
    },
    spot: { status: 'UNKNOWN', reason: 'AUTH_REQUIRED', makerFee: null, takerFee: null },
    hasSpotMarket: true,
    singleVenueCarry: 'POSSIBLE',
    singleVenueNote: 'Binance lists spot plus USDT-M and COIN-M quarterly futures. Spot and futures are separate wallets '
                   + 'but the same account.',
  };
}

(async () => {
  let contracts = { DERIBIT: [], BYBIT: [] };
  try {
    const b = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    for (const o of b.opportunities || []) {
      if (o.venueKey === 'DERIBIT') contracts.DERIBIT.push(o.contract);
      if (o.venueKey === 'BYBIT')   contracts.BYBIT.push(o.contract);
    }
    contracts.DERIBIT = [...new Set(contracts.DERIBIT)];
    contracts.BYBIT   = [...new Set(contracts.BYBIT)];
  } catch (e) {
    console.error('could not read live basis contracts:', e.message);
  }

  console.log(`fetching official public fees — Deribit ${contracts.DERIBIT.length} contracts, Bybit ${contracts.BYBIT.length}`);

  const venues = {
    DERIBIT: await deribit(contracts.DERIBIT),
    BYBIT:   await bybit(contracts.BYBIT),
    OKX:     await okx(),
    BINANCE: await binance(),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    method: 'Unauthenticated documented public endpoints only, fetched through lib/rateLimitedFetch.',
    baseTierNote: 'These are BASE-TIER / public defaults — the honest worst case. A real account at a volume tier, '
                + 'or with maker rebates or fee-token discounts, pays less. Never present as the user\'s actual fee.',
    unknownPolicy: 'A venue that gates its fee schedule behind auth is recorded UNKNOWN with the verbatim API rejection '
                 + 'as evidence. No blog figures, no docs scrapes, no remembered numbers.',
    venues,
    summary: Object.fromEntries(Object.entries(venues).map(([k, v]) => [k, {
      feesPublic: v.feesPublic,
      datedFuturesFeeStatus: v.datedFutures.status,
      hasSpotMarket: v.hasSpotMarket,
      singleVenueCarry: v.singleVenueCarry,
    }])),
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  console.log('\nVENUE   | fees public | dated-futures fee        | spot fee            | single-venue carry');
  for (const [k, v] of Object.entries(venues)) {
    let df = v.datedFutures.status;
    if (k === 'DERIBIT') {
      const s = Object.values(v.datedFutures.perInstrument).find(x => x.status === 'OK');
      df = s ? `maker ${s.makerFee} / taker ${s.takerFee}` : 'OK';
    } else if (k === 'BYBIT') {
      df = `UNKNOWN (delivery ${Object.values(v.datedFutures.perInstrument)[0]?.deliveryFeeRate ?? '—'})`;
    }
    const sp = v.spot.status === 'OK' ? `maker ${v.spot.makerFee} / taker ${v.spot.takerFee}` : v.spot.status;
    console.log([k.padEnd(7), String(v.feesPublic).padEnd(11), df.padEnd(24), sp.padEnd(19), v.singleVenueCarry].join(' | '));
  }
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
})();
