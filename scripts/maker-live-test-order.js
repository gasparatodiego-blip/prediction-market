#!/usr/bin/env node
'use strict';
// scripts/maker-live-test-order.js — place ONE deep post-only GTD order, verify it from the VENUE, cancel
// it, confirm it is gone, and disarm. The FIRST end-to-end proof of the live Polymarket order path.
//
// ONE ORDER. NOT A LOOP. It builds the maker adapter EXACTLY as agent35.buildAdapter does (the real
// custody providers wired in Phase 1) so it proves the identical wire — but it places a single order via a
// controlled sequence and guarantees a cancel + signer-scrub in a finally block. agent35's own pm2 process
// stays MAKER_MODE=off throughout; only this ephemeral process is briefly armed, for one order.
//
// SAFETY, in layers:
//   • post-only (rejected by the venue if it would cross) → cannot fill on entry.
//   • priced at the FAR edge of the reward band, below the book → rests deep, overwhelmingly unlikely to
//     fill in the seconds it rests. (The shared venue-rules guard REFUSES an out-of-band order, so the
//     band edge is the deepest a fully-gated order can go — see the report.)
//   • sized from REAL readable proxy collateral, and HARD-refused if notional ≥ $5 or ≥ collateral.
//   • a native GTD expiry (≈120s) backstops even a failed cancel.
//   • finally{}: cancel the order, re-list to confirm it is gone, scrub the signing key.
// Never prints a private key or any decrypted secret.

const fs = require('fs');
const path = require('path');

// Minimal .env loader (dotenv is not installed): fill only MISSING keys so DATABASE_URL / the funder vars
// are present. Values are NEVER printed (only the public funder address + sig-type are echoed, below).
(function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    try {
      const txt = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2].replace(/\r$/, '');
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch { /* file absent → fine */ }
  }
})();

const { createMakerAdapter } = require('../lib/venues/polymarket-clob-maker/adapter');
const { makerLiveProviders } = require('../lib/maker/live-providers');
const { validateQuote } = require('../lib/maker/venue-rules');
const { computeGtdExpiration } = require('../lib/maker/order-ttl');
const { resolveFunder } = require('../lib/venues/polymarket-clob-maker/funder');
const { JsonRpcProvider, Contract, formatUnits } = require('ethers');
const { PUSD, DEFAULT_RPC } = require('../lib/poly-contracts');
const { httpGet } = require('../lib/httpGet');

const HARD_USD_CAP = 5;      // this script REFUSES any order whose notional ≥ $5 (task: under $5)
const TTL_SECONDS = 60;      // clamps UP to the venue's 120s GTD floor
const CLOB = 'https://clob.polymarket.com';
const RPC = process.env.POLYGON_RPC_URL || DEFAULT_RPC;
const line = (...a) => console.log(...a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

async function venueTick(tokenId) {
  try {
    const r = await httpGet(`${CLOB}/tick-size?token_id=${tokenId}`, { timeoutMs: 6000, headers: { Accept: 'application/json' } });
    const t = r && r.status === 200 ? parseFloat(r.data.minimum_tick_size) : null;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Pick the smallest-notional liquid candidate: a market where minSize × band-edge-price < HARD_USD_CAP and
// a LIVE book exists (so post-only + cancel are tested against a real book).
function pickMarket() {
  const feed = readJson('/tmp/liquidity-rewards.json');
  const live = (readJson('/tmp/clob-live-books.json') || {}).markets || {};
  const out = [];
  for (const m of (feed && feed.markets) || []) {
    const rs = m.rewardScore; if (!rs) continue;
    const feedMid = rs.mid, ms = rs.maxSpreadCents, minS = rs.minSize, tick = rs.tick || m.tickSize;
    if (!(feedMid > 0 && feedMid < 1) || !(ms > 0) || !(minS >= 0) || !(tick > 0)) continue;
    const lb = live[m.marketId];
    if (!(lb && lb.live && Number.isFinite(lb.mid) && lb.yes && lb.yes.levels)) continue; // live book required
    const mid = lb.mid;                                    // freshest scoring mid (ws-live)
    const edgeRaw = mid - (ms / 2) / 100;
    const price = Math.round(edgeRaw / tick) * tick;
    if (!(price >= tick)) continue;
    const notional = minS * price;
    if (!(notional > 0 && notional < HARD_USD_CAP - 0.5)) continue;
    const tokenId = m.tokenId || (Array.isArray(m.tokens) && m.tokens[0]);
    if (!tokenId) continue;
    out.push({ marketId: m.marketId, tokenId, mid, maxSpreadCents: ms, minSize: minS, tick, price: +price.toFixed(6), notional: +notional.toFixed(4), bestBid: lb.yes.bestBid, bestAsk: lb.yes.bestAsk });
  }
  out.sort((a, b) => a.notional - b.notional);
  return out[0] || null;
}

async function main() {
  line('== MAKER LIVE TEST ORDER — one post-only GTD order, venue-verified cancel ==');
  line('RPC:', RPC);

  // ── funder / signer roles (proves which address is signer, which is maker/funder) ──
  const funder = resolveFunder(process.env);
  line('\n[roles]');
  line('  signer (signs the order)      : from custody signing key (printed by healthCheck below)');
  line('  maker/funder (holds funds)    :', funder.funderAddress || '(none — EOA self-custody)');
  line('  signatureType                 :', funder.signatureType, '(1 = POLY_PROXY: EOA signs FOR the proxy)');
  if (!funder.funderAddress) { line('REFUSE: no funder configured — an order would settle against the empty signer. Aborting.'); process.exit(2); }

  const { credsProvider, signerProvider } = makerLiveProviders();
  const adapter = createMakerAdapter({
    mode: 'live-min', fundingApproved: true, liveMinCapUsd: 25, orderTtlSeconds: TTL_SECONDS,
    credsProvider, signerProvider, funder,
  });

  let orderId = null;
  let cancelConfirmed = false;
  let filled = false;
  const market = pickMarket();
  try {
    // ── 1. LIVE AUTH (read-only) — proves creds + signer + connectivity BEFORE placing anything ──
    const hc = await adapter.healthCheck();
    if (!hc.ok) { line('REFUSE: healthCheck failed (auth/connectivity):', hc.error); process.exit(2); }
    const openBefore = hc.openOrders;
    line('\n[healthCheck] authenticated:', hc.authenticated, '| signer:', hc.address, '| funder:', hc.funderAddress, '| sigType:', hc.signatureType);
    line('  open orders BEFORE:', openBefore);

    // ── 2. REAL proxy collateral, read live on-chain ──
    const prov = new JsonRpcProvider(RPC);
    let collateral = null;
    try {
      const c = new Contract(PUSD, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], prov);
      let dec = 6; try { dec = Number(await c.decimals()); } catch { /* default */ }
      collateral = Number(formatUnits(await c.balanceOf(funder.funderAddress), dec));
    } finally { try { prov.destroy(); } catch { /* ignore */ } }
    line('\n[collateral] proxy pUSD balance (live on-chain):', collateral == null ? '— (unreadable)' : `$${collateral.toFixed(6)}`);
    if (collateral == null) { line('REFUSE: could not read proxy collateral — refusing to size an order against an unknown balance.'); process.exit(2); }

    // ── 3. pick market + compute the deep, in-band, on-tick, post-only BUY ──
    if (!market) { line('REFUSE: no liquid market with a fundable (<$5) band-edge order was found right now.'); process.exit(2); }
    const venueTickSize = await venueTick(market.tokenId);
    const tick = Number.isFinite(venueTickSize) ? venueTickSize : market.tick;   // authoritative venue tick
    const price = +(Math.round((market.mid - (market.maxSpreadCents / 2) / 100) / tick) * tick).toFixed(6);
    const sizeArg = (process.argv.find(a => a.startsWith('--size=')) || '').split('=')[1];
    const size = sizeArg && Number(sizeArg) >= market.minSize ? Number(sizeArg) : market.minSize;
    const notional = +(price * size).toFixed(4);
    line('\n[order]');
    line('  market  :', market.marketId);
    line('  token   :', market.tokenId);
    line('  live mid:', market.mid, '| best bid/ask:', market.bestBid, '/', market.bestAsk, '| band ±', (market.maxSpreadCents / 2).toFixed(2), '¢');
    line('  side    : BUY (post-only)  price:', price, `(${((market.mid - price) * 100).toFixed(2)}¢ below mid, deep in book)`);
    line('  size    :', size, 'shares (= min_incentive_size)  tick:', tick);
    line('  notional:', `$${notional.toFixed(4)}`);

    // ── 4. HARD refusals — verify against REAL collateral and the $5 cap; never downsize silently ──
    const venueRules = { tick, scoringMid: market.mid, maxSpreadCents: market.maxSpreadCents, minSize: market.minSize };
    const vq = validateQuote(venueRules, { side: 'BUY', price, size });
    if (!vq.valid) { line('REFUSE: venue-rules guard rejects this quote:', vq.reasons.map(r => r.code).join(',')); process.exit(2); }
    if (!(notional > 0) || notional >= HARD_USD_CAP) { line(`REFUSE: notional $${notional} is not under the $${HARD_USD_CAP} cap.`); process.exit(2); }
    if (notional >= collateral) { line(`REFUSE: notional $${notional} ≥ available collateral $${collateral.toFixed(4)} — refusing (no silent downsize).`); process.exit(2); }
    line('  size < collateral:', `$${notional} < $${collateral.toFixed(4)}  ✓`);

    // expected GTD expiry (same fn the adapter uses) — for the submitted-vs-observed comparison
    const t0 = Date.now();
    const expected = computeGtdExpiration(t0, TTL_SECONDS);
    line('\n[expiry] submitting GTD:', expected.orderType, '| requested TTL', expected.requestedTtlSeconds + 's → effective', expected.effectiveTtlSeconds + 's', expected.clampedToVenueFloor ? '(clamped up to venue floor)' : '');
    line('  expected expiration (unix):', expected.expiration, '=', new Date(expected.expiration * 1000).toISOString());

    if (process.argv.includes('--dry')) {
      line('\n[dry] --dry set: auth + collateral + market + all gates validated, NOT placing. Re-run without --dry to place.');
      try { adapter.close(); } catch { /* ignore */ }
      process.exit(0);
    }

    // ── 5. PLACE THE ORDER ──
    line('\n[place] posting the order …');
    const res = await adapter.postOrder({ tokenId: market.tokenId, side: 'BUY', price, size, tickSize: tick, postOnly: true, venueRules, ttlSeconds: TTL_SECONDS });
    line('  postOrder → ok:', res.ok, '| sent:', res.sent, '| gate:', res.gate || '(none)', '| orderId:', res.orderId || '(none)');
    line('  FULL venue response:', JSON.stringify(res.response || res).slice(0, 600));
    // The venue can return an HTTP error object (e.g. 403) WITHOUT success:false — treat any non-2xx status
    // or an explicit failure as a rejection, not a success, so a rejected order is never reported as placed.
    const vstatus = res.response && (res.response.status || (res.response.data && res.response.data.status));
    if (vstatus && Number(vstatus) >= 400) {
      line('  venue returned HTTP', vstatus, '→ REJECTED. The order was NOT placed. Reason:', JSON.stringify(res.response).slice(0, 400));
      try { await adapter.cancelMarketOrders(market.marketId); } catch { /* best-effort */ }
      return;
    }
    if (res.gate) { line('  REFUSED at gate:', res.gate, '—', res.reason); process.exit(2); }
    if (!res.sent) { line('  NOT SENT — reason:', res.reason || JSON.stringify(res)); process.exit(2); }
    if (!res.ok) {
      const errTxt = JSON.stringify(res.error || res.response || res);
      line('  venue REJECTED the order:', errTxt.slice(0, 300));
      if (/post[- ]?only|would cross|marketable/i.test(errTxt)) line('  → post-only/GTD was rejected by the venue. STOPPING per task (no fallback to a plain limit order).');
      // A rejected order does not rest, but sweep defensively before exiting — then finally scrubs the key.
      try { await adapter.cancelMarketOrders(market.marketId); } catch { /* best-effort */ }
      return;
    }
    orderId = res.orderId;
    if (!orderId) {
      line('  order accepted but NO order id returned — sweeping the market to clear any id-less resting order.');
      try { const sw = await adapter.cancelMarketOrders(market.marketId); line('  sweep:', JSON.stringify(sw).slice(0, 160)); } catch (e) { line('  sweep error:', String(e && e.message).slice(0, 120)); }
      const l = await adapter.listOpenOrders(market.marketId);
      line('  open orders after sweep:', l.count, l.count === openBefore ? '(back to prior — nothing left resting)' : '(⚠ verify)');
      return;
    }

    // ── 6. VERIFY FROM THE VENUE ──
    const list1 = await adapter.listOpenOrders(market.marketId);
    const mine = (list1.orders || []).find(o => (o.id || o.orderID || o.orderId) === orderId) || null;
    line('\n[verify] open orders DURING:', list1.count);
    if (!mine) {
      line('  order id', orderId, 'NOT found resting — it may have filled or been rejected. Inspecting …');
    } else {
      const state = mine.status || mine.state || '(no status field)';
      const observedExp = mine.expiration != null ? Number(mine.expiration) : null;
      const sizeMatched = Number(mine.size_matched || mine.sizeMatched || 0);
      line('  RESTING order:', orderId);
      line('    venue state      :', state);
      line('    size_matched     :', sizeMatched, sizeMatched > 0 ? '⚠ PARTIALLY FILLED' : '(unfilled)');
      line('    post-only proof  : accepted & resting without crossing (a marketable post-only order is rejected, not rested)');
      line('    observed expiry  :', observedExp, observedExp ? '= ' + new Date(observedExp * 1000).toISOString() : '(none reported)');
      line('    submitted expiry :', expected.expiration, '= ' + new Date(expected.expiration * 1000).toISOString());
      if (observedExp != null) {
        const drift = Math.abs(observedExp - expected.expiration);
        line('    submitted↔observed drift:', drift + 's', drift <= 10 ? '✓ (match within tolerance)' : '⚠ (mismatch)');
      }
      if (sizeMatched > 0) filled = true;
    }

    // ── 7. CANCEL EXPLICITLY + CONFIRM GONE FROM THE VENUE ──
    line('\n[cancel] cancelling', orderId, '…');
    const cx = await adapter.cancelOrder(orderId);
    line('  cancelOrder → ok:', cx.ok, '| noop:', !!cx.noop, '| error:', cx.error || '(none)');
    const list2 = await adapter.listOpenOrders(market.marketId);
    const still = (list2.orders || []).some(o => (o.id || o.orderID || o.orderId) === orderId);
    line('  open orders AFTER:', list2.count, '| our order still present:', still);
    cancelConfirmed = cx.ok && !still && list2.count <= openBefore;
    line('  count returned to prior value (', openBefore, '):', list2.count === openBefore ? '✓' : `(now ${list2.count})`);

    // ── 8. CONFIRM NO FILL ──
    const pos = await adapter.getPositions(market.marketId);
    const posForToken = (pos.positions || []).filter(p => String(p.asset || p.tokenId || p.token_id || '') === String(market.tokenId) && Number(p.size || p.amount || 0) > 0);
    line('\n[fills] positions on this market for our token:', posForToken.length, '| filled flag:', filled);
    line('  dollars spent:', filled || posForToken.length ? 'NON-ZERO — see fills above' : '$0.00 (order cancelled unfilled; maker pays no gas)');

    line('\n== RESULT ==');
    if (cancelConfirmed && !filled && !posForToken.length) {
      line('CANCEL CONFIRMED LIVE. order rested post-only, GTD expiry observed, cancelled and gone from the venue, never filled.');
    } else if (filled || posForToken.length) {
      line('ORDER FILLED (unexpected) — see fills. Position exists; report NOT SAFE and reconcile.');
    } else {
      line('CANCEL NOT FULLY CONFIRMED — see counts above.');
    }
    line(JSON.stringify({ orderId, openBefore, openAfter: list2.count, cancelConfirmed, filled, notional, price, size, marketId: market.marketId }));
  } finally {
    // GUARANTEE: never leave a resting order. If the explicit cancel did not confirm, sweep the market and
    // retry the id, then close (scrub the signing key).
    if (orderId && !cancelConfirmed) {
      try {
        line('\n[finally] cancel unconfirmed — sweeping market + retrying cancel …');
        if (market) await adapter.cancelMarketOrders(market.marketId);
        await adapter.cancelOrder(orderId);
        if (market) {
          const l = await adapter.listOpenOrders(market.marketId);
          const still = (l.orders || []).some(o => (o.id || o.orderID || o.orderId) === orderId);
          line('[finally] after sweep — our order still present:', still, '| open orders:', l.count);
          if (still) line('[finally] ⚠ ORDER STILL RESTING — id ' + orderId + ' (GTD will expire it ≤120s). Report ORDER STILL RESTING.');
        }
      } catch (e) { line('[finally] sweep error:', String(e && e.message).slice(0, 160)); }
    }
    try { adapter.close(); } catch { /* ignore */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('test-order failed:', String(e && e.message ? e.message : e).slice(0, 240)); process.exit(1); });
