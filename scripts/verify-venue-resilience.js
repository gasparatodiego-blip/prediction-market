#!/usr/bin/env node
/**
 * Verifies the resilient-fetch pattern across EVERY carry venue, against the real
 * agent19 code path.
 *
 * The bug class: every fetcher gathered its endpoints under a bare Promise.all, so ONE
 * endpoint hitting the 14s wall-clock deadline rejected the batch, threw out of the
 * fetcher, and the caller substituted [] — silently removing that venue's entire row
 * set for the cycle, with nothing in the persisted output to say why.
 *
 * Measured wall-clock timeouts in the error log:
 *   COINM 54 · USDTM 26 · OKX 24 · Deribit 19 · Kraken 1 · Bybit 0
 * COIN-M was fixed first (8861bf4); this extends the same pattern to the rest.
 *
 * Per venue this checks three things:
 *   PERMANENT failure — retries, then records an explicit TIMEOUT naming the endpoint
 *                       (never a silent zero)
 *   TRANSIENT failure — one timeout then success: retry recovers, rows still produced
 *                       (this is the case that actually happens in production)
 *   OPTIONAL failure  — OKX only: its open-interest calls are display/tier and never
 *                       touch capacity, so losing them must NOT zero the venue
 *
 * Read-only: no writes, no orders, no pm2.
 */

const path = require('path');
const Module = require('module');

const HTTP_GET_PATH = require.resolve(path.join(__dirname, '..', 'lib', 'httpGet.js'));
const AGENT_PATH    = require.resolve(path.join(__dirname, '..', 'agents', 'agent19-basis.js'));

const SPOT = {
  BTC: { mid: 64900, bid: 64899, ask: 64901 },
  ETH: { mid: 1874,  bid: 1873.9, ask: 1874.1 },
};

// Real-shaped-but-minimal payloads. Enough for each fetcher to reach its status write;
// row counts are not the point here, reachability handling is.
const EMPTY_ARR = { status: 200, data: [] };
function payloadFor(url) {
  if (url.includes('dapi.binance.com') || url.includes('fapi.binance.com')) {
    if (url.includes('/depth')) return { status: 200, data: { bids: [] } };
    return EMPTY_ARR;
  }
  if (url.includes('bybit.com'))  return { status: 200, data: { result: { list: [] } } };
  if (url.includes('okx.com'))    return { status: 200, data: { data: [] } };
  if (url.includes('deribit.com'))return { status: 200, data: { result: [] } };
  if (url.includes('kraken.com')) return { status: 200, data: { instruments: [], tickers: [] } };
  return EMPTY_ARR;
}

function loadAgentWith({ failing = new Set(), flaky = null } = {}) {
  const flakeCount = new Map();
  delete require.cache[AGENT_PATH];
  require.cache[HTTP_GET_PATH] = new Module(HTTP_GET_PATH, null);
  require.cache[HTTP_GET_PATH].filename = HTTP_GET_PATH;
  require.cache[HTTP_GET_PATH].loaded = true;
  require.cache[HTTP_GET_PATH].exports = {
    httpGet: async (url) => {
      for (const f of failing) if (url.includes(f)) throw new Error('wall-clock timeout: ' + url.slice(0, 55));
      if (flaky && url.includes(flaky.name)) {
        const seen = (flakeCount.get(flaky.name) ?? 0) + 1;
        flakeCount.set(flaky.name, seen);
        if (seen <= flaky.times) throw new Error('wall-clock timeout: ' + url.slice(0, 55));
      }
      return payloadFor(url);
    },
  };
  return require(AGENT_PATH);
}

/** The ORIGINAL shape: bare Promise.all over the venue's endpoints. */
async function legacy(httpGet, urls) {
  try { await Promise.all(urls.map(u => httpGet(u))); return 'venue fetched'; }
  catch { return 'THREW -> caller substitutes [] -> ALL rows dropped'; }
}

const VENUES = [
  { key: 'USDTM',   fn: 'fetchUSDTM',   kill: 'fapi.binance.com/fapi/v1/ticker/24hr',
    urls: ['https://fapi.binance.com/fapi/v1/ticker/24hr', 'https://fapi.binance.com/fapi/v1/ticker/bookTicker'] },
  { key: 'BYBIT',   fn: 'fetchBybit',   kill: 'bybit.com/v5/market/tickers',
    urls: ['https://api.bybit.com/v5/market/tickers?category=linear'] },
  { key: 'KRAKEN',  fn: 'fetchKraken',  kill: 'kraken.com/derivatives/api/v3/instruments',
    urls: ['https://futures.kraken.com/derivatives/api/v3/instruments', 'https://futures.kraken.com/derivatives/api/v3/tickers'] },
  { key: 'OKX',     fn: 'fetchOKX',     kill: 'okx.com/api/v5/market/tickers',
    urls: ['https://www.okx.com/api/v5/market/tickers?instType=FUTURES', 'https://www.okx.com/api/v5/public/instruments?instType=FUTURES'] },
  { key: 'DERIBIT', fn: 'fetchDeribit', kill: 'currency=BTC&kind=future',
    urls: ['https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future',
           'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=future'] },
  { key: 'COINM',   fn: 'fetchCOINM',   kill: 'dapi.binance.com/dapi/v1/ticker/24hr',
    urls: ['https://dapi.binance.com/dapi/v1/ticker/24hr', 'https://dapi.binance.com/dapi/v1/ticker/bookTicker'] },
];

async function run(v) {
  console.log(`\n${'='.repeat(74)}\n${v.key}  (${v.fn})\n${'='.repeat(74)}`);
  const results = {};

  // PERMANENT failure
  {
    const agent = loadAgentWith({ failing: new Set([v.kill]) });
    const old = await legacy(require.cache[HTTP_GET_PATH].exports.httpGet, v.urls);
    let rows = [];
    try { rows = await agent[v.fn](SPOT, {}); } catch (e) { rows = null; }
    const st = agent.getVenueStatus()[v.key];
    console.log(`  PERMANENT timeout`);
    console.log(`    OLD -> ${old}`);
    console.log(`    NEW -> rows ${rows === null ? 'THREW' : rows.length}, status ${st?.status}, endpoint ${st?.endpoint}, attempts ${JSON.stringify(st?.attempts)}`);
    results.permanent = st?.status === 'TIMEOUT' && rows !== null && Object.values(st.attempts).some(a => a === 3);
  }

  // TRANSIENT failure — the production case
  {
    const agent = loadAgentWith({ flaky: { name: v.kill, times: 1 } });
    let rows = [], threw = null;
    try { rows = await agent[v.fn](SPOT, {}); } catch (e) { threw = e.message; }
    const st = agent.getVenueStatus()[v.key];
    console.log(`  TRANSIENT timeout (fails once, then answers)`);
    console.log(`    NEW -> ${threw ? 'THREW ' + threw : `rows ${rows.length}`}, status ${st?.status}, retried ${st?.retried}, attempts ${JSON.stringify(st?.attempts)}`);
    results.transient = !threw && st?.status === 'OK' && st?.retried === true;
  }

  console.log(`  VERDICT: permanent=${results.permanent ? 'PASS' : 'FAIL'}  transient=${results.transient ? 'PASS' : 'FAIL'}`);
  return results;
}

(async () => {
  const all = {};
  for (const v of VENUES) all[v.key] = await run(v);

  // OKX optional-endpoint degradation: OI is display/tier only and must not zero rows.
  console.log(`\n${'='.repeat(74)}\nOKX — OPTIONAL endpoint (open-interest) fails\n${'='.repeat(74)}`);
  const agent = loadAgentWith({ failing: new Set(['open-interest']) });
  let rows = [], threw = null;
  try { rows = await agent.fetchOKX(SPOT, {}); } catch (e) { threw = e.message; }
  const st = agent.getVenueStatus().OKX;
  console.log(`  NEW -> ${threw ? 'THREW ' + threw : `rows ${rows.length}`}, status ${st?.status}, degraded ${JSON.stringify(st?.degraded)}`);
  const okxDegrade = !threw && st?.status === 'OK' && Array.isArray(st?.degraded) && st.degraded.length === 2;
  console.log(`  VERDICT: ${okxDegrade ? 'PASS — OI loss degrades a label, does not zero the venue' : 'FAIL'}`);

  console.log(`\n${'='.repeat(74)}`);
  const pass = Object.values(all).every(r => r.permanent && r.transient) && okxDegrade;
  console.log(`OVERALL: ${pass ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  for (const [k, r] of Object.entries(all)) console.log(`  ${k.padEnd(8)} permanent=${r.permanent} transient=${r.transient}`);
})();
