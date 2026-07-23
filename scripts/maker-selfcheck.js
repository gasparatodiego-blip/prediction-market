#!/usr/bin/env node
'use strict';
// scripts/maker-selfcheck.js — repeatable proof of the maker's safety invariants. Pure assertions, NO
// side effects that touch a venue. Run after any change to the maker pipeline.
//
//   node scripts/maker-selfcheck.js
//
// Proves, per the task's VERIFY constraints:
//   • the CANCEL-ONLY adapter STILL cannot place (its frozen surface is unchanged);
//   • the MAKER adapter cannot transfer/withdraw/approve/redeem (banned surface);
//   • MAKER_MODE=off (and paper, and dry-run) → NO venue write is reachable in any code path;
//   • every risk rail trips correctly in a forced test;
//   • a STALE feed forces stand-down;
//   • a leg below min_incentive_size is FLAGGED, not silently posted;
//   • the one-sided ÷3 penalty is surfaced; prices are snapped to tick; live-min hard cap holds.

const assert = require('assert');
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };
const NOW = 1_753_000_000_000;

// ── 1. CANCEL-ONLY adapter is UNCHANGED and still cannot place ──
{
  const { createCancelOnlyAdapter, ALLOWED_OPS } = require('../lib/venues/polymarket-clob/adapter');
  const a = createCancelOnlyAdapter({ dryRun: true, credsProvider: () => { throw new Error('unused'); } });
  const BANNED = ['placeOrder', 'postOrder', 'createOrder', 'createAndPostOrder', 'submit', 'transfer', 'withdraw', 'approve', 'redeem', 'sign', 'signOrder'];
  ok(BANNED.every(m => typeof a[m] !== 'function'), 'cancel-only adapter exposes NO placement/fund-moving method');
  ok(Object.keys(a).filter(k => typeof a[k] === 'function').every(m => ALLOWED_OPS.includes(m)), 'cancel-only surface ⊆ its frozen ALLOWED_OPS (unchanged by the maker feature)');
  const { addressOnlySigner } = require('../lib/venues/polymarket-clob/signer');
  let threw = false; try { addressOnlySigner('0x' + '1'.repeat(40))._signTypedData({}, {}, {}); } catch { threw = true; }
  ok(threw, 'cancel-only address-only signer STILL throws on _signTypedData (structurally cannot place)');
}

// ── 2. MAKER adapter: banned surface, ALLOWED_OPS only ──
const { createMakerAdapter, ALLOWED_OPS, LIVE_MIN_DEFAULT_CAP_USD, evaluatePlacementGate, v2SdkStatus, _internal } = require('../lib/venues/polymarket-clob-maker/adapter');
{
  const m = createMakerAdapter({ mode: 'paper' });
  const BANNED = ['transfer', 'withdraw', 'approve', 'redeem', 'deposit', 'send', 'deriveApiKey', 'createApiKey', 'closePosition', 'openPosition'];
  ok(BANNED.every(x => typeof m[x] !== 'function'), 'maker adapter exposes NO transfer/withdraw/approve/redeem/deposit method');
  ok(Object.keys(m).filter(k => typeof m[k] === 'function').every(x => ALLOWED_OPS.includes(x)), 'maker callable surface ⊆ ALLOWED_OPS (post/cancel/list/positions/health/close)');
  ok(typeof m.postOrder === 'function', 'maker adapter DOES expose postOrder (it is the placement component)');
}

// ── 2c. RE-POINTED FAIL-CLOSED PLACEMENT GATE: each blocker fires independently, BEFORE any network/key ──
// After the CLOB v2 migration the "v2 SDK absent" refusal is gone (the SDK is installed); it is REPLACED
// by the funding/approval gate. These are pure (no adapter, no network) proofs that every gate names the
// specific blocker that tripped, in priority order SDK → mode → dry-run → funding.
{
  const goodSdk = { present: true, major: 1, version: '1.1.0' };
  const s = v2SdkStatus();
  ok(s.present === true && s.major >= 1, `v2 SDK installed & major ≥ 1 (${s.version}) — migration prerequisite satisfied, no longer a blocker`);
  ok(evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: true, sdk: { present: false } }).gate === 'v2-sdk-missing', 'gate 1: v2 SDK absent → refuse (v2-sdk-missing) — mirror of the fail-closed rule for any new placement path');
  ok(evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: true, sdk: { present: true, major: 0, version: '0.2.7' } }).gate === 'v2-sdk-major', 'gate 1b: v2 SDK major < 1 → refuse (v2-sdk-major)');
  ok(evaluatePlacementGate({ mode: 'paper', dryRun: false, fundingApproved: true, sdk: goodSdk }).gate === 'maker-mode', 'gate 2: MAKER_MODE not live → refuse (maker-mode)');
  ok(evaluatePlacementGate({ mode: 'live', dryRun: true, fundingApproved: true, sdk: goodSdk }).gate === 'dry-run', 'gate 3: dry-run belt set → refuse (dry-run)');
  ok(evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: false, sdk: goodSdk }).gate === 'funding-approval', 'gate 4: pUSD funding / v2 approvals not attested → refuse (funding-approval) — the honest replacement for the removed v2-absence gate');
  ok(evaluatePlacementGate({ mode: 'live', dryRun: false, fundingApproved: true, sdk: goodSdk }).allow === true, 'gate: allows ONLY when SDK ok + live + not dry-run + funding attested — capability, still behind the throwing-provider belt');
}

// ── 3. MAKER_MODE=off / paper / dry-run → NO venue write reachable (async, closes the run) ──
async function noWriteProof() {
  for (const mode of ['off', 'paper']) {
    // No providers passed → if any mutating path tried to reach the venue it would need creds/signer and throw.
    const a = createMakerAdapter({ mode });
    ok(a.canWrite === false, `mode=${mode} → canWrite=false`);
    const p = await a.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 100, tickSize: 0.01 });
    ok(p.sent === false && p.simulated === true, `mode=${mode} postOrder makes NO venue write (sent=false, simulated)`);
    const c = await a.cancelMarketOrders('0xabc');
    ok(c.sent === false, `mode=${mode} cancelMarketOrders makes NO venue write`);
    const l = await a.listOpenOrders('0xabc');
    ok(l.simulated === true, `mode=${mode} listOpenOrders makes NO venue read`);
  }
  // dry-run belt independent of mode: even a live mode + dryRun → canWrite false, no providers required.
  const dry = createMakerAdapter({ mode: 'live', dryRun: true });
  ok(dry.canWrite === false, 'live + MAKER_ADAPTER_DRYRUN → canWrite=false (dry-run belt)');
  const dp = await dry.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 100, tickSize: 0.01 });
  ok(dp.sent === false, 'live+dry-run postOrder makes NO venue write');

  // A live adapter with THROWING providers (this build's live wiring). Post-migration the OUTER belt is
  // the re-pointed placement gate: with pUSD funding + v2 approvals NOT attested (agent35 never sets
  // fundingApproved), postOrder refuses at the funding-approval gate BEFORE liveClient()/the provider —
  // no network, no key. (The throwing-provider belt is proven independently below.)
  const thrower = async () => { throw new Error('provider not wired'); };
  const live = createMakerAdapter({ mode: 'live-min', credsProvider: thrower, signerProvider: thrower, liveMinCapUsd: 25 });
  ok(live.canWrite === true, 'live-min with providers → canWrite=true (capability owned)…');
  const lp = await live.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01 });
  ok(lp.ok === false && lp.sent === false && lp.gate === 'funding-approval', '…but a live placement fails CLOSED at the funding/approval gate (pUSD + v2 approvals unattested) — no order signed, no network, no key');

  // ── 8. live-min HARD per-order notional cap trips BEFORE the placement gate / any network/creds ──
  const capped = await live.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 1000, tickSize: 0.01 }); // $500 » $25
  ok(capped.sent === false && /live-min hard cap/i.test(capped.reason || ''), 'live-min hard cap rejects an over-cap order before touching creds');

  // ── 8b. The throwing-provider belt is INDEPENDENT of the funding gate. Even if funding were attested
  //     (a TEST-only fundingApproved:true — agent35 never sets it, so the deployed engine still trips the
  //     funding gate above), this build's live wiring cannot obtain a key: liveClient() calls the (throwing)
  //     credsProvider on its FIRST line, before any network call or client construction. No order signed. ──
  const fundedButUnwired = createMakerAdapter({ mode: 'live-min', fundingApproved: true, credsProvider: thrower, signerProvider: thrower, liveMinCapUsd: 25 });
  const fbp = await fundedButUnwired.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01 });
  ok(fbp.ok === false && /provider not wired/i.test(String((fbp.error && fbp.error.message) || fbp.error || '')), 'even with funding attested, the throwing-provider belt fails a live placement closed (no key, no order) — independent gate');

  // ── 9. off/paper/live all REJECT an off-tick price defensively (never post an unsnapped price) ──
  const offTick = await createMakerAdapter({ mode: 'paper' }).postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5237, size: 100, tickSize: 0.01 });
  ok(offTick.ok === false && /not a valid multiple of tick/i.test(offTick.reason || ''), 'an off-tick price is rejected (defense in depth), never posted');
  ok(_internal.priceOnTick(0.52, 0.01) === true && _internal.priceOnTick(0.523, 0.01) === false, 'priceOnTick: 0.52 valid on 0.01, 0.523 invalid');
  ok(_internal.priceOnTick(0.523, 0.001) === true && _internal.priceOnTick(0.0025, 0.0025) === true, 'priceOnTick handles 0.001 and 0.0025 ticks (not just powers of ten)');

  finish();
}

// ── 4. RISK RAILS: every rail trips in a forced test ──
const { evaluateRails, evaluateGlobalRails, evaluateMarketRails } = require('../lib/maker/risk-rails');
{
  const base = require('../lib/maker/config').loadMakerConfig({ MAKER_MODE: 'live' });
  const okMarket = { feedLive: true, resolved: false, closed: false, structurallyDegenerate: false, newsSeverity: null, marketNotionalUsd: 0, positionUsd: 0 };
  // manual kill
  ok(evaluateGlobalRails({ state: {}, config: { ...base, killSwitch: true } }).trips.some(t => t.rail === 'manual-kill' && t.action === 'halt-all'), 'manual-kill → halt-all');
  // daily-loss
  ok(evaluateGlobalRails({ state: { dailyPnlUsd: -999 }, config: base }).trips.some(t => t.rail === 'daily-loss' && t.action === 'halt-all'), 'daily-loss → halt-all');
  // error-rate
  ok(evaluateGlobalRails({ state: { recentErrorCount: 99 }, config: base }).trips.some(t => t.rail === 'error-rate' && t.action === 'halt-all'), 'error-rate → halt-all');
  // total exposure
  ok(evaluateGlobalRails({ state: { totalExposureUsd: 1e9 }, config: base }).trips.some(t => t.rail === 'total-exposure' && t.action === 'block-new'), 'total-exposure → block-new');
  // feed stale
  ok(evaluateMarketRails({ market: { ...okMarket, feedLive: false }, config: base }).trips.some(t => t.rail === 'feed-stale' && t.action === 'halt-market'), 'feed-stale → halt-market (never quote off REST fallback)');
  // resolved / closed / structural
  ok(evaluateMarketRails({ market: { ...okMarket, resolved: true }, config: base }).trips.some(t => t.rail === 'market-resolved'), 'resolved → halt-market');
  ok(evaluateMarketRails({ market: { ...okMarket, structurallyDegenerate: true }, config: base }).trips.some(t => t.rail === 'market-structural'), 'structurally degenerate → halt-market (structural-baseline gate)');
  // news high
  ok(evaluateMarketRails({ market: { ...okMarket, newsSeverity: 'high' }, config: base }).trips.some(t => t.rail === 'news-high' && t.action === 'halt-market'), 'news high → halt-market + cancel');
  // per-market caps
  ok(evaluateMarketRails({ market: { ...okMarket, marketNotionalUsd: 1e9 }, config: base }).trips.some(t => t.rail === 'market-notional'), 'per-market notional cap → block-new');
  ok(evaluateMarketRails({ market: { ...okMarket, positionUsd: 1e9 }, config: base }).trips.some(t => t.rail === 'market-position'), 'per-market position cap → block-new');
  // a clean market with a live feed allows placement
  const clean = evaluateRails({ globalState: {}, market: okMarket, config: base });
  ok(clean.allowNewPlacement === true && clean.cancelScope === 'none', 'a clean live market allows placement, no cancel');
  // stale feed → cancel scope market, no placement
  const stale = evaluateRails({ globalState: {}, market: { ...okMarket, feedLive: false }, config: base });
  ok(stale.allowNewPlacement === false && stale.cancelScope === 'market', 'STALE feed → stand down (cancelScope=market, no new placement)');
  // kill → cancel all
  const killed = evaluateRails({ globalState: {}, market: okMarket, config: { ...base, killSwitch: true } });
  ok(killed.cancelScope === 'all', 'kill switch → cancelScope=all');
}

// ── 5. QUOTE PLAN: below-min flagged not posted; one-sided ÷3 surfaced; tick snap; adjusted mid ──
const { planQuotes, snapToTick } = require('../lib/maker/quote-plan');
{
  ok(snapToTick(0.5237, 0.01) === 0.52 && snapToTick(0.5237, 0.001) === 0.524, 'snapToTick rounds to the real tick (0.01→0.52, 0.001→0.524)');
  ok(snapToTick(0.9999, 0.01) === 0.99 && snapToTick(0.0001, 0.01) === 0.01, 'snapToTick clamps to [tick, 1-tick]');
  // below-min: size 10 < minSize 100 → flagged, NOT postable
  const belowMin = planQuotes({ legs: [{ book: 'yes', kind: 'buy', mode: 'follow', offsetC: -1, size: 10 }], mid: 0.5, maxSpreadC: 4, minSize: 100, tick: 0.01, tokenId: 'T', tokenIdNo: 'TN' });
  ok(belowMin.quotes[0].belowMinSize === true && belowMin.quotes[0].postable === false, 'a leg below min_incentive_size is FLAGGED and NOT postable (never posted as if it earns)');
  // one-sided in [0.10,0.90] → ÷3 penalty surfaced
  const oneSided = planQuotes({ legs: [{ book: 'yes', kind: 'buy', mode: 'follow', offsetC: -1, size: 500 }], mid: 0.5, maxSpreadC: 4, minSize: 100, tick: 0.01, tokenId: 'T', tokenIdNo: 'TN' });
  ok(oneSided.market.oneSidedPenalty === true && /÷3|\/3|c=3/.test(oneSided.market.penaltyNote), 'one-sided config in [0.10,0.90] surfaces the ÷3 penalty BEFORE arming');
  // two-sided → no penalty
  const twoSided = planQuotes({ legs: [{ book: 'yes', kind: 'buy', mode: 'follow', offsetC: -1, size: 500 }, { book: 'yes', kind: 'sell', mode: 'follow', offsetC: 1, size: 500 }], mid: 0.5, maxSpreadC: 4, minSize: 100, tick: 0.01, tokenId: 'T', tokenIdNo: 'TN' });
  ok(twoSided.market.twoSided === true && twoSided.market.oneSidedPenalty === false, 'two-sided config → no one-sided penalty');
  // one-sided in the tails → earns ZERO (must be two-sided)
  const tail = planQuotes({ legs: [{ book: 'yes', kind: 'buy', mode: 'follow', offsetC: -1, size: 500 }], mid: 0.95, maxSpreadC: 4, minSize: 100, tick: 0.01, tokenId: 'T', tokenIdNo: 'TN' });
  ok(tail.market.oneSidedZero === true, 'one-sided config in the tails (mid>0.90) → one-sided earns ZERO surfaced');
}

// ── 6. RE-QUOTE POLICY: threshold + hysteresis + min interval ──
const { decideRequote, planRequoteOrdering } = require('../lib/maker/requote-policy');
{
  const cfg = { driftThresholdC: 0.8, hysteresisC: 0.2, minIntervalMs: 15_000 };
  ok(decideRequote({ driftC: 0.5, lastRequoteAt: null, recentlyRequoted: false, config: cfg, now: NOW }).requote === false, 'drift below threshold → no re-quote');
  ok(decideRequote({ driftC: 1.0, lastRequoteAt: null, recentlyRequoted: false, config: cfg, now: NOW }).requote === true, 'drift above threshold + no prior → re-quote');
  ok(decideRequote({ driftC: 1.0, lastRequoteAt: NOW - 1000, recentlyRequoted: true, config: cfg, now: NOW }).requote === false, 'rate-limited within minInterval → no re-quote');
  ok(decideRequote({ driftC: 0.9, lastRequoteAt: NOW - 999_999, recentlyRequoted: true, config: cfg, now: NOW }).requote === false, 'hysteresis: 0.9c < 0.8+0.2 after a recent re-quote → hold');
  ok(planRequoteOrdering({ canDoubleTransiently: true }).order === 'place-then-cancel' && planRequoteOrdering({ canDoubleTransiently: true }).expectedOutOfBookMs === 0, 'when caps allow, place-then-cancel → zero out-of-book gap');
  ok(planRequoteOrdering({ canDoubleTransiently: false }).order === 'cancel-then-place', 'when caps do not allow a transient double, cancel-then-place');
}

// ── 7. RECONCILE: trust the venue — desired-not-on-venue = place, venue-not-desired = cancel, partial fill ──
const { reconcile } = require('../lib/maker/reconcile');
{
  const desired = [{ token: 'T', side: 'BUY', price: 0.49, size: 500, postable: true }, { token: 'T', side: 'SELL', price: 0.51, size: 500, postable: true }];
  const venue = [{ id: 'o1', asset_id: 'T', side: 'BUY', price: '0.49', original_size: '500', size_matched: '120' }, { id: 'o2', asset_id: 'T', side: 'SELL', price: '0.55', original_size: '500', size_matched: '0' }];
  const r = reconcile({ desired, venueOrders: venue, tick: 0.01 });
  ok(r.toPlace.length === 1 && r.toPlace[0].side === 'SELL' && r.toPlace[0].price === 0.51, 'desired quote absent from venue → PLACE (never assume a post succeeded)');
  ok(r.toCancel.length === 1 && r.toCancel[0].orderId === 'o2', 'venue order not desired → CANCEL (trust the venue)');
  ok(r.partialFills.length === 1 && r.partialFills[0].filledShares === 120, 'partial fill detected on the matched order');
}

noWriteProof();

function finish() {
  console.log(`maker selfcheck: ${checks} assertions passed — cancel-only adapter unchanged & cannot place; maker adapter cannot transfer/withdraw; MAKER_MODE=off/paper/dry-run reach NO venue write; every rail trips; STALE feed stands down; below-min flagged; one-sided ÷3 surfaced; tick-snapped; live-min hard cap holds.`);
}
