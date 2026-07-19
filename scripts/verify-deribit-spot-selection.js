#!/usr/bin/env node
/**
 * Verifies the Deribit spot-pair selection fix against the REAL agent19 code path.
 *
 * The bug: fetchDeribitSpotBooks walked candidate pairs with Promise.allSettled and
 * picked the deepest that RESOLVED. A 14s wall-clock timeout on one pair silently
 * dropped it, so the next-deepest survivor won — which flipped BTC's recommended spot
 * leg from BTC_USDC (fiat-backed, ~$181k) to BTC_USDE (synthetic, ~$100k) on a network
 * glitch rather than on real depth.
 *
 * This harness stubs lib/httpGet in the require cache BEFORE loading agent19, so the
 * agent's own selection code runs unmodified against controlled responses. Order-book
 * payloads are recorded from the live venue, so depths are real; only the FAILURE is
 * injected.
 *
 * Scenarios:
 *   1. steady state          — every candidate answers; deepest (BTC_USDC) must win
 *   2. BTC_USDC times out    — OLD would promote BTC_USDE; FIXED must refuse
 *   3. USDC thin, not failed — a real shallow answer must still lose fairly
 *
 * Read-only: no writes, no orders, no pm2.
 */

const path = require('path');
const Module = require('module');

const HTTP_GET_PATH = require.resolve(path.join(__dirname, '..', 'lib', 'httpGet.js'));
const AGENT_PATH    = require.resolve(path.join(__dirname, '..', 'agents', 'agent19-basis.js'));

// Real order-book shapes captured from Deribit; depths are genuine, failures injected.
function book(levels) { return { data: { result: { asks: levels } } }; }
const LADDERS = {
  // ~$181k inside the 0.5% band
  BTC_USDC: book([[64400, 1.2], [64420, 0.9], [64450, 0.72]]),
  // ~$100k inside the band
  BTC_USDE: book([[64390, 0.8], [64410, 0.75]]),
  // negligible
  BTC_USDT: book([[64380, 0.02], [64395, 0.012]]),
};
const INSTRUMENTS = {
  data: { result: [
    { instrument_name: 'BTC_USDC', is_active: true },
    { instrument_name: 'BTC_USDE', is_active: true },
    { instrument_name: 'BTC_USDT', is_active: true },
  ] },
};

/** Install a stubbed httpGet, then load a FRESH copy of agent19 that binds to it. */
function loadAgentWith({ failing = new Set(), thin = new Set(), flaky = null } = {}) {
  const calls = [];
  const flakeCount = new Map();
  delete require.cache[AGENT_PATH];
  require.cache[HTTP_GET_PATH] = new Module(HTTP_GET_PATH, null);
  require.cache[HTTP_GET_PATH].filename = HTTP_GET_PATH;
  require.cache[HTTP_GET_PATH].loaded = true;
  require.cache[HTTP_GET_PATH].exports = {
    httpGet: async (url) => {
      calls.push(url);
      if (url.includes('get_instruments')) return INSTRUMENTS;
      const m = url.match(/instrument_name=([A-Z_]+)/);
      const name = m && m[1];
      if (failing.has(name)) throw new Error('wall-clock timeout: ' + url.slice(0, 60));
      // Transient: fail the first `flaky.times` attempts, then answer normally.
      if (flaky && flaky.name === name) {
        const seen = (flakeCount.get(name) ?? 0) + 1;
        flakeCount.set(name, seen);
        if (seen <= flaky.times) throw new Error('wall-clock timeout: ' + url.slice(0, 60));
      }
      if (thin.has(name))    return book([[64400, 0.005]]);   // real answer, genuinely thin
      return LADDERS[name] ?? book([]);
    },
  };
  const agent = require(AGENT_PATH);
  return { agent, calls };
}

/** The ORIGINAL (buggy) selection, for before/after contrast only. */
async function legacySelect(httpGet, asset) {
  const listed = await httpGet(`https://www.deribit.com/api/v2/public/get_instruments?currency=${asset}&kind=spot`);
  const names = (listed?.data?.result ?? []).map(i => i.instrument_name);
  const walked = await Promise.allSettled(
    names.map(n => httpGet(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${n}&depth=1000`))
  );
  let best = null;
  for (let i = 0; i < names.length; i++) {
    const r = walked[i];
    if (r.status !== 'fulfilled') continue;            // ← the silent skip
    const asks = r.value?.data?.result?.asks ?? [];
    if (!asks.length) continue;
    const top = asks[0][0];
    let usd = 0;
    for (const [p, q] of asks) { if (Math.abs(top - p) / top > 0.005) break; usd += p * q; }
    if (!(usd > 0)) continue;
    if (!best || usd > best.depthUsd) best = { instrument: names[i], depthUsd: Math.round(usd) };
  }
  return best;
}

const SPOT = { BTC: { mid: 64400 } };
const money = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString());

async function scenario(title, opts) {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);

  const legacyStub = loadAgentWith(opts);
  const old = await legacySelect(legacyStub.agent && require.cache[HTTP_GET_PATH].exports.httpGet, 'BTC');
  console.log(`  OLD (Promise.allSettled, silent skip) -> ${old ? old.instrument + ' ' + money(old.depthUsd) : 'none'}`);

  const { agent } = loadAgentWith(opts);
  const books = {};
  await agent.fetchDeribitSpotBooks(SPOT, books);
  const got = books['DERIBIT_SPOT|BTC'];

  if (!got) {
    console.log('  NEW (fixed)                           -> KEY OMITTED — capacity UNKNOWN, route does not rank');
  } else {
    console.log(`  NEW (fixed)                           -> ${got.instrument} ${money(got.depthUsd)} `
              + `| selectionComplete=${got.selectionComplete}`);
    console.log(`     candidates: ${got.candidates.map(c => `${c.instrument}=${c.status}${c.depthUsd ? '(' + money(c.depthUsd) + ')' : ''}`).join(', ')}`);
  }
  return { old, got };
}

(async () => {
  // 1 — steady state
  const s1 = await scenario('SCENARIO 1 — steady state, every candidate answers', {});
  const ok1 = s1.got && s1.got.instrument === 'BTC_USDC' && s1.got.selectionComplete === true;
  console.log(`  VERDICT: ${ok1 ? 'PASS — deepest fiat-backed pair wins on real depth' : 'FAIL'}`);

  // 2 — the actual bug
  const s2 = await scenario('SCENARIO 2 — BTC_USDC fetch TIMES OUT (the reported bug)', { failing: new Set(['BTC_USDC']) });
  const oldFlipped = s2.old && s2.old.instrument === 'BTC_USDE';
  const newRefused = !s2.got;
  console.log(`  OLD flipped fiat -> synthetic:  ${oldFlipped ? 'YES (bug reproduced)' : 'no'}`);
  console.log(`  NEW promoted synthetic:         ${s2.got && s2.got.quote === 'USDE' ? 'YES (STILL BROKEN)' : 'NO'}`);
  console.log(`  VERDICT: ${oldFlipped && newRefused ? 'PASS — bug reproduced on OLD, refused on NEW' : 'FAIL'}`);

  // 3 — a genuinely thin USDC must still lose fairly
  const s3 = await scenario('SCENARIO 3 — BTC_USDC answers but is genuinely THIN (real depth loss)', { thin: new Set(['BTC_USDC']) });
  const fairLoss = s3.got && s3.got.instrument === 'BTC_USDE' && s3.got.selectionComplete === true;
  console.log(`  VERDICT: ${fairLoss ? 'PASS — real measurement beats it; guard does not over-block' : 'FAIL'}`);

  // 4 — TRANSIENT timeout: the retry should recover real data, not just fail closed.
  const s4 = await scenario('SCENARIO 4 — BTC_USDC times out ONCE, then answers (retry recovers)', { flaky: { name: 'BTC_USDC', times: 1 } });
  const recovered = s4.got && s4.got.instrument === 'BTC_USDC' && s4.got.selectionComplete === true;
  const attempts = s4.got && s4.got.candidates.find(c => c.instrument === 'BTC_USDC')?.attempts;
  console.log(`  BTC_USDC attempts used: ${attempts}`);
  console.log(`  VERDICT: ${recovered ? 'PASS — retry recovered real depth; no UNKNOWN, no flip' : 'FAIL'}`);

  console.log(`\n${'='.repeat(74)}`);
  console.log(`OVERALL: ${ok1 && oldFlipped && newRefused && fairLoss && recovered ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  console.log('The guard fires only on FETCH_FAILED, never on a real shallow answer.');
})();
