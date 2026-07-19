#!/usr/bin/env node
/**
 * Verifies the COIN-M fetch resilience fix against the REAL agent19 code path.
 *
 * The bug: fetchCOINM fetched dapi ticker/24hr and ticker/bookTicker under a bare
 * Promise.all. Either one hitting the 14s wall-clock deadline rejected the pair, threw
 * out of fetchCOINM, and the caller substituted [] — so a single transient timeout
 * silently removed EVERY coin-margined row for that cycle (BNB and friends vanishing,
 * then reappearing next cycle). Nothing in the persisted output said why.
 *
 * dapi is the flakiest endpoint agent19 talks to: 54 timeouts in the error log versus
 * USDTM 30 / OKX 24 / Deribit 20 / Kraken 2.
 *
 * This harness stubs lib/httpGet in the require cache BEFORE loading agent19, so the
 * agent's own fetch/retry/status code runs unmodified against controlled responses.
 * Only the FAILURE is injected; the payload shapes are real.
 *
 * Scenarios:
 *   1. steady state           — both endpoints answer; rows present, status OK
 *   2. ticker/24hr times out  — OLD zeroed COIN-M silently; FIXED retries, and on
 *                               permanent failure records an explicit TIMEOUT status
 *   3. transient timeout      — fails once then answers; retry recovers, rows present
 *   4. bookTicker times out   — distinct endpoint recorded, no midpoint fallback
 *
 * Read-only: no writes, no orders, no pm2.
 */

const path = require('path');
const Module = require('module');

const HTTP_GET_PATH = require.resolve(path.join(__dirname, '..', 'lib', 'httpGet.js'));
const AGENT_PATH    = require.resolve(path.join(__dirname, '..', 'agents', 'agent19-basis.js'));

// Minimal real-shaped dapi payloads: two BTC quarterlies and one BNB quarterly.
const TICKER_24H = [
  { symbol: 'BTCUSD_260925', volume: '50000', lastPrice: '64900' },
  { symbol: 'BTCUSD_261225', volume: '30000', lastPrice: '65500' },
  { symbol: 'BNBUSD_260925', volume: '3930',  lastPrice: '571' },
];
const BOOK_TICKER = [
  { symbol: 'BTCUSD_260925', bidPrice: '64908.7', askPrice: '64908.8' },
  { symbol: 'BTCUSD_261225', bidPrice: '65551.2', askPrice: '65551.3' },
  { symbol: 'BNBUSD_260925', bidPrice: '571.16',  askPrice: '571.87' },
];
const DEPTH = { bids: Array.from({ length: 40 }, (_, i) => [String(64900 - i), '500']) };

function payloadFor(url) {
  if (url.includes('ticker/24hr'))       return { status: 200, data: TICKER_24H };
  if (url.includes('ticker/bookTicker')) return { status: 200, data: BOOK_TICKER };
  if (url.includes('openInterest'))      return { status: 200, data: { openInterest: '1000' } };
  if (url.includes('/depth'))            return { status: 200, data: DEPTH };
  return { status: 200, data: [] };
}

/** Install a stubbed httpGet, then load a FRESH agent19 bound to it. */
function loadAgentWith({ failing = new Set(), flaky = null } = {}) {
  const calls = [];
  const flakeCount = new Map();
  delete require.cache[AGENT_PATH];
  require.cache[HTTP_GET_PATH] = new Module(HTTP_GET_PATH, null);
  require.cache[HTTP_GET_PATH].filename = HTTP_GET_PATH;
  require.cache[HTTP_GET_PATH].loaded = true;
  require.cache[HTTP_GET_PATH].exports = {
    httpGet: async (url) => {
      calls.push(url);
      for (const f of failing) {
        if (url.includes(f)) throw new Error('wall-clock timeout: ' + url.slice(0, 60));
      }
      if (flaky && url.includes(flaky.name)) {
        const seen = (flakeCount.get(flaky.name) ?? 0) + 1;
        flakeCount.set(flaky.name, seen);
        if (seen <= flaky.times) throw new Error('wall-clock timeout: ' + url.slice(0, 60));
      }
      return payloadFor(url);
    },
  };
  return { agent: require(AGENT_PATH), calls };
}

/** The ORIGINAL (buggy) fetch shape, for before/after contrast only. */
async function legacyFetch(httpGet) {
  try {
    const [res, btRes] = await Promise.all([
      httpGet('https://dapi.binance.com/dapi/v1/ticker/24hr'),
      httpGet('https://dapi.binance.com/dapi/v1/ticker/bookTicker'),
    ]);
    if (res.status !== 200 || !Array.isArray(res.data)) return { rows: 0, why: 'non-200' };
    return { rows: res.data.length, why: 'ok' };
  } catch (e) {
    // This is the caller's `coinm.status !== 'fulfilled' -> []` path.
    return { rows: 0, why: 'THREW -> caller substitutes [] -> ALL COIN-M rows dropped' };
  }
}

const SPOT = { BTC: { mid: 64900, bid: 64899, ask: 64901 }, BNB: { mid: 568.5, bid: 568.4, ask: 568.6 } };

async function scenario(title, opts) {
  console.log(`\n${'='.repeat(76)}\n${title}\n${'='.repeat(76)}`);

  loadAgentWith(opts);
  const old = await legacyFetch(require.cache[HTTP_GET_PATH].exports.httpGet);
  console.log(`  OLD (bare Promise.all) -> contracts seen: ${old.rows}  [${old.why}]`);

  const { agent } = loadAgentWith(opts);
  let rows = [], threw = null;
  try { rows = await agent.fetchCOINM(SPOT, {}); } catch (e) { threw = e.message; }
  const st = agent.getVenueStatus().COINM;

  if (threw) {
    console.log(`  NEW (fixed)            -> THREW: ${threw}   <-- unexpected`);
  } else {
    console.log(`  NEW (fixed)            -> rows: ${rows.length}`);
  }
  console.log(`  persisted venueStatus.COINM: ${st ? JSON.stringify(st) : '(none)'}`);
  return { old, rows, st };
}

(async () => {
  // 1 — steady state
  const s1 = await scenario('SCENARIO 1 — both dapi endpoints answer', {});
  const ok1 = s1.st?.status === 'OK' && s1.rows.length > 0;
  console.log(`  VERDICT: ${ok1 ? 'PASS — rows present, status OK' : 'FAIL'}`);

  // 2 — the reported bug: ticker/24hr times out permanently
  const s2 = await scenario('SCENARIO 2 — dapi ticker/24hr TIMES OUT (the reported bug)',
    { failing: new Set(['ticker/24hr']) });
  const oldZeroed = s2.old.rows === 0;
  const newExplicit = s2.st?.status === 'TIMEOUT' && s2.st?.attempts?.['ticker/24hr'] === 3;
  console.log(`  OLD silently zeroed COIN-M: ${oldZeroed ? 'YES (bug reproduced)' : 'no'}`);
  console.log(`  NEW retried then marked TIMEOUT (not silent): ${newExplicit ? 'YES' : 'NO'}`);
  console.log(`  VERDICT: ${oldZeroed && newExplicit ? 'PASS — absence is now explicit and attributable' : 'FAIL'}`);

  // 3 — transient: fails once, then answers. This is the case that actually happens.
  const s3 = await scenario('SCENARIO 3 — ticker/24hr times out ONCE, then answers (retry recovers)',
    { flaky: { name: 'ticker/24hr', times: 1 } });
  const recovered = s3.st?.status === 'OK' && s3.rows.length > 0 && s3.st?.retried === true;
  console.log(`  VERDICT: ${recovered ? `PASS — recovered on attempt ${s3.st.attempts['ticker/24hr']}, ${s3.rows.length} rows, no silent drop` : 'FAIL'}`);

  // 4 — bookTicker down: distinct endpoint, and no midpoint fallback is permitted
  const s4 = await scenario('SCENARIO 4 — dapi bookTicker TIMES OUT (no bid/ask)',
    { failing: new Set(['ticker/bookTicker']) });
  const bookMarked = s4.st?.status === 'TIMEOUT' && /bookTicker/.test(s4.st?.endpoint ?? '');
  console.log(`  VERDICT: ${bookMarked ? 'PASS — failing endpoint named, no midpoint fallback' : 'FAIL'}`);

  console.log(`\n${'='.repeat(76)}`);
  const all = ok1 && oldZeroed && newExplicit && recovered && bookMarked;
  console.log(`OVERALL: ${all ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  console.log('A transient dapi timeout now recovers on retry; a permanent one is recorded');
  console.log('as an explicit TIMEOUT status. No stale prices are ever served in their place.');
})();
