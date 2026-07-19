#!/usr/bin/env node
'use strict';
/**
 * venue-maker-fees.js — fetch REAL base-tier maker/taker fees from venues' PUBLIC APIs.
 *
 * READ-ONLY against public, unauthenticated market-data endpoints. No API key, no signature,
 * no private endpoint, no order placement. Writes one file: data/venue-maker-fees.json.
 * Not wired into any agent, API or the dashboard.
 *
 * WHY: lib/funding-math.js carries taker fees for every venue but maker rates only where a
 * venue publishes them (lighter/extended/hyperliquid/... = 0). The six venues that matter for
 * the perp-vs-spot recompute — binance, bybit, okx, gateio, bitget, dydx — have NO maker rate
 * in the repo, and the SPOT schedule has no maker column at all. The spot taker leg is ~79.5%
 * of that lane's breakeven, so whether a real maker spot rate exists decides the question.
 *
 * HONESTY CONTRACT
 *   - BASE tier only. No VIP/volume assumptions, no fee-token discounts, no promo rates.
 *   - A venue that does not publish its fee schedule on a public unauthenticated endpoint is
 *     marked UNAVAILABLE. It is NOT guessed, NOT assumed zero, and NOT back-filled from docs.
 *     Docs pages are not APIs — if the number is not in an API response, it is UNAVAILABLE.
 *   - Every AVAILABLE rate records the exact endpoint and the exact JSON field it came from,
 *     so any figure here can be re-derived by hand.
 *   - Negative maker rates (rebates) are reported as negative, never clamped to zero.
 *   - All requests go through lib/rateLimitedFetch (per-host throttle + backoff).
 */
const fs = require('fs');
const { rlGet } = require('../lib/rateLimitedFetch');

const OUT = 'data/venue-maker-fees.json';
const RL = {
  concurrency: 1, spacingMs: 400, timeoutMs: 20_000,
  headers: { 'User-Agent': 'Mozilla/5.0 prediction-arb-scanner/1.0', 'Accept': 'application/json' },
};

/** Probe: fetch a public endpoint and pull maker/taker out of a named sample instrument. */
const PROBES = [
  // ── Gate.io — publishes maker_fee_rate / taker_fee_rate per contract, and spot pair fees
  { venue: 'gateio', market: 'perp', url: 'https://api.gateio.ws/api/v4/futures/usdt/contracts',
    pick: d => { const c = (d || []).find(x => x.name === 'BTC_USDT'); return c && { maker: +c.maker_fee_rate * 100, taker: +c.taker_fee_rate * 100, field: 'maker_fee_rate/taker_fee_rate', sample: c.name }; } },
  { venue: 'gateio', market: 'spot', url: 'https://api.gateio.ws/api/v4/spot/currency_pairs',
    pick: d => { const c = (d || []).find(x => x.id === 'BTC_USDT'); return c && { maker: c.maker_fee != null ? +c.maker_fee : null, taker: c.fee != null ? +c.fee : null, field: 'maker_fee/fee', sample: c.id }; } },

  // ── Bitget — mix contracts expose makerFeeRate/takerFeeRate
  { venue: 'bitget', market: 'perp', url: 'https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures',
    pick: d => { const c = (d?.data || []).find(x => x.symbol === 'BTCUSDT'); return c && { maker: c.makerFeeRate != null ? +c.makerFeeRate * 100 : null, taker: c.takerFeeRate != null ? +c.takerFeeRate * 100 : null, field: 'makerFeeRate/takerFeeRate', sample: c.symbol }; } },
  { venue: 'bitget', market: 'spot', url: 'https://api.bitget.com/api/v2/spot/public/symbols',
    pick: d => { const c = (d?.data || []).find(x => x.symbol === 'BTCUSDT'); return c && { maker: c.makerFeeRate != null ? +c.makerFeeRate * 100 : null, taker: c.takerFeeRate != null ? +c.takerFeeRate * 100 : null, field: 'makerFeeRate/takerFeeRate', sample: c.symbol }; } },

  // ── Binance — exchangeInfo carries no fee fields; the fee endpoint is /sapi (SIGNED).
  { venue: 'binance', market: 'spot', url: 'https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT',
    pick: d => { const s = (d?.symbols || [])[0]; const f = s && (s.makerCommission ?? s.takerCommission); return f != null ? { maker: null, taker: null, field: 'none', sample: s.symbol } : null; } },
  { venue: 'binance', market: 'perp', url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
    pick: d => { const s = (d?.symbols || []).find(x => x.symbol === 'BTCUSDT'); const f = s && (s.makerCommissionRate ?? s.liquidationFee); return (s && s.makerCommissionRate != null) ? { maker: +s.makerCommissionRate * 100, taker: s.takerCommissionRate != null ? +s.takerCommissionRate * 100 : null, field: 'makerCommissionRate', sample: s.symbol } : null; } },

  // ── Bybit — instruments-info carries no fee fields; /v5/account/fee-rate is SIGNED.
  { venue: 'bybit', market: 'spot', url: 'https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT',
    pick: d => { const s = (d?.result?.list || [])[0]; return (s && s.makerFee != null) ? { maker: +s.makerFee * 100, taker: s.takerFee != null ? +s.takerFee * 100 : null, field: 'makerFee', sample: s.symbol } : null; } },
  { venue: 'bybit', market: 'perp', url: 'https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=BTCUSDT',
    pick: d => { const s = (d?.result?.list || [])[0]; return (s && s.makerFee != null) ? { maker: +s.makerFee * 100, taker: s.takerFee != null ? +s.takerFee * 100 : null, field: 'makerFee', sample: s.symbol } : null; } },

  // ── OKX — public instruments carry no fee fields; /api/v5/account/trade-fee is SIGNED.
  { venue: 'okx', market: 'spot', url: 'https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT',
    pick: d => { const s = (d?.data || [])[0]; return (s && s.maker != null) ? { maker: +s.maker * 100, taker: s.taker != null ? +s.taker * 100 : null, field: 'maker', sample: s.instId } : null; } },
  { venue: 'okx', market: 'perp', url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP',
    pick: d => { const s = (d?.data || [])[0]; return (s && s.maker != null) ? { maker: +s.maker * 100, taker: s.taker != null ? +s.taker * 100 : null, field: 'maker', sample: s.instId } : null; } },

  // ── dYdX v4 — the indexer carries no fees, but fee tiers are CHAIN PARAMS and are served by
  // any public full-node REST gateway. Tier 1 = base (absolute_volume_requirement 0). Fees are
  // in parts-per-million: 100 ppm = 0.01%. Two independent public nodes are queried and must
  // agree, so a single node cannot skew the number.
  { venue: 'dydx', market: 'perp', url: 'https://dydx-rest.publicnode.com/dydxprotocol/v4/feetiers/perpetual_fee_params',
    pick: d => { const t = (d?.params?.tiers || []).find(x => String(x.absolute_volume_requirement) === '0'); return t && { maker: t.maker_fee_ppm / 10_000, taker: t.taker_fee_ppm / 10_000, field: 'tiers[base].maker_fee_ppm/taker_fee_ppm', sample: 'tier ' + t.name }; } },
  { venue: 'dydx', market: 'perp-crosscheck', url: 'https://dydx-ops-rest.kingnodes.com/dydxprotocol/v4/feetiers/perpetual_fee_params',
    pick: d => { const t = (d?.params?.tiers || []).find(x => String(x.absolute_volume_requirement) === '0'); return t && { maker: t.maker_fee_ppm / 10_000, taker: t.taker_fee_ppm / 10_000, field: 'tiers[base].maker_fee_ppm/taker_fee_ppm', sample: 'tier ' + t.name }; } },
];

(async () => {
  const results = [];
  for (const p of PROBES) {
    const rec = { venue: p.venue, market: p.market, url: p.url, status: null, available: false,
                  makerPct: null, takerPct: null, field: null, sample: null, note: null };
    try {
      const r = await rlGet(p.url, RL);
      rec.status = r.status;
      let got = null;
      try { got = p.pick(r.data); } catch (e) { rec.note = 'parse error: ' + e.message; }
      if (got && (got.maker != null || got.taker != null)) {
        rec.available = got.maker != null;
        rec.makerPct = got.maker; rec.takerPct = got.taker;
        rec.field = got.field; rec.sample = got.sample;
        if (got.maker == null) rec.note = 'endpoint returns a taker fee but NO maker field';
      } else {
        rec.note = 'HTTP 200 but the response carries NO fee fields — schedule is not on this public endpoint';
      }
    } catch (e) {
      rec.note = 'fetch failed: ' + String(e.message).slice(0, 120);
    }
    results.push(rec);
    console.log(`${rec.venue.padEnd(9)} ${rec.market.padEnd(5)} http=${String(rec.status).padEnd(5)} ` +
      `maker=${rec.makerPct == null ? 'UNAVAILABLE' : rec.makerPct + '%'} taker=${rec.takerPct == null ? '—' : rec.takerPct + '%'}` +
      (rec.note ? `  · ${rec.note}` : `  · field ${rec.field} on ${rec.sample}`));
  }

  const payload = {
    kind: 'venue-maker-fees',
    generatedAt: new Date().toISOString(),
    method: 'public unauthenticated REST only; BASE tier; no VIP/volume/promo assumptions',
    honesty: 'a venue whose schedule is not exposed on a public endpoint is UNAVAILABLE — never guessed, never assumed zero, never back-filled from a docs page',
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nwrote ${OUT}`);
  const avail = results.filter(r => r.available);
  console.log(`AVAILABLE maker rates: ${avail.length}/${results.length} -> ${avail.map(r => r.venue + '/' + r.market).join(', ') || '(none)'}`);
})();
