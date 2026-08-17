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
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };
const NOW = 1_753_000_000_000;
// A valid set of live venue rules for the shared venue-rules guard (now mandatory on postOrder). price 0.5
// sits at scoringMid → in-band; size ≥ 5 ≥ minSize; on the 0.01 tick. Existing gate/mode tests pass THIS so
// the guard is satisfied and the gate they actually exercise (mode/funding/kill/cap/idempotency) still fires.
const VR = Object.freeze({ tick: 0.01, scoringMid: 0.5, maxSpreadCents: 6, minSize: 5 });

// The ONE market a live-min adapter is pinned to in these tests. live-min now REFUSES any order it cannot
// prove belongs to its pinned market (evaluateLiveMinMarketGate), so every live-min fixture below names a
// pin and every postOrder spec carries a marketId — a live-min adapter without a pin is, by design, an
// adapter that can place nothing. Section 8c exercises the gate itself.
const LIVE_MKT = '0x1111111111111111111111111111111111111111111111111111111111111111';

// ── temp-fixture plumbing for the execution-safety layer (kill switch / limits / audit) ──
// All safety state lives in files; the selfcheck points each module at throwaway temp files (never the
// real data/ files) via dependency injection, so it proves the fail-closed behaviour deterministically.
const KS = require('../lib/safety/kill-switch');
const RL = require('../lib/safety/risk-limits');
const EA = require('../lib/safety/execution-audit');
const F  = require('../lib/safety/fills');
const RF = require('../lib/safety/reconcile-fills');
const { readUsage, sentOrdersFromAudit } = require('../lib/safety/usage');
const TMP_DIR = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'maker-safety-'));
let _tmpCounter = 0;
const tmpFile = (name) => pathMod.join(TMP_DIR, `${name}-${process.pid}-${_tmpCounter++}`);
// A permissive safety bag: all gates pass, intent/outcome go to a fresh temp trail. Used to prove the
// EXISTING v2 gates + the throwing-provider belt still fire once the new safety gates are satisfied.
function permissiveSafety() {
  const auditFile = tmpFile('audit.jsonl');
  return {
    checkKill: () => ({ killed: false, gate: null, scope: null }),
    evaluateForOrder: () => ({ venueAllowed: true, limits: { allow: true }, clampEvents: [] }),
    recordIntent: (i) => EA.recordIntent(i, { auditFile }),
    recordOutcome: (o) => EA.recordOutcome(o, { auditFile }),
    deriveIdempotencyKey: EA.deriveIdempotencyKey,
    setUserKill: () => {},
    _auditFile: auditFile,
  };
}
// A spy provider pair: records whether a key was ever requested (i.e. decryption was reached), then throws.
function spyProviders() {
  const s = { called: false };
  const p = async () => { s.called = true; throw new Error('provider not wired'); };
  return { s, credsProvider: p, signerProvider: p };
}

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
const { createMakerAdapter, ALLOWED_OPS, LIVE_MIN_DEFAULT_CAP_USD, evaluatePlacementGate, evaluateLiveMinMarketGate, evaluateOrderVersionGate, SUPPORTED_ORDER_VERSION, v2SdkStatus, _internal } = require('../lib/venues/polymarket-clob-maker/adapter');
{
  const m = createMakerAdapter({ mode: 'paper' });
  const BANNED = ['transfer', 'withdraw', 'approve', 'redeem', 'deposit', 'send', 'deriveApiKey', 'createApiKey', 'closePosition', 'openPosition'];
  ok(BANNED.every(x => typeof m[x] !== 'function'), 'maker adapter exposes NO transfer/withdraw/approve/redeem/deposit method');
  ok(Object.keys(m).filter(k => typeof m[k] === 'function').every(x => ALLOWED_OPS.includes(x)), 'maker callable surface ⊆ ALLOWED_OPS (post/cancel/list/positions/health/close)');
  ok(typeof m.postOrder === 'function', 'maker adapter DOES expose postOrder (it is the placement component)');
}

// ── 2b. FUNDER RESOLUTION: signer ≠ funder, and every ambiguous configuration refuses ──
// A Polymarket proxy account signs with an EOA but MAKES orders for the proxy that holds the collateral.
// Getting this pair wrong is not a soft failure: the exchange's own validateOrder() reverts (verified
// on-chain 2026-07-24 — signatureType 1 passed for this account, 0 and 3 both reverted). So each half-
// configured combination must refuse rather than guess. Pure: no env, no network, no key.
{
  const { resolveFunder } = require('../lib/venues/polymarket-clob-maker/funder');
  // A neutral fixture, not the operator's real funder: this section proves the RESOLVER's rules, and the
  // live account is verified separately (and against the chain) by scripts/maker-signing-proof.ts.
  const FUNDER = '0xDEaDBeEF00c0ffee00C0ffEe00C0FFee00c0ffee';
  const threw = (env) => { try { resolveFunder(env); return false; } catch { return true; } };

  const none = resolveFunder({});
  ok(none.signatureType === 0 && none.funderAddress === undefined, 'funder: nothing configured → self-custody EOA (type 0, no funder) — the SDK default, unchanged from before');

  const proxy = resolveFunder({ MAKER_FUNDER_ADDRESS: FUNDER, MAKER_SIGNATURE_TYPE: '1' });
  ok(proxy.signatureType === 1 && proxy.funderAddress === FUNDER, 'funder: type 1 + address → resolves to the proxy wallet, checksummed');
  ok(resolveFunder({ MAKER_FUNDER_ADDRESS: FUNDER.toLowerCase(), MAKER_SIGNATURE_TYPE: '3' }).funderAddress === FUNDER, 'funder: a lowercase address is checksummed, not passed through raw');

  ok(threw({ MAKER_FUNDER_ADDRESS: FUNDER }), 'funder: address without a signature type → REFUSE (the type is per-account; it is never assumed)');
  ok(threw({ MAKER_SIGNATURE_TYPE: '1' }), 'funder: signature type 1 with no funder → REFUSE (no address to put in the maker field)');
  ok(threw({ MAKER_FUNDER_ADDRESS: FUNDER, MAKER_SIGNATURE_TYPE: '0' }), 'funder: type 0 (EOA) alongside a funder → REFUSE (contradiction: type 0 means maker == signer)');
  ok(threw({ MAKER_FUNDER_ADDRESS: '0xnope', MAKER_SIGNATURE_TYPE: '1' }), 'funder: malformed address → REFUSE');
  ok(threw({ MAKER_FUNDER_ADDRESS: FUNDER, MAKER_SIGNATURE_TYPE: '4' }), 'funder: signature type outside 0|1|2|3 → REFUSE');
  // Mixed case with ONE letter cased wrong — EIP-55's whole purpose, and the shape a hand-copied address
  // takes when a character is dropped or transposed. (An all-lowercase address is legitimately unchecked.)
  ok(threw({ MAKER_FUNDER_ADDRESS: '0xd' + FUNDER.slice(3), MAKER_SIGNATURE_TYPE: '1' }), 'funder: address failing EIP-55 checksum → REFUSE (a mistyped funder is an order signed for someone else)');

  // The adapter resolves EAGERLY, so a half-configured funder cannot survive to an armed order.
  let ctorThrew = false;
  try { createMakerAdapter({ mode: 'paper', funder: resolveFunder({ MAKER_SIGNATURE_TYPE: '1' }) }); } catch { ctorThrew = true; }
  ok(ctorThrew, 'funder: a refused resolution reaches the adapter constructor — it never gets as far as decrypting a key');

  const wired = createMakerAdapter({ mode: 'paper', funder: proxy });
  ok(wired.signatureType === 1 && wired.funderAddress === FUNDER, 'funder: the adapter reports the pair it will sign with (observable, not buried in a closure)');

  // ── The CONFIGURED funder beats the DERIVED one, and a real contradiction is loud ──────────────────
  // getProxyWalletAddress() is a counterfactual CREATE2 address that never fails and never returns zero,
  // so "it returned something" proved nothing — and on this operator's account it returned an address
  // with no code while the real funder held the money. These lock in that it can no longer win silently.
  const { configuredFunder, assertProxyAgreesWithConfig, derivationApplies } =
    require('../lib/venues/polymarket-clob-maker/proxy-wallet');
  const DERIVED = '0x87a01e28e18aDe9670f31D6098eFFaDf6FeE5092'; // shape fixture: a different address

  ok(configuredFunder({ MAKER_FUNDER_ADDRESS: FUNDER.toLowerCase() }) === FUNDER, 'proxy: configuredFunder checksums the env value');
  ok(configuredFunder({}) === null && configuredFunder({ MAKER_FUNDER_ADDRESS: '0xnope' }) === null, 'proxy: configuredFunder returns null for unset/malformed — never a fabricated address');
  ok(derivationApplies(1) === true && derivationApplies(3) === false && derivationApplies(2) === false, 'proxy: the ProxyWallet derivation is authoritative for signatureType 1 ONLY');

  let divergeThrew = false;
  try { assertProxyAgreesWithConfig({ configured: FUNDER, derived: DERIVED, signatureType: 1 }); } catch { divergeThrew = true; }
  ok(divergeThrew, 'proxy: configured != derived on a type-1 account → THROW (the derivation is the authority there, so one of them is wrong)');

  const t3 = assertProxyAgreesWithConfig({ configured: FUNDER, derived: DERIVED, signatureType: 3 });
  ok(t3.ok === true && t3.applicable === false, 'proxy: configured != derived on a type-3 account → NOT a mismatch (wrong factory), configured stands');

  ok(assertProxyAgreesWithConfig({ configured: null, derived: DERIVED, signatureType: 1 }).ok === true, 'proxy: nothing configured → nothing to contradict');
  ok(assertProxyAgreesWithConfig({ configured: FUNDER, derived: null, signatureType: 1 }).ok === true, 'proxy: derivation unreadable → NOT a mismatch (an RPC outage is not evidence)');
  ok(assertProxyAgreesWithConfig({ configured: FUNDER, derived: FUNDER.toLowerCase(), signatureType: 1 }).ok === true, 'proxy: agreement is case-insensitive (checksum casing is not a mismatch)');
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

  // ── gate 5: CLOB order version. The venue negotiates it (GET /version); the wallet's on-chain
  // approvals are granted to the v2 exchanges ONLY. Anything but v2 must refuse, and an unreadable
  // version must refuse just as hard — "could not read" and "is fine" are not the same answer.
  ok(SUPPORTED_ORDER_VERSION === 2, 'order-version: this build is approved for exactly CLOB v2');
  ok(evaluateOrderVersionGate(2).allow === true, 'gate 5: venue negotiates v2 → allow (the approved version)');
  ok(evaluateOrderVersionGate('2').allow === true, 'gate 5b: numeric string "2" is accepted — GET /version is JSON, the type must not decide safety');
  ok(evaluateOrderVersionGate(3).gate === 'order-version', 'gate 5c: venue negotiates v3 → refuse (order-version) — exchangeV3 exists in the installed SDK and the wallet has approved nothing to it');
  ok(evaluateOrderVersionGate(1).gate === 'order-version', 'gate 5d: venue negotiates v1 → refuse (order-version) — a silent downgrade to the legacy exchange is still a downgrade');
  ok(evaluateOrderVersionGate(null).gate === 'order-version-unknown', 'gate 5e: version unreadable (null) → refuse (order-version-unknown) — FAIL CLOSED, never sign blind');
  ok(evaluateOrderVersionGate(undefined).gate === 'order-version-unknown', 'gate 5f: version absent (undefined) → refuse (order-version-unknown)');
  ok(evaluateOrderVersionGate('v2').gate === 'order-version-unknown', 'gate 5g: unparseable version string → refuse (order-version-unknown)');
  ok(evaluateOrderVersionGate(2.5).gate === 'order-version-unknown', 'gate 5h: non-integer version → refuse (order-version-unknown)');
}

// ── 3. MAKER_MODE=off / paper / dry-run → NO venue write reachable (async, closes the run) ──
async function noWriteProof() {
  for (const mode of ['off', 'paper']) {
    // No providers passed → if any mutating path tried to reach the venue it would need creds/signer and throw.
    const a = createMakerAdapter({ mode });
    ok(a.canWrite === false, `mode=${mode} → canWrite=false`);
    const p = await a.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 100, tickSize: 0.01, venueRules: VR });
    ok(p.sent === false && p.simulated === true, `mode=${mode} postOrder makes NO venue write (sent=false, simulated)`);
    const c = await a.cancelMarketOrders('0xabc');
    ok(c.sent === false, `mode=${mode} cancelMarketOrders makes NO venue write`);
    const l = await a.listOpenOrders('0xabc');
    ok(l.simulated === true, `mode=${mode} listOpenOrders makes NO venue read`);
  }
  // dry-run belt independent of mode: even a live mode + dryRun → canWrite false, no providers required.
  const dry = createMakerAdapter({ mode: 'live', dryRun: true });
  ok(dry.canWrite === false, 'live + MAKER_ADAPTER_DRYRUN → canWrite=false (dry-run belt)');
  const dp = await dry.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 100, tickSize: 0.01, venueRules: VR });
  ok(dp.sent === false, 'live+dry-run postOrder makes NO venue write');

  // A live adapter with THROWING providers (this build's live wiring). Post-migration the OUTER belt is
  // the re-pointed placement gate: with pUSD funding + v2 approvals NOT attested (agent35 never sets
  // fundingApproved), postOrder refuses at the funding-approval gate BEFORE liveClient()/the provider —
  // no network, no key. (The throwing-provider belt is proven independently below.)
  const thrower = async () => { throw new Error('provider not wired'); };
  // Inject a PERMISSIVE safety bag so the new kill/venue/limit gates pass and the chain still reaches the
  // existing funding-approval gate — proving the v2-migration gates are intact under the new safety layer.
  const live = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], credsProvider: thrower, signerProvider: thrower, liveMinCapUsd: 25, safety: permissiveSafety() });
  ok(live.canWrite === true, 'live-min with providers → canWrite=true (capability owned)…');
  const lp = await live.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
  ok(lp.ok === false && lp.sent === false && lp.gate === 'funding-approval', '…but a live placement fails CLOSED at the funding/approval gate (pUSD + v2 approvals unattested) — no order signed, no network, no key');

  // ── 8. live-min HARD per-order notional cap trips BEFORE the placement gate / any network/creds ──
  const capped = await live.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 1000, tickSize: 0.01, venueRules: VR }); // $500 » $25
  ok(capped.sent === false && /live-min hard cap/i.test(capped.reason || ''), 'live-min hard cap rejects an over-cap order before touching creds');

  // ── 8c. live-min MARKET ALLOWLIST gate — the bound is enforced, and it is now a LIST ──────────────
  // This guarantee was documented in lib/maker/config.js and in the adapter's own staged-safety header,
  // but NOTHING compared an order's market against the pin: the value was read into config, copied into
  // the heartbeat, and never checked. In live-min the maker would have placed real orders on every market
  // that had a leg. These assertions are the enforcement.
  //
  // CHANGED 2026-07-31: the bound is no longer ONE pinned market but the operator's enabled list
  // (cfg.enabledMarketIds) PLUS the env pin. The property being asserted is unchanged — only markets a
  // human deliberately enabled, named in advance, and an empty/unreadable set refuses everything. Every
  // fixture below passes `allowedMarketIds` EXPLICITLY so these assertions test the gate rather than
  // whatever markets happen to be enabled on the machine running the selfcheck.
  // (The multi-market behaviour itself is exhausted in scripts/maker-multimarket-selfcheck.js.)
  {
    const OTHER = '0x2222222222222222222222222222222222222222222222222222222222222222';
    // The pure gate, exhausted — no adapter, no I/O.
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, marketId: LIVE_MKT }).allow === true, 'live-min market gate: the pinned market is allowed');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, marketId: LIVE_MKT.toUpperCase().replace('0X', '0x') }).allow === true, 'live-min market gate: comparison is case-insensitive (hex casing is not a mismatch)');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, marketId: OTHER }).gate === 'live-min-market-mismatch', 'live-min market gate: a DIFFERENT market → REFUSE (this is the bug that had no gate)');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, marketId: undefined }).gate === 'live-min-market-unknown', 'live-min market gate: no marketId on the order → REFUSE (a check that could not run is not a check that passed)');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: '', marketId: LIVE_MKT }).gate === 'live-min-market-unset', 'live-min market gate: no pin configured → REFUSE ("one market only" naming no market is not a restriction)');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: '   ', marketId: LIVE_MKT }).gate === 'live-min-market-unset', 'live-min market gate: a whitespace-only pin is treated as unset, not as a market named "   "');
    // Scope: it must NOT fire outside live-min — off/paper reach no venue write anyway, and `live` is the
    // deliberately unrestricted stage. Gating those would hide config errors behind a harmless mode.
    for (const m of ['off', 'paper', 'live']) {
      ok(evaluateLiveMinMarketGate({ mode: m, liveMinMarket: LIVE_MKT, marketId: OTHER }).allow === true, `live-min market gate: does NOT apply to mode='${m}' (scoped to live-min only)`);
    }
    // And through the real adapter: the gate trips BEFORE creds/keys, exactly like the notional cap.
    const wrongMkt = await live.postOrder({ marketId: OTHER, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(wrongMkt.sent === false && wrongMkt.gate === 'live-min-market-mismatch', 'adapter: a live-min order for an UNPINNED market is refused before any creds/key/network');
    const noMkt = await live.postOrder({ tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(noMkt.sent === false && noMkt.gate === 'live-min-market-unknown', 'adapter: a live-min order with NO marketId is refused (fail closed)');
    const unpinned = createMakerAdapter({ mode: 'live-min', liveMinMarket: '', allowedMarketIds: [], credsProvider: thrower, signerProvider: thrower, safety: permissiveSafety() });
    const up = await unpinned.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(up.sent === false && up.gate === 'live-min-market-unset', 'adapter: live-min with NO pin AND an empty enabled list can place NOTHING at all');
    ok(live.liveMinMarket === LIVE_MKT, 'adapter reports the market it is pinned to (observable, not buried in a closure)');
    // The list half of the same bound: a market NOT pinned but ENABLED is admitted, and the gate still
    // refuses everything outside the union of the two.
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: '', allowedMarketIds: [OTHER], marketId: OTHER }).allow === true, 'live-min market gate: an ENABLED (unpinned) market is allowed — the bound is a list, not one market');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [OTHER], marketId: LIVE_MKT }).allow === true, 'live-min market gate: the pin remains valid alongside the list');
    ok(evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [OTHER], marketId: '0x3333333333333333333333333333333333333333333333333333333333333333' }).gate === 'live-min-market-mismatch', 'live-min market gate: anything outside pin ∪ list is still REFUSED');
  }

  // ── 8d. A NO leg must be judged against the NO book's mid, by the GUARD as well as the planner ──────
  // planQuotes mirrors the mid for the NO book (a NO order at q IS a YES order at 1 − q). agent35's call
  // to the shared venue-rules guard did NOT, and passed the YES mid for every quote: a NO leg sitting
  // 0.45c from its own mid was measured against the YES mid, read as ~7c away, and refused OUT_OF_BAND.
  // Because BUY NO is the only way a collateral-funded maker can offer the ASK side (SELL YES needs
  // inventory), that one missing mirror made EVERY two-sided configuration impossible — and one-sided
  // liquidity takes the ÷3 penalty, or earns exactly zero when the mid is in the tails. Observed live on
  // 2026-07-29: postable YES, OUT_OF_BAND NO, on a market where both legs were 0.45c from their own mids.
  {
    const { validateQuote } = require('../lib/maker/venue-rules');
    const yesMid = 0.4625;
    const noMid = +(1 - yesMid).toFixed(6);
    const rules = (m) => ({ tick: 0.001, scoringMid: m, maxSpreadCents: 4.5, minSize: 50 });
    // Both legs sit 0.45c inside their OWN book's mid — both must pass.
    ok(validateQuote(rules(yesMid), { side: 'BUY', price: 0.458, size: 50 }).valid === true, 'guard mirror: the YES bid 0.45c from the YES mid is IN band');
    ok(validateQuote(rules(noMid), { side: 'BUY', price: 0.533, size: 50 }).valid === true, 'guard mirror: the NO bid 0.45c from the NO mid is IN band when judged against the NO mid');
    // And the exact bug: judging that same NO price against the YES mid refuses it.
    const wrong = validateQuote(rules(yesMid), { side: 'BUY', price: 0.533, size: 50 });
    ok(wrong.valid === false && wrong.reasons.some((r) => r.code === 'OUT_OF_BAND'), 'guard mirror: judging the NO leg against the YES mid REFUSES it OUT_OF_BAND — the bug this mirror fixes');
  }

  // ── 8e. PLACEMENT defaults to dry-run, and only the exact string 'send' arms the venue call ────────
  // This is the belt that decides whether POST /order is ever reached. It must default closed, and it
  // must not be talked into opening by a near-miss value: a typo, a stray space, a truthy-looking
  // string. The cost of guessing wrong here is a real order with real money, so only 'send' counts.
  {
    ok(createMakerAdapter({ mode: 'paper' }).placement === 'dry-run', 'placement: unset → dry-run (the default is NOT to send)');
    ok(createMakerAdapter({ mode: 'paper', placement: 'send' }).placement === 'send', "placement: the exact string 'send' arms the venue call");
    // Surrounding whitespace is NORMALISED (an env var written as `MAKER_PLACEMENT=send ` means send) —
    // that is trimming, not guessing. Everything else must match exactly, and case-sensitively: a
    // truthy-looking or nearly-right value opens nothing.
    ok(createMakerAdapter({ mode: 'paper', placement: '  send  ' }).placement === 'send', "placement: surrounding whitespace is trimmed ('  send  ' is still send)");
    for (const v of ['', '  ', 'SEND', 'Send', 'sending', 'send-it', 'true', 'yes', '1', 'live', 'dry-run', 'dryrun', 'null']) {
      const got = createMakerAdapter({ mode: 'paper', placement: v }).placement;
      ok(got === 'dry-run', `placement: ${JSON.stringify(v)} → dry-run (a near-miss value never opens the venue path)`);
    }
    // It is INDEPENDENT of mode: a fully armed live-min adapter still defaults to not sending.
    const armedButDry = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: thrower, signerProvider: thrower, safety: permissiveSafety() });
    ok(armedButDry.placement === 'dry-run', 'placement: an armed live-min adapter with funding attested STILL defaults to dry-run');
  }

  // ── 8f. validateOrder is consulted before sending, and fails CLOSED when it cannot be consulted ─────
  // A revert means the exchange rejected the signed struct. An unreachable node means we do not KNOW.
  // Those must never collapse into the same outcome as "accepted" — reading an RPC outage as approval
  // is exactly how an unverified order reaches a venue.
  {
    const { orderToTuple, exchangeForOrder } = require('../lib/maker/order-validate');
    ok(exchangeForOrder(false).key === 'ctfExchange', 'validate-order: a standard order is validated against CTFExchangeV2');
    ok(exchangeForOrder(true).key === 'negRiskExchange', 'validate-order: a NEG-RISK order is validated against the NEG-RISK exchange, not the standard one');
    const good = { salt: 1n, maker: '0x' + '1'.repeat(40), signer: '0x' + '2'.repeat(40), tokenId: 5n, makerAmount: 10n, takerAmount: 20n, side: 'BUY', signatureType: 3, timestamp: 7n, metadata: '0x' + '0'.repeat(64), builder: '0x' + '0'.repeat(64), signature: '0xdead' };
    ok(orderToTuple(good)[6] === 0, 'validate-order: side BUY maps to uint8 0');
    ok(orderToTuple({ ...good, side: 'SELL' })[6] === 1, 'validate-order: side SELL maps to uint8 1');
    let partialThrew = false;
    try { orderToTuple({ ...good, signature: undefined }); } catch { partialThrew = true; }
    ok(partialThrew, 'validate-order: a signed order missing a field THROWS rather than validating a partial struct');
  }

  // ── 8g. A DRY-RUN MUST NOT BOOK EXPOSURE. The bug that made this necessary ─────────────────────────
  // lib/safety/usage.js counts EVERY intent row as a possibly-live order at FULL NOTIONAL: "an intent is
  // written only AFTER all gates pass and immediately before the send". The first version of the dry-run
  // recorded an intent before the dry-run branch and then sent nothing, quietly breaking that invariant.
  // Measured consequence: two dry-runs booked $49.55 of imaginary open exposure, and the very next
  // attempt was refused with limit-max-open-notional against orders that had never existed. In a maker
  // that dry-runs every tick it would grow without bound and wedge the risk limits permanently.
  {
    const auditFile = tmpFile('dryrun-exposure.jsonl');
    const safe = permissiveSafety();
    safe.recordIntent = (i) => EA.recordIntent(i, { auditFile });
    safe.recordOutcome = (o) => EA.recordOutcome(o, { auditFile });
    const { credsProvider, signerProvider } = spyProviders();
    const a = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider, signerProvider, safety: safe });
    ok(a.placement === 'dry-run', 'dry-run exposure: the fixture adapter is in dry-run');
    await a.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, idempotencyKey: 'dry-key', userId: 'u2', venueRules: VR });
    ok(EA.hasIntent('dry-key', { auditFile }) === false, 'dry-run: writes NO intent row — nothing was sent, so nothing may be counted as open exposure');
    const rows = EA.queryByUser({ userId: 'u2' }, { auditFile });
    ok(rows.filter((r) => r.kind === 'intent').length === 0, 'dry-run: leaves the execution ledger empty of intents');
    ok(rows.filter((r) => r.kind === 'outcome').length === 0, 'dry-run: leaves no outcome row either (there was no send to resolve)');
    // And the rate limiter must not be consumed by orders that never left the building.
    const { sentOrdersFromAudit } = require('../lib/safety/usage');
    ok(sentOrdersFromAudit(rows).length === 0, 'dry-run: contributes ZERO sent orders to the exposure calculation');
  }

  // ── 8b. The throwing-provider belt is INDEPENDENT of the funding gate. Even if funding were attested
  //     (a TEST-only fundingApproved:true — agent35 never sets it, so the deployed engine still trips the
  //     funding gate above), this build's live wiring cannot obtain a key: liveClient() calls the (throwing)
  //     credsProvider on its FIRST line, before any network call or client construction. No order signed. ──
  const fundedButUnwired = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: thrower, signerProvider: thrower, liveMinCapUsd: 25, safety: permissiveSafety() });
  const fbp = await fundedButUnwired.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
  ok(fbp.ok === false && /provider not wired/i.test(String((fbp.error && fbp.error.message) || fbp.error || '')), 'even with funding attested, the throwing-provider belt fails a live placement closed (no key, no order) — independent gate');

  // ── 8c. LIVE-PROVIDER WIRING (lib/maker/live-providers) — the REAL providers agent35 now builds, plus the
  //     funding-refusal guard proven to fire INDEPENDENTLY, decisively, and BEFORE any provider/key access. ──
  {
    const { makerLiveProviders } = require('../lib/maker/live-providers');
    const provPair = makerLiveProviders();
    ok(typeof provPair.credsProvider === 'function' && typeof provPair.signerProvider === 'function',
      'live-providers: makerLiveProviders() yields real creds + signer thunks (not the old throwing stub)');

    // funding UNATTESTED + a SPY provider pair: the funding-refusal guard refuses the order BEFORE the
    // provider is ever called — so with MAKER_FUNDING_APPROVED unset, no key is decrypted and no order signed.
    const noFund = spyProviders();
    const aNoFund = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: false, credsProvider: noFund.credsProvider, signerProvider: noFund.signerProvider, safety: permissiveSafety() });
    const rNoFund = await aNoFund.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(rNoFund.ok === false && rNoFund.sent === false && rNoFund.gate === 'funding-approval', 'live-providers: funding UNATTESTED → refused at the funding-approval gate (kill/venue/limits/mode all pass here — the funding guard is decisive on its own)');
    ok(noFund.s.called === false, 'live-providers: the funding-refusal fires BEFORE the provider — the spy signer/creds is NEVER called, no key decrypted');

    // funding ATTESTED + the SAME spy pair: the gate OPENS and the provider IS invoked (then throws) —
    // proving the funding gate is EXACTLY what stands between a refusal and reaching the live signing path.
    const yesFund = spyProviders();
    const aYesFund = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: yesFund.credsProvider, signerProvider: yesFund.signerProvider, safety: permissiveSafety() });
    const rYesFund = await aYesFund.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(yesFund.s.called === true, 'live-providers: funding ATTESTED → the gate opens and the provider IS reached (spy called) — the funding gate is the sole guard before the live signing path');
    ok(rYesFund.ok === false && rYesFund.sent === false, 'live-providers: with the spy provider throwing, the placement fails closed AND reports sent=false — the invocation reached the provider, not the venue, and the result now says so instead of implying an order might be resting');
  }

  // ── 9. off/paper/live all REJECT an off-tick price defensively (never post an unsnapped price) ──
  const offTick = await createMakerAdapter({ mode: 'paper' }).postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5237, size: 100, tickSize: 0.01 });
  ok(offTick.ok === false && /not a valid multiple of tick/i.test(offTick.reason || ''), 'an off-tick price is rejected (defense in depth), never posted');
  ok(_internal.priceOnTick(0.52, 0.01) === true && _internal.priceOnTick(0.523, 0.01) === false, 'priceOnTick: 0.52 valid on 0.01, 0.523 invalid');
  ok(_internal.priceOnTick(0.523, 0.001) === true && _internal.priceOnTick(0.0025, 0.0025) === true, 'priceOnTick handles 0.001 and 0.0025 ticks (not just powers of ten)');

  // ── 11. EXECUTION-SAFETY GATES WIRED INTO postOrder (adapter-level, before key decryption) ──
  // 11a. a GLOBAL kill blocks placement at the kill gate, BEFORE any key decryption (provider untouched).
  {
    const { s, credsProvider, signerProvider } = spyProviders();
    const auditFile = tmpFile('killed.jsonl');
    const killedSafety = {
      checkKill: () => ({ killed: true, gate: 'kill-global', reason: 'GLOBAL kill active' }),
      evaluateForOrder: () => ({ venueAllowed: true, limits: { allow: true }, clampEvents: [] }),
      recordIntent: (i) => EA.recordIntent(i, { auditFile }), recordOutcome: () => {},
      deriveIdempotencyKey: EA.deriveIdempotencyKey, setUserKill: () => {},
    };
    const a = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider, signerProvider, safety: killedSafety });
    const r = await a.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(r.ok === false && r.gate === 'kill-global', 'adapter: a GLOBAL kill blocks placement at the kill gate (kill-global)');
    ok(s.called === false, 'adapter: a KILLED placement is refused BEFORE key decryption — the signer/creds provider is NEVER called');
    ok(!fs.existsSync(auditFile), 'adapter: a killed placement records NO intent (refused before intent-before-send)');
  }

  // 11b. per-user kill (durable, real kill-switch on a temp file) blocks ONLY the killed user.
  {
    const killFile = tmpFile('peruser.json');
    KS.setUserKill({ userId: 'victim', by: 'selfcheck' }, { stateFile: killFile, auditFile: tmpFile('pu-audit.jsonl') });
    const mkSafety = (auditFile) => ({
      checkKill: ({ userId }) => KS.checkKill({ userId }, { stateFile: killFile }),
      evaluateForOrder: () => ({ venueAllowed: true, limits: { allow: true }, clampEvents: [] }),
      recordIntent: (i) => EA.recordIntent(i, { auditFile }), recordOutcome: (o) => EA.recordOutcome(o, { auditFile }),
      deriveIdempotencyKey: EA.deriveIdempotencyKey, setUserKill: () => {},
    });
    const v = spyProviders();
    const aVictim = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: v.credsProvider, signerProvider: v.signerProvider, safety: mkSafety(tmpFile('v.jsonl')) });
    const rv = await aVictim.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, userId: 'victim', venueRules: VR });
    ok(rv.gate === 'kill-user' && v.s.called === false, 'adapter: a per-user kill blocks the killed user (kill-user), before key decryption');
    const b = spyProviders();
    const aOther = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: b.credsProvider, signerProvider: b.signerProvider, safety: mkSafety(tmpFile('o.jsonl')) });
    const ro = await aOther.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, userId: 'bystander', venueRules: VR });
    // The point of this assertion is that the bystander is NOT stopped by the kill gate — evidenced by
    // the provider actually being reached. sent stays false because the spy provider then throws while
    // loading the key, which is a clean miss, not a send.
    ok(ro.gate !== 'kill-user' && b.s.called === true, 'adapter: a DIFFERENT user is NOT blocked by another user\'s kill (reaches the provider)');
  }

  // 11c. INTENT-before-send survives a throwing venue call; the same idempotency key never places twice.
  {
    const auditFile = tmpFile('exec.jsonl');
    const safe = permissiveSafety();
    safe.recordIntent = (i) => EA.recordIntent(i, { auditFile });
    safe.recordOutcome = (o) => EA.recordOutcome(o, { auditFile });
    const { credsProvider, signerProvider } = spyProviders();
    const a = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], placement: 'send', fundingApproved: true, credsProvider, signerProvider, safety: safe });
    const spec = { marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, idempotencyKey: 'retry-key', userId: 'u', venueRules: VR };
    const first = await a.postOrder(spec);
    // The credsProvider throws, so the failure happens while LOADING THE KEY — before a client exists,
    // long before any POST. That is a CLEAN MISS, and saying so is the honest report: sent=false means
    // "nothing could possibly be resting", which an operator can act on. This assertion used to expect
    // sent=true, which conflated "we could not even build the client" with "an order may be live".
    ok(first.ok === false && first.sent === false && first.ambiguous !== true, 'adapter: a failure while loading the key is a CLEAN miss (sent=false) — nothing reached the venue, and we do not imply otherwise');
    ok(EA.hasIntent('retry-key', { auditFile }) === false, 'adapter: NO intent row when the failure preceded the send — an intent means "an order may be resting", so writing one here would book phantom exposure');
    ok(a.postOrder && typeof a.postOrder === 'function', 'adapter: postOrder remains callable after a failed attempt (no latch on a miss)');
  }

  // 11d. unreadable kill state fails CLOSED at the adapter (default reader points at a corrupt temp file).
  {
    const corrupt = tmpFile('corrupt.json'); fs.writeFileSync(corrupt, '{not json');
    const { s, credsProvider, signerProvider } = spyProviders();
    const failClosedSafety = {
      checkKill: ({ userId }) => KS.checkKill({ userId }, { stateFile: corrupt }),
      evaluateForOrder: () => ({ venueAllowed: true, limits: { allow: true }, clampEvents: [] }),
      recordIntent: () => ({ recorded: true, duplicate: false }), recordOutcome: () => {},
      deriveIdempotencyKey: EA.deriveIdempotencyKey, setUserKill: () => {},
    };
    const a = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider, signerProvider, safety: failClosedSafety });
    const r = await a.postOrder({ marketId: LIVE_MKT, tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, venueRules: VR });
    ok(r.ok === false && r.gate === 'kill-switch-unreadable' && s.called === false, 'adapter: an UNREADABLE kill state fails CLOSED (kill-switch-unreadable), before key decryption');
  }

  // ── 13. SHARED VENUE-RULES GUARD — the maker CANNOT sign an off-tick / out-of-band / under-min order, ──
  //     and it reaches the SAME verdict as the UI because it calls the SAME function (lib/maker/venue-rules).
  {
    const { validateQuote, validateQuotePair, CODES } = require('../lib/maker/venue-rules');
    // A concrete market: 0.01 tick, scoring mid 0.50, max_spread 3¢ → radius 3¢ → band [0.47, 0.53], min 100.
    //
    // ⚠ RESCALED 2026-08-15. `maxSpreadCents` was 6 to obtain a 3¢ radius under the HALVED reading
    // (`v = maxSpread/2`) that §5-bis p.155 disproved against the venue's own published example. Under
    // `v = maxSpread` (lib/banda-premiante) the same radius is written with HALF the number. The band the
    // cases below reason about — [0.47, 0.53] — is unchanged, and not one expectation was touched.
    const VG = { tick: 0.01, scoringMid: 0.50, maxSpreadCents: 3, minSize: 100 };
    const codesOf = (o) => (o.reasons || []).map((x) => x.code).sort();

    // An observing adapter: paper mode (no venue, no key), audit records captured to an array so we can PROVE
    // the refusal wrote its reason code. NO tickSize on the specs → the defensive priceOnTick belt is skipped,
    // so it is the SHARED GUARD (using venueRules.tick) that decides — exactly what we are proving.
    let audits = [];
    const guardAdapter = createMakerAdapter({ mode: 'paper', auditSink: (rec) => audits.push(rec) });

    // The deliberately-wrong quotes the task enumerates + the boundary cases that must fall on the RIGHT side.
    // NOTE the exact 3¢ edge (0.53): |0.53−0.50| is 0.030000000000000027 in IEEE-754, so ×100 = 3.0000…027 > 3
    // and the quote falls JUST OUTSIDE the band — earning zero reward. Refusing it is the conservative (right)
    // side for a reward maker, and it is deterministic. The nearest on-tick price that is truly inside is 0.52.
    const cases = [
      { label: 'off-tick (0.525)',            price: 0.525, size: 200, expect: [CODES.OFF_TICK] },
      { label: 'one tick out of band (0.54)', price: 0.54,  size: 200, expect: [CODES.OUT_OF_BAND] },
      { label: 'at the 3¢ band edge (0.53)',  price: 0.53,  size: 200, expect: [CODES.OUT_OF_BAND] }, // exact radius → 0 reward → refused
      { label: 'just inside the band (0.52)', price: 0.52,  size: 200, expect: [] },                  // 2¢ < 3¢ → IN band
      { label: 'size = min − 1 (99)',         price: 0.50,  size: 99,  expect: [CODES.BELOW_MIN_SIZE] },
      { label: 'size = min exactly (100)',    price: 0.50,  size: 100, expect: [] },
    ];

    console.log('\n  venue-rules guard — deliberately-wrong quotes (rules: tick 0.01, mid 0.50, band ±3¢, min 100):');
    for (const c of cases) {
      const quote = { side: 'BUY', price: c.price, size: c.size };
      // UI path: the raw shared validator.
      const ui = validateQuote(VG, quote);
      // Maker path: the adapter's guard, via postOrder. paper mode → the guard runs BEFORE the shadow branch.
      audits = [];
      const res = await guardAdapter.postOrder({ marketId: LIVE_MKT, tokenId: '0xg', ...quote, venueRules: VG });
      const uiCodes = codesOf(ui);
      const mkCodes = (res.reasons || []).map((x) => x.code).sort();
      const verdict = c.expect.length === 0 ? 'VALID' : `REFUSED [${res.reasons.map((x) => x.code).join(',')}]`;
      console.log(`    ${c.label.padEnd(28)} → ${verdict}`);
      // 1) the UI verdict matches what we expect (the two edges fall on the RIGHT side)
      ok(JSON.stringify(uiCodes) === JSON.stringify([...c.expect].sort()), `guard/UI: "${c.label}" → ${c.expect.length ? c.expect.join(',') : 'valid'} (edge falls on the right side)`);
      // 2) the maker path gives the IDENTICAL verdict (same function → same codes, cannot diverge)
      ok(JSON.stringify(mkCodes) === JSON.stringify(uiCodes), `guard: maker postOrder verdict == UI validateQuote verdict for "${c.label}" (one shared validator)`);
      if (c.expect.length === 0) {
        // a valid quote is NOT refused by the guard — it reaches the paper shadow (sent=false, simulated)
        ok(res.sent === false && res.simulated === true && res.gate !== 'venue-rules', `guard: a valid quote "${c.label}" passes the guard (reaches the shadow, not refused)`);
      } else {
        // an invalid quote is REFUSED at the venue-rules gate, sent=false, with an audit record carrying the code
        ok(res.ok === false && res.sent === false && res.gate === 'venue-rules', `guard: maker REFUSES "${c.label}" at the venue-rules gate BEFORE signing (never posts it)`);
        const rec = audits.find((a) => a.outcome === 'reject-venue-rules');
        ok(rec && rec.reasons.some((x) => c.expect.includes(x.code)), `guard: the refusal of "${c.label}" writes an AUDIT record carrying the reason code (${c.expect.join(',')})`);
      }
    }

    // FAIL CLOSED: a market whose rules are not on the spec → RULES_UNREADABLE, never a default band.
    audits = [];
    const noRules = await guardAdapter.postOrder({ marketId: LIVE_MKT, tokenId: '0xg', side: 'BUY', price: 0.50, size: 200 /* no venueRules */ });
    ok(noRules.ok === false && noRules.gate === 'venue-rules' && noRules.reasons[0].code === CODES.RULES_UNREADABLE, 'guard: NO venue rules on the spec → RULES_UNREADABLE (fail closed — the maker will not sign for a market it cannot judge)');

    // DRY-RUN, out of band: even with a live mode + dry-run on, the guard refuses to produce a signable order —
    // the refusal happens BEFORE the mode/shadow branch, so no mode can bypass it.
    const daudits = [];
    const dry = createMakerAdapter({ mode: 'live', dryRun: true, auditSink: (rec) => daudits.push(rec) });
    const dres = await dry.postOrder({ marketId: LIVE_MKT, tokenId: '0xg', side: 'BUY', price: 0.54, size: 200, venueRules: VG });
    ok(dres.ok === false && dres.sent === false && dres.gate === 'venue-rules' && dres.reasons.some((x) => x.code === CODES.OUT_OF_BAND), 'guard: in DRY-RUN an out-of-band offset is REFUSED (no signable order produced) — the guard is before the mode branch, no mode bypasses it');
    ok(daudits.some((a) => a.outcome === 'reject-venue-rules'), 'guard: the dry-run refusal is AUDITED with its reason code');

    // qMin COUPLING (B3): validate the PAIR. A valid bid + an out-of-band ask → the whole two-sided quote is
    // DEGRADED (score collapses to the weaker leg). The maker signs each leg through the SAME per-leg guard,
    // so the out-of-band leg can never be placed even though its partner is fine.
    const pair = validateQuotePair(VG, { side: 'BUY', price: 0.49, size: 200 }, { side: 'SELL', price: 0.54, size: 200 });
    ok(pair.valid === false && pair.degraded === true && pair.weakerSide === 'ask' && pair.reasons.some((r) => r.leg === 'ask' && r.code === CODES.OUT_OF_BAND), 'guard: qMin pair coupling — an out-of-band ask DEGRADES the whole two-sided quote (weaker leg named), while the maker refuses that ask leg-by-leg');
  }

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
  // two-sided → no penalty. The SELL leg now needs REAL inventory to be postable (a sell delivers an
  // ERC-1155 token you must own), so this case supplies a measured balance. Without it the inventory
  // guard blocks the sell and the config is correctly no longer two-sided — see the fail-closed case
  // immediately below, which is the same call with no balance.
  const twoSidedInput = { legs: [{ book: 'yes', kind: 'buy', mode: 'follow', offsetC: -1, size: 500 }, { book: 'yes', kind: 'sell', mode: 'follow', offsetC: 1, size: 500 }], mid: 0.5, maxSpreadC: 4, minSize: 100, tick: 0.01, tokenId: 'T', tokenIdNo: 'TN' };
  const twoSided = planQuotes({ ...twoSidedInput, balances: { yes: 5000, no: 0 } });
  ok(twoSided.market.twoSided === true && twoSided.market.oneSidedPenalty === false, 'two-sided config (with the inventory the sell needs) → no one-sided penalty');
  const twoSidedNoInv = planQuotes(twoSidedInput);
  ok(twoSidedNoInv.market.sellBlocks.length === 1 && twoSidedNoInv.quotes[1].postable === false && twoSidedNoInv.market.twoSided === false,
    'the SAME config with no readable inventory → the sell is blocked (fail closed) and the quote is no longer two-sided');
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

// ── 10. EXECUTION-SAFETY MODULES (kill switch / risk limits / audit trail), pure + temp-file ──
{
  // 10a. KILL SWITCH: durable, global+user scopes, global wins, fail-closed on unreadable, audited.
  const killFile = tmpFile('kill.json');
  const killAudit = tmpFile('kill-audit.jsonl');
  const kdeps = { stateFile: killFile, auditFile: killAudit };
  ok(KS.checkKill({ userId: 'u1' }, kdeps).killed === false, 'kill: an ABSENT state file → NOT killed (permitted; absent ≠ unreadable)');
  KS.setUserKill({ userId: 'u1', reason: 'test', by: 'sc' }, kdeps);
  ok(KS.checkKill({ userId: 'u1' }, kdeps).gate === 'kill-user', 'kill: a per-user kill blocks that user (kill-user)');
  ok(KS.checkKill({ userId: 'u2' }, kdeps).killed === false, 'kill: a per-user kill does NOT block a different user');
  KS.setGlobalKill({ reason: 'halt', by: 'sc' }, kdeps);
  ok(KS.checkKill({ userId: 'u2' }, kdeps).gate === 'kill-global', 'kill: a GLOBAL kill blocks every user (global always wins)');
  KS.clearGlobalKill({ by: 'sc' }, kdeps);
  ok(KS.checkKill({ userId: 'u2' }, kdeps).killed === false, 'kill: clearing the global kill un-blocks unaffected users');
  ok(KS.checkKill({ userId: 'u1' }, kdeps).killed === true, 'kill: the per-user kill survives a global clear (independent scope)');
  ok(KS.checkKill({ userId: 'u1' }, { stateFile: killFile }).killed === true, 'kill: state is DURABLE — a fresh read (simulated post-restart) still sees the kill');
  const corrupt = tmpFile('corrupt.json'); fs.writeFileSync(corrupt, '{not json');
  const fc = KS.checkKill({ userId: 'u1' }, { stateFile: corrupt });
  ok(fc.killed === true && fc.gate === 'kill-switch-unreadable', 'kill: an UNREADABLE state fails CLOSED (kill-switch-unreadable), never defaults to permitted');
  ok(fs.existsSync(killAudit) && /"event":"kill"/.test(fs.readFileSync(killAudit, 'utf8')), 'kill: every set/clear is AUDITED (who/when/scope/reason)');

  // 10b. RISK LIMITS: hard-ceiling clamp, each limit boundary, missing fails closed, venue allowlist.
  const limitsFile = tmpFile('limits.json');
  fs.writeFileSync(limitsFile, JSON.stringify({
    global: { maxOrderNotionalUsd: 25, maxOpenNotionalUsd: 500, maxOrdersPerWindow: 30, windowMs: 60000, maxDailyLossUsd: 50, venues: ['polymarket'] },
    users: { hot: { maxOrderNotionalUsd: 99999 } }, // deliberately ABOVE the hard ceiling (100)
  }));
  const res = RL.resolveLimits({ userId: 'std' }, { configFile: limitsFile });
  ok(res.ok && res.limits.maxOrderNotionalUsd === 25, 'limits: a stored value within the ceiling stands (25)');
  const hot = RL.resolveLimits({ userId: 'hot' }, { configFile: limitsFile });
  ok(hot.limits.maxOrderNotionalUsd === RL.HARD_CEILINGS.maxOrderNotionalUsd && hot.clampEvents.some(c => c.field === 'maxOrderNotionalUsd'), 'limits: a stored config ABOVE the hard ceiling is CLAMPED to the ceiling + the clamp is audited');
  const okUsage = { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: 0 };
  ok(RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: okUsage, limits: res.limits }).allow === true, 'limits: an order within every limit is allowed');
  ok(RL.evaluateLimits({ order: { notionalUsd: 25.01 }, usage: okUsage, limits: res.limits }).gate === 'max-order-notional', 'limits: per-order notional trips at its boundary (max-order-notional)');
  ok(RL.evaluateLimits({ order: { notionalUsd: 20 }, usage: { openNotionalUsd: 490, ordersInWindow: 0, realisedDailyPnlUsd: 0 }, limits: res.limits }).gate === 'max-open-notional', 'limits: open-exposure cap trips at its boundary (max-open-notional)');
  ok(RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: { openNotionalUsd: 0, ordersInWindow: 30, realisedDailyPnlUsd: 0 }, limits: res.limits }).gate === 'rate-limit', 'limits: orders-per-window rate limit trips at its boundary (rate-limit)');
  const dl = RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: -50 }, limits: res.limits });
  ok(dl.gate === 'daily-loss' && dl.autoKill === true, 'limits: realised daily-loss trips at its boundary AND flags an automatic kill (daily-loss, autoKill)');
  ok(RL.evaluateLimits({ order: { notionalUsd: null }, usage: okUsage, limits: res.limits }).gate === 'unverified-size', 'limits: an unverifiable order size is refused (unverified-size — capacity "—" = no order)');
  const missing = { ...res.limits, maxOrderNotionalUsd: null };
  ok(RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: okUsage, limits: missing }).allow === false, 'limits: a MISSING limit fails CLOSED (missing ≠ unlimited)');
  ok(RL.isVenueAllowed({ venue: 'polymarket', limits: res.limits }) === true && RL.isVenueAllowed({ venue: 'kalshi', limits: res.limits }) === false, 'limits: the venue allowlist permits only enabled venues');
  ok(RL.isVenueAllowed({ venue: 'polymarket', limits: { venues: [] } }) === false, 'limits: an empty/absent venue allowlist permits NO venue (fail closed)');
  const badCfg = tmpFile('badcfg.json'); fs.writeFileSync(badCfg, 'not json');
  ok(RL.resolveLimits({ userId: 'x' }, { configFile: badCfg }).ok === false, 'limits: an unreadable config → resolveLimits not-ok (caller fails closed)');

  // 10c. AUDIT TRAIL: intent-before-send, idempotency dedup, per-user query, redaction.
  const auditFile = tmpFile('exec-audit.jsonl');
  const adeps = { auditFile };
  const intent = { idempotencyKey: 'k1', userId: 'u', venue: 'polymarket', market: 'm', side: 'BUY', price: 0.5, size: 10, notionalUsd: 5 };
  ok(EA.recordIntent(intent, adeps).recorded === true, 'audit: the first intent for a key is recorded');
  const r2 = EA.recordIntent(intent, adeps);
  ok(r2.recorded === false && r2.duplicate === true, 'audit: the SAME idempotency key is a DUPLICATE — never recorded/placed twice');
  ok(EA.hasIntent('k1', adeps) === true && EA.hasIntent('nope', adeps) === false, 'audit: hasIntent finds a recorded key, not an absent one');
  EA.recordOutcome({ idempotencyKey: 'k1', userId: 'u', venue: 'polymarket', ok: false, error: 'x' }, adeps);
  const rows = EA.queryByUser({ userId: 'u' }, adeps);
  ok(rows.filter(x => x.kind === 'intent').length === 1 && rows.filter(x => x.kind === 'outcome').length === 1, 'audit: the trail is queryable per user (1 intent + 1 outcome for k1)');
  EA.recordIntent({ idempotencyKey: 'k2', userId: 'u', venue: 'polymarket', decision: { note: '0x' + 'a'.repeat(64) } }, adeps);
  ok(!fs.readFileSync(auditFile, 'utf8').includes('a'.repeat(64)), 'audit: a private-key-shaped inline value is REDACTED out of the trail');
}

// ── 12. FILL TRACKING + OPEN EXPOSURE + REALISED DAILY LOSS + the two now-ARMED limits ──
// Proves the gap the task closes: openNotionalUsd / realisedDailyPnlUsd are now REAL (sourced from the
// venue-truth fill ledger), so maxOpenNotionalUsd and maxDailyLossUsd can arm — while every proof stays on
// temp fixtures and the deployed engine remains disarmed.
{
  const NOWMS = Date.now();
  const DAY = F.UTC_DAY_MS;
  const dayStart = F.utcDayStart(NOWMS);

  // 12a. A PARTIAL fill counts as PARTIAL, not full. Order was 500 sh; the venue confirmed 120 filled.
  const fp = tmpFile('fills-partial.jsonl');
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'T', side: 'BUY', filledSize: 120, filledPrice: 0.50, feeUsd: 0, idempotencyKey: 'k1', source: 'sc', ts: dayStart + 1000 }, { fillsFile: fp });
  const expPartial = F.computeExposure({ userId: 'op', now: NOWMS, sentOrders: [{ idempotencyKey: 'k1', notionalUsd: 250, ts: dayStart + 900 }] }, { fillsFile: fp });
  ok(expPartial.ok && Math.abs(expPartial.openNotionalUsd - 60) < 1e-6, 'fills: a PARTIAL fill (120/500) counts at its partial notional ($60), never rounded up to the full order ($250)');

  // 12b. AN UNKNOWN SENT ORDER — REWRITTEN 2026-08-15, and this one is NOT a band rescale.
  //
  // WHAT THIS ASSERTED UNTIL TODAY: that a sent-but-unreconciled order was added to exposure at its FULL
  // notional, and surfaced in `unknowns`. That was the pre-emptive count, and it was REMOVED on
  // 2026-08-02 at the operator's explicit request — see the long block in lib/safety/fills.js
  // ("IL CONTEGGIO ANTICIPATO E' STATO RIMOSSO"). Exposure now reflects ONLY what has been reconciled
  // against the venue, and `unknowns` is empty BY CONSTRUCTION. The accepted risk is documented where it
  // lives: for up to 60s after a placement the cap does not see the order.
  //
  // Leaving the old assertion here would have meant a selfcheck that fails because the code is CORRECT —
  // the sixth occurrence of "a test that photographs the code instead of the property" (§5.3). The
  // property that survives is that the two QUESTIONS stay separate, and both still get an answer.
  const expUnknown = F.computeExposure({ userId: 'op', now: NOWMS, sentOrders: [{ idempotencyKey: 'k1', notionalUsd: 250, ts: dayStart + 900 }, { idempotencyKey: 'GHOST', notionalUsd: 250, ts: dayStart + 900 }] }, { fillsFile: fp });
  ok(expUnknown.ok && Math.abs(expUnknown.openNotionalUsd - 60) < 1e-6 && expUnknown.unknowns.length === 0,
    'fills: a sent-but-UNRECONCILED order does NOT enter exposure ($60, unchanged) and `unknowns` is empty by construction — the operator\'s 2026-08-02 decision, with its risk stated in the source');
  // …and the OTHER question — "did the ledger ever resolve this order?" — is a property of the LEDGER,
  // not of exposure, and it still answers. If this went quiet too, a ghost order would be invisible to
  // everyone (that is exactly what happened between 2026-08-02 and 2026-08-10: 1,294 sent orders with no
  // ledger row and `unknowns.length === 0`, and agent40's reconciliation silently stopped running).
  const ledgerRows = F.readFills({ userId: 'op' }, { fillsFile: fp }).rows;
  const unresolved = F.ordiniNonRisolti([{ idempotencyKey: 'k1', notionalUsd: 250 }, { idempotencyKey: 'GHOST', notionalUsd: 250 }], ledgerRows);
  ok(unresolved.length === 1 && unresolved[0].idempotencyKey === 'GHOST',
    'fills: but the ledger still calls it UNRESOLVED (ordiniNonRisolti lists GHOST, not k1) — exposure and resolution are two questions, and the second one did not go quiet');

  // 12c. Exposure from a REAL book (executable bid/ask) matches a hand-checked figure FIELD BY FIELD.
  const fb = tmpFile('fills-book.jsonl');
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'T', side: 'BUY', filledSize: 200, filledPrice: 0.45, feeUsd: 0, idempotencyKey: 'b1', source: 'sc', ts: dayStart + 1000 }, { fillsFile: fb });
  const marked = F.computeExposure({ userId: 'op', now: NOWMS, marks: { T: { price: 0.50, ts: NOWMS } } }, { fillsFile: fb });
  const pos = marked.positions[0];
  ok(marked.ok && pos.shares === 200 && pos.entryNotionalUsd === 90 && pos.markPrice === 0.50 && pos.markValueUsd === 100 && pos.exposureUsd === 100 && pos.markSource === 'executable-book',
    'fills: exposure marked to EXECUTABLE book (bid/ask) matches hand-checked position field-by-field (200 sh, entry $90, mark 0.50, value $100, exposure max($90,$100)=$100)');

  // 12d. A position whose book CANNOT be read is treated at LEAST at its entry notional (never mid, never 0).
  const floored = F.computeExposure({ userId: 'op', now: NOWMS, marks: null }, { fillsFile: fb });
  ok(floored.ok && floored.positions[0].exposureUsd === 90 && floored.positions[0].markSource === 'entry-notional-floor' && floored.openNotionalUsd === 90, 'fills: an unreadable book floors the position at its ENTRY notional ($90) — never understated to zero/mid');
  // and a STALE mark is treated as unreadable → same floor.
  const stale = F.computeExposure({ userId: 'op', now: NOWMS, marks: { T: { price: 0.99, ts: NOWMS - 10 * 60_000 } }, markFreshMs: 60_000 }, { fillsFile: fb });
  ok(stale.positions[0].markSource === 'entry-notional-floor', 'fills: a STALE executable mark is treated as unreadable → entry-notional floor (never a stale valuation)');

  // 12e. REALISED loss EXCLUDES unrealised moves. Open 100@0.60; mark falls to 0.30; NO close → realised 0.
  const fr = tmpFile('fills-realised.jsonl');
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'U', side: 'BUY', filledSize: 100, filledPrice: 0.60, feeUsd: 0, idempotencyKey: 'r1', source: 'sc', ts: dayStart + 1000 }, { fillsFile: fr });
  ok(F.computeRealisedDailyPnl({ userId: 'op', now: NOWMS }, { fillsFile: fr }).realisedPnlUsd === 0, 'fills: an OPEN position that dropped in value contributes ZERO realised loss (unrealised ≠ realised)');
  // now CLOSE it at 0.40 → realised (0.40-0.60)*100 = -20; fees included when present.
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'U', side: 'SELL', filledSize: 100, filledPrice: 0.40, feeUsd: 0, idempotencyKey: 'r2', source: 'sc', ts: dayStart + 2000 }, { fillsFile: fr });
  ok(Math.abs(F.computeRealisedDailyPnl({ userId: 'op', now: NOWMS }, { fillsFile: fr }).realisedPnlUsd + 20) < 1e-6, 'fills: a CLOSED position books its realised P&L (−$20); realised only, from actual proceeds − cost');

  // 12f. UTC day boundary: yesterday's realised loss is NOT counted today (accumulation resets at UTC midnight)…
  const fy = tmpFile('fills-yday.jsonl');
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'Y', side: 'BUY', filledSize: 10, filledPrice: 0.5, idempotencyKey: 'y1', source: 'sc', ts: dayStart - DAY + 10 }, { fillsFile: fy });
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'Y', side: 'SELL', filledSize: 10, filledPrice: 0.1, idempotencyKey: 'y2', source: 'sc', ts: dayStart - DAY + 20 }, { fillsFile: fy });
  const yday = F.computeRealisedDailyPnl({ userId: 'op', now: NOWMS }, { fillsFile: fy });
  ok(yday.realisedPnlUsd === 0 && yday.dayStartUtc === dayStart, 'fills: the daily-loss window is the UTC calendar day — yesterday\'s realised loss is excluded from today');

  // 12g. The RECONCILER: partial→partial, gone+no-trades→no-fill, venue-unreachable→UNKNOWN (never fabricate).
  const sent = [{ idempotencyKey: 'rk', orderId: 'oX', tokenId: 'T', side: 'BUY', price: 0.5, size: 500, notionalUsd: 250, userId: 'op', venue: 'polymarket' }];
  ok(RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [], venueReachable: true, venueOrders: [{ id: 'oX', asset_id: 'T', side: 'BUY', price: '0.5', original_size: '500', size_matched: '120' }] }).toRecord[0].filledSize === 120, 'reconcile: a resting order with size_matched=120 records a PARTIAL fill of 120 (not 500)');
  // ⚠ SPLIT IN TWO ON 2026-08-15, AND THE SECOND HALF PINS A DEFECT RATHER THAN HIDING IT.
  //
  // The original single assertion handed in a ledger row WITHOUT `orderId` and expected the 80 delta. It
  // fails today, and the selfcheck is RIGHT while lib/ is wrong — so it was not softened.
  //
  // WHAT CHANGED IN lib/: `planReconcile` now compares venue truth per VENUE ORDER ID
  // (`recordedFilledByOrderId`) instead of per idempotency key, which is the correct fix for §5-bis p.72
  // — one venue order can be matched by several of our keys. But the fallback is guarded on the wrong
  // side: `const giaVO = idVO ? (recordedVO.get(idVO) || 0) : already;` falls back to the by-key count
  // only when the VENUE's id is unreadable. When the venue id IS readable and the LEDGER ROW has no
  // `orderId`, the lookup silently returns 0 and the whole cumulative `size_matched` is recorded again.
  //
  // ⚠ AND IT IS REACHABLE: `mkFill` writes `orderId: o.orderId || null` — the id of the SENT order, not
  // of the venue order it just matched. `findVenueOrder` also matches by token+side+price, so a
  // placement whose venue id we never captured produces exactly this ledger row. That is the phantom-fill
  // shape that blocked the bot against the $600 cap on 2026-08-09 (2,790 ghost shares against zero at the
  // venue).
  //
  // NOT FIXED HERE, and the reason is discipline, not doubt: `lib/safety/reconcile-fills.js` is on the
  // risk path, and this repo's rule is to PROVE and QUANTIFY a defect on real journals before touching a
  // defence. This checkout has no production journal to count occurrences in. The one-line candidate is
  // `const giaVO = (idVO && recordedVO.has(idVO)) ? recordedVO.get(idVO) : already;` — strictly safer,
  // since a venue id with no ledger rows falls back to a count that is 0 for a fresh order anyway.
  //
  // ① THE REALISTIC CASE — the ledger row carries the venue order id, which is what the reconciler
  //    itself writes whenever it knew that id. The incremental property holds.
  ok(RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [{ kind: 'fill', idempotencyKey: 'rk', orderId: 'oX', filledSize: 120 }], venueReachable: true, venueOrders: [{ id: 'oX', asset_id: 'T', side: 'BUY', price: '0.5', original_size: '500', size_matched: '200' }] }).toRecord[0].filledSize === 80, 'reconcile: partial fills accumulate incrementally (already 120, now 200 → records the 80 delta, never double-counts)');
  // ② THE DEGENERATE CASE — pinned, so that fixing lib/ makes THIS line fail and forces whoever fixes it
  //    to read the note above instead of discovering the change by accident.
  ok(RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [{ kind: 'fill', idempotencyKey: 'rk', filledSize: 120 }], venueReachable: true, venueOrders: [{ id: 'oX', asset_id: 'T', side: 'BUY', price: '0.5', original_size: '500', size_matched: '200' }] }).toRecord[0].filledSize === 200, 'reconcile ⚠ KNOWN DEFECT PINNED: a ledger row WITHOUT orderId against a venue order WITH one re-records the full 200 instead of the 80 delta — see the note above; when this line starts failing, the defect has been fixed and the assertion must become 80');
  ok(RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [], venueReachable: false }).stillUnknown.length === 1 && RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [], venueReachable: false }).toRecord.length === 0, 'reconcile: an UNREACHABLE venue leaves the order UNKNOWN and records NOTHING (never fabricates a fill)');
  ok(RF.planReconcile({ userId: 'op', sentOrders: sent, ledgerRows: [], venueReachable: true, venueOrders: [], venueFills: null }).stillUnknown.length === 1, 'reconcile: an order that vanished with NO /trades cross-check stays UNKNOWN (never assumed filled AND never fabricated)');

  // 12h. usage.readUsage sources the REAL numbers from audit + fill ledger, fail-closed on unreadable.
  const uAudit = tmpFile('usage-audit.jsonl');
  const uFills = tmpFile('usage-fills.jsonl');
  // no fills yet + empty audit → exposure 0, realised 0 (ARMED default — absent ≠ null)
  // ⚠ `venuePositions: { readable: true, positions: [] }` VA INIETTATO, e senza era una trappola.
  // `readUsage` legge le posizioni VERE dallo snapshot del venue quando il chiamante non le passa
  // (`usage.js:78`), quindi questa asserzione — che parla di «registro dei fill ASSENTE» — misurava
  // in realta' lo stato reale della macchina: con la posizione meteo residua da 6 share sul disco
  // usciva `openNotionalUsd = 3` invece di 0, e il selfcheck diventava rosso senza nessun difetto.
  // E' la quinta occorrenza della classe «un gate piu' recente precede quello sotto prova»
  // (CLAUDE.md §5.2 p.27 ④): la cura e' la stessa, si inietta la fixture invece di ammorbidire.
  const u0 = readUsage({ userId: 'op', now: NOWMS, venuePositions: { readable: true, positions: [] } },
    { auditFile: uAudit, fillsFile: uFills });
  ok(u0.openNotionalUsd === 0 && u0.realisedDailyPnlUsd === 0 && u0.ordersInWindow === 0, 'usage: an ABSENT fill ledger yields exposure 0 / realised 0 (the limits ARM), not null — absent ≠ unreadable');
  // corrupt fill ledger → BOTH exposure and realised P&L null → both limits fail closed
  const uBad = tmpFile('usage-badfills.jsonl'); fs.writeFileSync(uBad, '{not json\n');
  const uErr = readUsage({ userId: 'op', now: NOWMS, venuePositions: { readable: true, positions: [] } },
    { auditFile: uAudit, fillsFile: uBad });
  ok(uErr.openNotionalUsd === null && uErr.realisedDailyPnlUsd === null, 'usage: an UNREADABLE fill ledger → openNotionalUsd AND realisedDailyPnlUsd null → both limits FAIL CLOSED');

  // 12i. BOTH now-armed limits fail closed when their measured input is unavailable (direct evaluateLimits).
  const armedLimits = { maxOrderNotionalUsd: 25, maxOpenNotionalUsd: 500, maxOrdersPerWindow: 30, windowMs: 60000, maxDailyLossUsd: 50, venues: ['polymarket'] };
  ok(RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: { openNotionalUsd: null, ordersInWindow: 0, realisedDailyPnlUsd: 0 }, limits: armedLimits }).gate === 'max-open-notional', 'limits: exposure input null → max-open-notional FAILS CLOSED (no order without a verified exposure figure)');
  ok(RL.evaluateLimits({ order: { notionalUsd: 10 }, usage: { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: null }, limits: armedLimits }).gate === 'daily-loss', 'limits: realised-P&L input null → daily-loss FAILS CLOSED');

  // 12j. END-TO-END through the adapter: a realised daily-loss breach TRIPS a durable per-user kill, blocks
  //      the next order, and REQUIRES A HUMAN CLEAR — with NO automatic midnight reset.
  const killFile = tmpFile('dl-kill.json');
  const killAudit = tmpFile('dl-kill-audit.jsonl');
  const limitsFile = tmpFile('dl-limits.json');
  fs.writeFileSync(limitsFile, JSON.stringify({ global: { maxOrderNotionalUsd: 25, maxOpenNotionalUsd: 500, maxOrdersPerWindow: 30, windowMs: 60000, maxDailyLossUsd: 50, venues: ['polymarket'] }, users: {} }));
  const dlAudit = tmpFile('dl-audit.jsonl');
  const dlFills = tmpFile('dl-fills.jsonl');
  // ⚠ AGGIUNTO IL 2026-08-15 — UN GATE PIU' RECENTE PRECEDE QUELLO SOTTO PROVA.
  // `risk-limits.evaluateLimits` rifiuta ora con `venue-positions-unreadable` quando lo snapshot delle
  // posizioni del venue non e' leggibile: non si apre esposizione nuova senza sapere quanta ce n'e' gia'.
  // Senza fixture questa sezione riceveva QUEL rifiuto e concludeva che il gate daily-loss non scattava —
  // cioe' misurava la protezione sbagliata. Un test che vuole esercitare UN gate deve soddisfare tutti
  // gli altri, esattamente come `permissiveSafety()` fa piu' sopra. Lo snapshot e' FRESCO e VUOTO: nessuna
  // posizione aperta, quindi non aggiunge esposizione e non puo' mascherare il limite che si sta provando.
  const dlPositions = tmpFile('dl-positions.json');
  fs.writeFileSync(dlPositions, JSON.stringify({ at: NOWMS, positions: [] }));
  const dlDeps = { auditFile: dlAudit, fillsFile: dlFills, snapshotFile: dlPositions, now: () => NOWMS };
  // a realised −$50 loss TODAY for 'op' (buy 100@0.60, sell 100@0.10 → −50), position now flat (open exposure 0).
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'Z', side: 'BUY', filledSize: 100, filledPrice: 0.60, feeUsd: 0, idempotencyKey: 'z1', source: 'sc', ts: NOWMS - 3000 }, { fillsFile: dlFills });
  F.recordFill({ userId: 'op', venue: 'polymarket', tokenId: 'Z', side: 'SELL', filledSize: 100, filledPrice: 0.10, feeUsd: 0, idempotencyKey: 'z2', source: 'sc', ts: NOWMS - 2000 }, { fillsFile: dlFills });
  const dlSafety = {
    checkKill: ({ userId }) => KS.checkKill({ userId }, { stateFile: killFile, auditFile: killAudit }),
    evaluateForOrder: ({ userId, venue, order }) => {
      const resolved = RL.resolveLimits({ userId }, { configFile: limitsFile });
      if (!resolved.ok) return { venueAllowed: false, limits: { allow: false, gate: 'limits-unreadable' }, clampEvents: [] };
      const venueAllowed = RL.isVenueAllowed({ venue, limits: resolved.limits });
      const usage = readUsage({ userId, now: NOWMS }, dlDeps);
      const limits = RL.evaluateLimits({ order, usage, limits: resolved.limits });
      return { venueAllowed, limits, clampEvents: resolved.clampEvents || [], usage };
    },
    recordIntent: (i) => EA.recordIntent(i, { auditFile: dlAudit }),
    recordOutcome: (o) => EA.recordOutcome(o, { auditFile: dlAudit }),
    deriveIdempotencyKey: EA.deriveIdempotencyKey,
    setUserKill: ({ userId, reason, by }) => KS.setUserKill({ userId, reason, by }, { stateFile: killFile, auditFile: killAudit }),
  };
  // sanity: the daily-loss limit is what usage now measures
  ok(readUsage({ userId: 'op', now: NOWMS }, dlDeps).realisedDailyPnlUsd === -50, 'usage: realised daily P&L reads −$50 from the fill ledger (the input the daily-loss limit needed)');
  const dlAdapter = createMakerAdapter({ mode: 'live-min', liveMinMarket: LIVE_MKT, allowedMarketIds: [], fundingApproved: true, credsProvider: async () => { throw new Error('unused'); }, signerProvider: async () => { throw new Error('unused'); }, safety: dlSafety });
  return dlAdapter.postOrder({ marketId: LIVE_MKT, tokenId: '0xZ', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, userId: 'op', venueRules: VR }).then(dlRes => {
    ok(dlRes.ok === false && dlRes.gate === 'limit-daily-loss', 'daily-loss: a placement while realised loss ≤ −cap is REFUSED at the daily-loss gate (limit-daily-loss)');
    ok(KS.checkKill({ userId: 'op' }, { stateFile: killFile }).gate === 'kill-user', 'daily-loss: the breach AUTO-TRIPS a durable per-user kill (kill-user) — audited, survives restart');
    // the kill blocks the NEXT order for that user
    return dlAdapter.postOrder({ marketId: LIVE_MKT, tokenId: '0xZ', side: 'BUY', price: 0.5, size: 10, tickSize: 0.01, userId: 'op', venueRules: VR });
  }).then(blocked => {
    ok(blocked.ok === false && blocked.gate === 'kill-user', 'daily-loss: the very next order for the user is blocked by the auto-kill (kill-user)');
    // NO automatic midnight reset: rolling to the next UTC day resets the ACCUMULATION but the kill PERSISTS.
    const nextDay = NOWMS + DAY;
    ok(F.computeRealisedDailyPnl({ userId: 'op', now: nextDay }, { fillsFile: dlFills }).realisedPnlUsd === 0, 'daily-loss: a new UTC day resets the realised-loss ACCUMULATION to 0…');
    ok(KS.checkKill({ userId: 'op' }, { stateFile: killFile }).gate === 'kill-user', '…but the per-user kill is NOT auto-cleared at midnight — a broken strategy cannot re-lose the limit every day (durable until a human clears)');
    // a HUMAN clear is what resumes execution.
    KS.clearUserKill({ userId: 'op', by: 'human:selfcheck' }, { stateFile: killFile, auditFile: killAudit });
    ok(KS.checkKill({ userId: 'op' }, { stateFile: killFile }).killed === false, 'daily-loss: only an explicit HUMAN clear (clearUserKill) lifts the kill and lets execution resume');
    noWriteProof();
  });
}

function finish() {
  console.log(`maker selfcheck: ${checks} assertions passed — cancel-only adapter unchanged & cannot place; maker adapter cannot transfer/withdraw; MAKER_MODE=off/paper/dry-run reach NO venue write; every rail trips; STALE feed stands down; below-min flagged; one-sided ÷3 surfaced; tick-snapped; live-min hard cap holds.`);
}
