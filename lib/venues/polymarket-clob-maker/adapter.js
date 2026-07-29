'use strict';
// lib/venues/polymarket-clob-maker/adapter.js — the ISOLATED Polymarket CLOB MAKER adapter.
//
// This is the FIRST component in the project that can PLACE an order. It lives in its own module,
// entirely separate from the cancel-only adapter (../polymarket-clob/adapter.js), whose frozen
// ALLOWED_OPS and "cannot place" proof are deliberately left untouched.
//
// SCOPE — the narrowest surface a reward maker needs, and NOTHING else:
//   postOrder(spec)            WRITE — place ONE limit order (post-only where supported)
//   cancelOrder(orderId)       WRITE — cancel one resting order
//   cancelMarketOrders(mkt)    WRITE — cancel all the user's resting orders on a market (panic/stand-down)
//   listOpenOrders(marketId)   READ  — the user's resting orders (reconciliation)
//   getPositions(marketId?)    READ  — filled inventory (public data-api, keyed by address)
//   healthCheck()              READ  — authenticate (L2) + a getOpenOrders read
// It has NO transfer / withdraw / approve / redeem / deposit / send — asserted against ALLOWED_OPS by
// the maker selfcheck exactly as the cancel adapter asserts its own surface.
//
// STAGED SAFETY (independent belts, in priority order):
//   1. mode: 'off'|'paper' → EVERY mutating call short-circuits to a logged "would-post" synthetic
//      success with ZERO network and NO signer/creds load. Only 'live-min'/'live' can reach the venue.
//   2. dryRun (MAKER_ADAPTER_DRYRUN=true) → same short-circuit, independent of mode. A second belt.
//   3. Credentials + signing key arrive via injected providers, called LAZILY only on a live mutating
//      path. In the disarmed build the wired providers throw, so even a forced live call cannot obtain
//      a key to sign an order.
//   4. live-min → a HARD absolute per-order notional cap (default $25) enforced INSIDE the adapter,
//      below the engine's own caps. A belt the engine cannot accidentally raise.
//   5. The signing signer (holds the raw key) is constructed only inside a live mutating path and
//      scrubbed on close(). clob-client (ESM) is imported lazily, never at module load.
//   6. live-min → a HARD single-market restriction: the order's marketId must equal the pinned
//      MAKER_LIVE_MIN_MARKET, and an unpinned live-min adapter can place nothing at all.
//   7. placement: 'dry-run' (THE DEFAULT) → the order is built, SIGNED, and put to the exchange's own
//      validateOrder() via eth_call, then reported and DROPPED. Nothing reaches POST /order. Only the
//      exact string 'send' arms the venue call, independently of mode and dryRun.
//   8. validate-order → even in 'send', the exchange's validator must ACCEPT the signed struct first;
//      a revert refuses, and an unreachable node ALSO refuses (never read as approval).
//   9. one POST, never two → we deliberately do NOT call the SDK's createAndPostOrder (its internal
//      _retryOnVersionUpdate can re-run build+post and place a second order) and we do NOT retry the
//      POST on a transient error (an ambiguous timeout may already be resting). Build and send are
//      split, and an in-process latch refuses a second POST for the same idempotency key.
//
// Every call, in every mode, writes ONE redacted audit line. No credential/key can reach a log.

const { appendMakerAudit } = require('./audit');
const { redact, safeError, registerSecretValues } = require('../polymarket-clob/redact');
const { signingSignerFromKey } = require('./signer');
const { resolveFunder, venueAccountAddress } = require('./funder');
const { validateQuote } = require('../../maker/venue-rules');
const { computeGtdExpiration } = require('../../maker/order-ttl');
// Ask the exchange itself whether a signed order is valid, via eth_call. Read-only, submits nothing.
const { validateSignedOrder } = require('../../maker/order-validate');
// The venue-agnostic execution-safety layer (durable kill switch + server-side limits + audit trail).
// Default binding; tests inject opts.safety pointed at temp fixtures. Loading it does NO I/O, no network.
const DEFAULT_SAFETY = require('../../safety');

const HOST = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const VENUE = 'polymarket';
const DEFAULT_OPERATOR_USER = process.env.MAKER_OPERATOR_USER || 'operator';

// The ONLY callable operations. The selfcheck asserts the surface against this list.
const ALLOWED_OPS = Object.freeze(['postOrder', 'cancelOrder', 'cancelMarketOrders', 'listOpenOrders', 'getPositions', 'healthCheck', 'close']);
// Modes in which a mutating call may actually reach the venue. off/paper never do.
const LIVE_MODES = Object.freeze(['live-min', 'live']);
const LIVE_MIN_DEFAULT_CAP_USD = 25;

// ── CLOB v2 (migrated 2026-04-28) ─────────────────────────────────────────────
// The signing path now targets @polymarket/clob-client-v2 (installed 1.1.0). The v2 client owns the
// contract/collateral/domain constants internally — this repo hardcodes NONE of them (there is no
// config.js of our own; duplicating an SDK constant would be a second source of truth). For the record,
// the v2 SDK's own getContractConfig(137) (dist/config.js, MATIC_CONTRACTS) — the PRIMARY SOURCE — is:
//   collateral (pUSD, 6 dec)  0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB   (replaces v1 USDC.e 0x2791Bca…)
//   CTFExchangeV2             0xE111180000d2663C0091e4f400237545B87B996B   (replaces deprecated v1 0x4bFb41…)
//   NegRiskCtfExchangeV2      0xe2222d279d744050d28e00520010520000310F59
// The client's createOrder resolves the order version from GET /version (default 2) → signs the V2
// exchange with EIP-712 domain name "Polymarket CTF Exchange", version "2" (ctfExchangeV2TypedData.js),
// and the reshaped v2 order struct (no feeRateBps, no nonce; adds timestamp/metadata/builder — the SDK
// builds & signs it, we never hand-construct it). DEPRECATED v1: @polymarket/clob-client@5.8.1 signed
// the v1 exchange 0x4bFb41… / domain version "1" / USDC.e — kept installed ONLY for the cancel-only
// adapter + derive-creds, never on this placement path.

// Read the installed v2 SDK's major version WITHOUT importing it (its package.json is not exported, so
// resolve the entry and read the nearest package.json off disk). No network, no key. { present, major }.
function v2SdkStatus() {
  try {
    const fs = require('fs'), path = require('path');
    let dir = path.dirname(require.resolve('@polymarket/clob-client-v2'));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (meta && meta.name === '@polymarket/clob-client-v2') {
          const major = parseInt(String(meta.version).split('.')[0], 10);
          return { present: true, version: meta.version, major: Number.isFinite(major) ? major : null };
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return { present: true, version: null, major: null }; // resolvable but version unreadable → fail closed on major
  } catch { return { present: false, version: null, major: null }; }
}

// The full fail-closed placement gate. Pure, no side effects, no network, no key load. Returns the FIRST
// tripped gate (named) or { allow:true }. ORDERED so the cheapest, most decisive checks run first:
//   global kill → per-user kill → venue allowlist → risk limits → v2 SDK → mode → dry-run → funding.
//
// The FIRST four gates (kill/venue/limits) are the execution-safety layer. They are pre-decided by
// FAIL-CLOSED readers in postOrder (safety.checkKill / safety.evaluateForOrder — see lib/safety): those
// readers return killed:true / allow:false when their durable state is unreadable, so by the time a
// decision reaches this pure function it is already definite. When these params are OMITTED (a bare call
// used only by the pure gate-ordering unit tests) the gate is SKIPPED — the fail-closed guarantee lives
// in the readers, and postOrder ALWAYS passes real, definite values (proven independently in the
// selfcheck). Each gate NAMES itself; there is never a generic "refused".
//
// The last four gates are unchanged from the v2 migration and must all still fire: `fundingApproved` is a
// human-attested flag (MAKER_FUNDING_APPROVED) that is NEVER set in this build — pUSD funding + v2
// approvals are Diego's on-chain, signature-gated steps (out of scope).
function evaluatePlacementGate({ mode, dryRun, fundingApproved, sdk, kill, venueAllowed, limits } = {}) {
  // ── execution-safety gates (kill switch + server-side limits) — added, most decisive, checked first ──
  if (kill && kill.killed === true) return { allow: false, gate: kill.gate || 'kill', reason: kill.reason || 'execution is KILLED' };
  if (venueAllowed === false) return { allow: false, gate: 'venue-allowlist', reason: 'venue is not on this user\'s execution allowlist — refusing (missing allowlist = no venue permitted).' };
  if (limits && limits.allow === false) return { allow: false, gate: `limit-${limits.gate || 'unknown'}`, reason: limits.reason || 'a server-side risk limit tripped.' };
  // ── existing v2-migration gates (unchanged) — SDK → mode → dry-run → funding ──
  const s = sdk || { present: false, major: null, version: null };
  if (!s.present) return { allow: false, gate: 'v2-sdk-missing', reason: 'CLOB v2 SDK (@polymarket/clob-client-v2) is not installed — cannot sign a v2 order. Install it before any live placement.' };
  if (!(s.major >= 1)) return { allow: false, gate: 'v2-sdk-major', reason: `CLOB v2 SDK major version ${s.version || 'unknown'} < 1 — refusing to sign against an unverified SDK major.` };
  if (!LIVE_MODES.includes(mode)) return { allow: false, gate: 'maker-mode', reason: `MAKER_MODE='${mode}' is not a live stage (live-min|live) — placement is disarmed.` };
  if (dryRun === true) return { allow: false, gate: 'dry-run', reason: 'MAKER_ADAPTER_DRYRUN is set — forced shadow, no venue write.' };
  if (fundingApproved !== true) return { allow: false, gate: 'funding-approval', reason: 'Wallet pUSD funding + v2 ERC-20/ERC-1155 approvals are not attested (MAKER_FUNDING_APPROVED unset). Fund pUSD (0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB) and grant approvals to CTFExchangeV2 (0xE111180000d2663C0091e4f400237545B87B996B) + NegRiskCtfExchangeV2 (0xe2222d279d744050d28e00520010520000310F59), then attest — Diego\'s on-chain signatures required.' };
  return { allow: true, gate: null };
}

/**
 * THE live-min SINGLE-MARKET GATE. `live-min` is documented as "REAL orders, ONE market only
 * (MAKER_LIVE_MIN_MARKET), a HARD absolute" — but until this existed, nothing anywhere in the codebase
 * compared an order's market against that pin. The value was read into config, reported into the
 * heartbeat, and never enforced: in live-min the maker would have placed real orders on every market
 * that had a leg. The narrowest, most safety-critical stage was the one with the missing bound.
 *
 * FAIL CLOSED, in all three ways it can fail:
 *   • live-min with NO pin configured        → REFUSE. "One market only" with no market named is not a
 *                                              restriction; it is the absence of one. Refusing is the
 *                                              only reading that keeps the stage's promise.
 *   • an order carrying no marketId          → REFUSE. We cannot prove it is the pinned market, and
 *                                              "could not check" must never equal "check passed".
 *   • marketId != the pin                    → REFUSE, naming both so the operator sees the mismatch.
 *
 * Applies ONLY to live-min. `live` is the unrestricted stage by design, and off/paper/dry-run reach no
 * venue write at all — gating them would hide configuration errors behind a mode that cannot cause harm.
 *
 * Pure and side-effect free (no env, no I/O), so maker-selfcheck.js can exhaust it.
 *
 * @returns {{allow:boolean, gate:(string|null), reason:(string|null)}}
 */
function evaluateLiveMinMarketGate({ mode, liveMinMarket, marketId } = {}) {
  if (mode !== 'live-min') return { allow: true, gate: null, reason: null };

  const pin = typeof liveMinMarket === 'string' ? liveMinMarket.trim() : '';
  if (!pin) {
    return { allow: false, gate: 'live-min-market-unset', reason: 'MAKER_MODE=live-min promises "ONE market only" but MAKER_LIVE_MIN_MARKET is not set — there is no market to restrict to. Refusing rather than placing real orders on an unbounded set of markets.' };
  }
  const got = typeof marketId === 'string' ? marketId.trim() : '';
  if (!got) {
    return { allow: false, gate: 'live-min-market-unknown', reason: `live-min is restricted to market ${pin}, but this order carries no marketId — the restriction cannot be proven, so it is refused (a check that could not run is not a check that passed).` };
  }
  if (got.toLowerCase() !== pin.toLowerCase()) {
    return { allow: false, gate: 'live-min-market-mismatch', reason: `live-min hard restriction: this order is for market ${got}, but MAKER_LIVE_MIN_MARKET pins the stage to ${pin}. Refusing.` };
  }
  return { allow: true, gate: null, reason: null };
}

// The ONE CLOB order version this build is approved to sign. Not a preference — an approval boundary.
// The wallet's ERC-20/ERC-1155 approvals are granted to the v2 exchanges specifically (CTFExchangeV2
// 0xE111180000…B996B, NegRiskCtfExchangeV2 0xe2222d27…310F59). An order signed for any other exchange
// version settles against contracts this wallet has never approved.
const SUPPORTED_ORDER_VERSION = 2;

// Refuse any CLOB order version other than the one this build is approved for.
//
// WHY THIS IS NOT PARANOIA. The version is NOT pinned by us: the v2 SDK resolves it from the venue at
// runtime (client.resolveVersion() → GET /version, `?? 2` when absent), and the SAME installed SDK 1.1.0
// already ships an ExchangeOrderBuilderV3 plus an exchangeV3 address (0xe3333700…6c00Aa). So the day
// Polymarket answers `3`, the client would silently build and sign a V3 order against an exchange this
// wallet has granted nothing to — the exact V1→V2 failure mode, one version later.
//
// FAIL CLOSED: an unreadable/absent/non-integer version REFUSES. "Could not read the version" and "the
// version is fine" must never be the same outcome — that is how a silent downgrade ships.
//
// Pure and side-effect free (no network): the caller resolves the version and passes it in, exactly as
// it already does for `sdk` via v2SdkStatus(). That keeps this unit-testable in maker-selfcheck.js.
function evaluateOrderVersionGate(version) {
  if (version === null || version === undefined || version === '') {
    return { allow: false, gate: 'order-version-unknown', reason: 'could not read the CLOB order version negotiated with the venue (GET /version) — refusing to sign blind. A version we cannot read is not a version we can approve.' };
  }
  const v = Number(version);
  if (!Number.isInteger(v)) {
    return { allow: false, gate: 'order-version-unknown', reason: `the venue reported a non-integer CLOB order version (${JSON.stringify(version)}) — refusing to sign against an unparseable version.` };
  }
  if (v !== SUPPORTED_ORDER_VERSION) {
    return { allow: false, gate: 'order-version', reason: `the venue negotiated CLOB order version ${v}, but this build is approved only for v${SUPPORTED_ORDER_VERSION}. Signing would target a different exchange contract than the one this wallet has approved (pUSD allowances + ERC-1155 setApprovalForAll are granted to the v2 exchanges only). Re-approve on-chain for the new exchange and raise SUPPORTED_ORDER_VERSION deliberately — never automatically.` };
  }
  return { allow: true, gate: null };
}

function isTransient(status) { return status === 429 || (status >= 500 && status <= 599); }
function isAlreadyGone(msg) { return /not found|already (cancel|fill)|no such order|does not exist|invalid order id/i.test(String(msg || '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// priceValid mirror (clob-client utilities.priceValid): price ∈ [tick, 1-tick].
function priceOnTick(price, tick) {
  if (!(tick > 0) || price == null) return false;
  const dp = String(tick).split('.')[1]?.length || 0;
  const snapped = Math.round(price / tick) * tick;
  const near = Math.abs(price - snapped) < tick / 1000;
  const inRange = price >= tick - 1e-12 && price <= 1 - tick + 1e-12;
  return near && inRange && Number.isFinite(Number(price.toFixed(dp)));
}

/**
 * Build the maker adapter.
 * @param {object} opts
 *   mode           'off'|'paper'|'live-min'|'live' (default 'off'). off/paper never touch the venue.
 *   dryRun         boolean — independent short-circuit belt (default false).
 *   credsProvider  async () => ({ creds:{key,secret,passphrase}, address }) — L2 creds for post/cancel/list.
 *   signerProvider async () => ({ privateKey, address }) — the raw key for the L1 order signature.
 *                  Both are called LAZILY, only on a live mutating path; in the disarmed build they throw.
 *   funder         { signatureType, funderAddress } — WHO the order is signed FOR (see ./funder.js).
 *                  Defaults to resolveFunder(process.env). Resolved EAGERLY here so a misconfigured
 *                  funder fails at construction, not mid-flight with a key already decrypted.
 *   liveMinCapUsd  number — hard per-order notional cap in live-min (default 25).
 *   placement      'dry-run'|'send' — DEFAULT 'dry-run' (build+sign+validateOrder, never POST).
 *                  Anything other than the exact string 'send' resolves to dry-run.
 *   liveMinMarket  string — the ONE conditionId live-min may quote (default MAKER_LIVE_MIN_MARKET).
 *                  Unset ⇒ every live-min order is REFUSED (see evaluateLiveMinMarketGate).
 *   now / maxRetries — clock + retry injection (tests).
 */
function createMakerAdapter(opts = {}) {
  const mode = LIVE_MODES.includes(opts.mode) || opts.mode === 'paper' ? opts.mode : 'off';
  const dryRun = opts.dryRun === true;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const liveMinCapUsd = Number.isFinite(opts.liveMinCapUsd) ? opts.liveMinCapUsd : LIVE_MIN_DEFAULT_CAP_USD;
  // The ONE market live-min may touch. Read from opts, else MAKER_LIVE_MIN_MARKET. Deliberately NOT
  // defaulted to anything: an unset pin makes evaluateLiveMinMarketGate refuse every live-min order,
  // which is the correct reading of "one market only" when no market has been named.
  const liveMinMarket = typeof opts.liveMinMarket === 'string' && opts.liveMinMarket.trim()
    ? opts.liveMinMarket.trim()
    : (typeof process.env.MAKER_LIVE_MIN_MARKET === 'string' ? process.env.MAKER_LIVE_MIN_MARKET.trim() : '');

  // ── PLACEMENT: 'dry-run' (DEFAULT) or 'send'. The last belt, and the one that defaults closed. ──
  // dry-run builds the order, SIGNS it, asks CTFExchangeV2.validateOrder() to accept it via eth_call,
  // reports exactly what would have been sent — and stops there. Nothing reaches POST /order.
  // Reaching the venue requires an explicit, deliberate 'send'; ANY other value (unset, typo, empty,
  // 'SEND ', 'true', 'yes') resolves to dry-run, because the failure mode of guessing wrong here is a
  // real order placed with real money. This is independent of MAKER_MODE and of dryRun: even a fully
  // armed live adapter with funding attested will not send while placement is dry-run.
  const placementRaw = typeof opts.placement === 'string' && opts.placement.trim()
    ? opts.placement.trim()
    : (typeof process.env.MAKER_PLACEMENT === 'string' ? process.env.MAKER_PLACEMENT.trim() : '');
  const placement = placementRaw === 'send' ? 'send' : 'dry-run';

  // One-shot latch of idempotency keys this ADAPTER INSTANCE has actually POSTed. The durable
  // safety-layer ledger is the real cross-process guard; this is a cheap in-process belt so that no
  // code path — a retry, a re-entrant call, a caller loop — can drive the same key through POST twice.
  const _sentKeys = new Set();
  // Venue-native order TTL (seconds). Every order carries a signed GTD expiration this many seconds out,
  // so the venue kills it even if this whole host is gone. A per-order spec.ttlSeconds overrides it.
  const orderTtlSeconds = Number.isFinite(opts.orderTtlSeconds) ? opts.orderTtlSeconds : 60;
  // Execution-safety layer + the user this adapter posts on behalf of (single-operator today).
  const safety = opts.safety || DEFAULT_SAFETY;
  const operatorUser = opts.operatorUser || DEFAULT_OPERATOR_USER;
  // Where audit records go. Defaults to the append-only maker trail; tests inject a sink to OBSERVE that a
  // refusal (e.g. the venue-rules guard below) actually writes its reason code, without touching the real file.
  const auditSink = typeof opts.auditSink === 'function' ? opts.auditSink : appendMakerAudit;
  // WHO this adapter signs FOR. Resolved EAGERLY (at construction) and fail-closed: a funder that is
  // half-configured throws HERE, in every mode, rather than at the moment an armed order is being built
  // with a decrypted key in memory. opts.funder lets tests/callers inject a resolved pair directly.
  const funder = opts.funder || resolveFunder(process.env);
  // A mutating call reaches the venue only when the mode is live AND dry-run is off.
  const canWrite = LIVE_MODES.includes(mode) && !dryRun;
  if (canWrite && typeof opts.credsProvider !== 'function') throw new Error('createMakerAdapter: a credsProvider is required for a live adapter');
  if (canWrite && typeof opts.signerProvider !== 'function') throw new Error('createMakerAdapter: a signerProvider is required for a live adapter');

  const execMode = dryRun ? `${mode}:dryrun` : mode;
  let _signerHandle = null; // { signer, address, scrub } — built lazily, scrubbed on close()

  function audit(op, fields) { auditSink({ ts: now(), venue: 'polymarket', op, mode: execMode, ...fields }); }

  // Synthetic "would-post"/"would-cancel" success for off/paper/dry-run — no network, no key.
  function shadowOk(op, fields, extra = {}) {
    audit(op, { requested: redact(fields), response: `${execMode}: no network call`, outcome: 'shadow', latencyMs: 0, ...extra });
    return { ok: true, sent: false, simulated: true, mode: execMode, op, ...fields, ...extra };
  }

  // Lazily construct a live ClobClient: L2 creds for HMAC + a SIGNING signer (holds the key) for L1.
  async function liveClient() {
    const { creds, address } = await opts.credsProvider();
    if (!creds || !creds.key || !creds.secret || !creds.passphrase || !address) throw new Error('credsProvider returned incomplete credentials');
    registerSecretValues([creds.key, creds.secret, creds.passphrase]);
    if (!_signerHandle) {
      const { privateKey, address: signerAddr } = await opts.signerProvider();
      registerSecretValues([privateKey]); // so redact() blanks it from any later text (belt; we never log it)
      _signerHandle = signingSignerFromKey(privateKey);
      if (signerAddr && _signerHandle.address.toLowerCase() !== String(signerAddr).toLowerCase()) {
        throw new Error('signer address does not match the custody-recorded address — refusing to sign');
      }
    }
    const { ClobClient } = await import('@polymarket/clob-client-v2'); // v2 ESM, lazy — never at module load
    // v2 constructor is OBJECT-form (v1 was positional). chain=137 (Chain.POLYGON). Our signer is the
    // ethers-shaped { getAddress, _signTypedData } that v2 accepts directly (ClobSigner = EthersSigner).
    //
    // signatureType + funderAddress come from ./funder.js (env-configured, never hardcoded) and decide
    // the identity of every order this client builds. Inside the SDK (order-builder/helpers/createOrder.js):
    //   maker  = funderAddress ?? signerAddress          ← the account that pays and gets filled
    //   signer = (signatureType === 3) ? maker : signerAddress
    // so with a funder configured, orders are made FOR the funder and SIGNED BY the custody EOA. Passing
    // neither (the previous behaviour) silently produced maker == signer == the EOA — an order against an
    // empty wallet, which the exchange's own validateOrder() rejects.
    return new ClobClient({ host: HOST, chain: CHAIN_ID, signer: _signerHandle.signer, creds,
      signatureType: funder.signatureType, funderAddress: funder.funderAddress });
  }

  async function withRetry(fn) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try { return await fn(); }
      catch (e) {
        const status = e && (e.status || (e.response && e.response.status));
        if (isTransient(status) && attempt < maxRetries) { attempt++; await sleep(250 * 2 ** (attempt - 1)); continue; }
        throw e;
      }
    }
  }

  // ── WRITE: place one limit order (post-only where supported) ──────────────────
  // spec: { tokenId, side:'BUY'|'SELL', price, size, tickSize, postOnly=true, negRisk,
  //         venueRules:{ tick, scoringMid, maxSpreadCents, minSize, priceMin?, priceMax? } }
  // venueRules is REQUIRED: the shared venue-rules guard fails closed without it (no order can be signed
  // for a market whose rules could not be read). It is the SAME object the UI passes to validateQuotePair.
  async function postOrder(spec) {
    const s = spec || {};
    const t0 = now();
    // ── VENUE-NATIVE ORDER EXPIRY — computed at placement time from the (per-order or adapter) TTL.
    //    This is the ONLY layer that survives host death: a dead process cannot cancel its orders, but
    //    the venue enforces this signed GTD expiration regardless. Clamped up to the venue's 3-min GTD
    //    floor when the desired TTL is shorter (flagged), never sent below the floor (would be rejected).
    const ttlSeconds = Number.isFinite(s.ttlSeconds) ? s.ttlSeconds : orderTtlSeconds;
    const ttl = computeGtdExpiration(t0, ttlSeconds);
    const req = { tokenId: s.tokenId, side: s.side, price: s.price, size: s.size, tickSize: s.tickSize, postOnly: s.postOnly !== false, negRisk: s.negRisk,
      orderType: ttl.orderType, expiration: ttl.expiration, expirationIso: ttl.expirationIso,
      requestedTtlSeconds: ttl.requestedTtlSeconds, effectiveTtlSeconds: ttl.effectiveTtlSeconds, clampedToVenueFloor: ttl.clampedToVenueFloor };

    // Defensive validation — INDEPENDENT of the engine's own checks (defense in depth). Never posts an
    // unsnapped price or a sub-tick order, and honours the live-min hard cap.
    if (!s.tokenId || (s.side !== 'BUY' && s.side !== 'SELL')) { audit('postOrder', { requested: redact(req), response: 'reject: tokenId+side required', outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: 'tokenId and side (BUY|SELL) required' }; }
    if (!(s.price > 0) || !(s.size > 0)) { audit('postOrder', { requested: redact(req), response: 'reject: price/size must be > 0', outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: 'price and size must be > 0' }; }
    if (s.tickSize != null && !priceOnTick(s.price, s.tickSize)) { audit('postOrder', { requested: redact(req), response: `reject: price ${s.price} not on tick ${s.tickSize}`, outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: `price ${s.price} is not a valid multiple of tick ${s.tickSize} (or out of [tick,1-tick])` }; }
    const notionalUsd = s.price * s.size;
    if (mode === 'live-min' && notionalUsd > liveMinCapUsd + 1e-9) { audit('postOrder', { requested: redact(req), response: `reject: notional $${notionalUsd.toFixed(2)} > live-min cap $${liveMinCapUsd}`, outcome: 'reject-cap', latencyMs: 0 }); return { ok: false, sent: false, reason: `live-min hard cap: order notional $${notionalUsd.toFixed(2)} exceeds $${liveMinCapUsd}` }; }

    // ── live-min SINGLE-MARKET GATE — the other half of what "live-min" means. The cap above bounds HOW
    //    MUCH one order can be; this bounds WHICH MARKET it may touch. Both are checked before the mode
    //    branch, so they fire in every mode's audit trail and always before any signing path is reached. ──
    const lmg = evaluateLiveMinMarketGate({ mode, liveMinMarket, marketId: s.marketId });
    if (!lmg.allow) {
      audit('postOrder', { requested: redact(req), response: `reject: ${lmg.gate}`, outcome: 'reject-live-min-market', latencyMs: 0, gate: lmg.gate });
      return { ok: false, sent: false, gate: lmg.gate, reason: lmg.reason };
    }

    // ── SHARED VENUE-RULES GUARD — the EXACT validateQuote the UI band-warning calls (lib/maker/venue-rules).
    //    An order that is off-tick, out of the reward band (|price − scoring mid| > maxSpread/2), below
    //    min_incentive_size, or out of the venue's price range is REFUSED HERE — before the mode branch, so
    //    the refusal fires in EVERY mode (off/paper/dry-run/live) and therefore ALWAYS before any signing.
    //    FAIL CLOSED: no readable venue rules on the spec ⇒ RULES_UNREADABLE ⇒ refuse (never a default band).
    //    This is why the maker cannot sign what the UI paints red even if a config or input asks for it: the
    //    gate is the identical shared function, not a re-implementation that could drift.
    const vq = validateQuote(s.venueRules, { side: s.side, price: s.price, size: s.size });
    if (!vq.valid) {
      const codes = vq.reasons.map((r) => r.code).join(',');
      audit('postOrder', { requested: redact(req), response: `reject: venue-rules ${codes}`, outcome: 'reject-venue-rules', latencyMs: 0, gate: 'venue-rules', reasons: vq.reasons });
      return { ok: false, sent: false, gate: 'venue-rules', reasons: vq.reasons, reason: vq.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ') };
    }

    if (!canWrite) return shadowOk('postOrder', req, { notionalUsd: +notionalUsd.toFixed(4), wouldPost: true });

    // ── EXECUTION-SAFETY GATE CHAIN — runs HERE, before liveClient() (NO network, NO KEY DECRYPTION) ──
    // Ordered: global kill → per-user kill → venue allowlist → risk limits → SDK → mode → dry-run →
    // funding. Every input comes from FAIL-CLOSED durable readers (lib/safety): an unreadable kill state
    // or an unreadable/missing limit resolves to killed / refuse, so a placement can NEVER slip through on
    // a failed read. A refusal returns from HERE — the (throwing or real) providers are never invoked, so
    // no key is decrypted for a killed/limited order.
    const userId = s.userId || operatorUser;
    const kill = safety.checkKill({ userId });
    const { venueAllowed, limits, clampEvents } = safety.evaluateForOrder({ userId, venue: VENUE, order: { notionalUsd } });
    const gatesEvaluated = {
      kill: { killed: kill.killed, gate: kill.gate },
      venueAllowed,
      limits: { allow: limits.allow, gate: limits.gate || null },
      clampEvents: clampEvents || [],
    };
    const gate = evaluatePlacementGate({ mode, dryRun, fundingApproved: opts.fundingApproved === true, sdk: v2SdkStatus(), kill, venueAllowed, limits });
    if (!gate.allow) {
      // A realised daily-loss breach trips a DURABLE, audited automatic per-user kill (not just a refusal).
      if (limits && limits.autoKill === true) { try { safety.setUserKill({ userId, reason: 'auto: realised daily-loss limit breached', by: 'auto:risk-limits' }); } catch { /* kill best-effort; order is refused regardless */ } }
      audit('postOrder', { requested: redact(req), response: `reject: ${gate.gate}`, outcome: `reject-${gate.gate}`, latencyMs: 0, gate: gate.gate });
      return { ok: false, sent: false, gate: gate.gate, reason: gate.reason };
    }

    // ── THE IDEMPOTENCY KEY is derived here (both branches need it to name themselves in the audit),
    //    but THE INTENT IS NOT RECORDED YET. It is written immediately before the POST, and ONLY there.
    //
    //    WHY THAT PLACEMENT IS LOAD-BEARING. lib/safety/usage.js counts EVERY intent row as a
    //    possibly-live order at full notional ("an intent is written only AFTER all gates pass and
    //    immediately before the send"). Recording one here — before the dry-run branch, which sends
    //    nothing — breaks that invariant and books PHANTOM EXPOSURE for an order that never existed.
    //    Measured: two dry-runs put $49.55 of imaginary open exposure into the ledger, which then
    //    refused the next real attempt with limit-max-open-notional. In a maker that dry-runs every
    //    tick it would grow without bound and wedge the risk limits permanently.
    //
    //    Building and signing an order reaches no venue, so there is nothing to leave evidence of until
    //    the POST is imminent. Deferring the write does not weaken "no durable intent ⇒ no order": the
    //    send branch still refuses if the intent cannot be persisted, and now the row means what
    //    usage.js already believed it meant.
    const idempotencyKey = s.idempotencyKey || safety.deriveIdempotencyKey({ userId, venue: VENUE, tokenId: s.tokenId, side: s.side, price: s.price, size: s.size });

    // Whether the venue POST was genuinely ATTEMPTED. Everything before it — loading creds, decrypting
    // the key, resolving the version, building and signing, validating on-chain — reaches no venue, so a
    // throw there is a clean miss, not an ambiguous one. Reporting sent:true for those would tell the
    // operator an order might be resting when none could possibly be.
    let postAttempted = false;
    try {
      const client = await liveClient();

      // ── ORDER-VERSION GATE — the last gate, and the only one that needs the client ────────────────
      // It lives HERE, not in evaluatePlacementGate, because the version is a property of the VENUE
      // (resolved over the network), not of our configuration. Running it after the cheap pure gates
      // means a disarmed maker never issues this request at all.
      // resolveVersion() memoises into client.cachedVersion, so the createOrder below reuses THIS value
      // rather than re-fetching — the check and the signature see the same version.
      let negotiatedVersion = null;
      try { negotiatedVersion = await client.resolveVersion(); } catch { negotiatedVersion = null; } // unreadable → null → refuse
      const vGate = evaluateOrderVersionGate(negotiatedVersion);
      if (!vGate.allow) {
        audit('postOrder', { requested: redact(req), response: `reject: ${vGate.gate}`, outcome: `reject-${vGate.gate}`, latencyMs: now() - t0, gate: vGate.gate, negotiatedVersion });
        return { ok: false, sent: false, gate: vGate.gate, reason: vGate.reason };
      }

      // FEE: do NOT hardcode feeRateBps. Under CLOB v2 fees are TAKER-ONLY and PROTOCOL-DETERMINED
      // per-market; the client resolves the authoritative base_fee from GET /fee-rate and signs the
      // order with THAT value. Passing feeRateBps:0 makes _resolveFeeRateBps THROW on any market whose
      // base_fee > 0 ("fee rate for the market must be N"); omitting it lets the server value stand
      // (a maker's resolved fee is 0 under taker-only, but we never assume it).
      // `expiration` is a SIGNED field in the v2 order struct (UserOrderV2.expiration → NewOrderV2.expiration,
      // unix seconds) — setting it changes the order signature, which is exactly the point: the venue can
      // only honour an expiry it signed. GTD (not GTC) is required for a non-zero expiration to take effect.
      const userOrder = { tokenID: String(s.tokenId), price: s.price, size: s.size, side: s.side, expiration: ttl.expiration };
      // `version` is PINNED to the value just asserted, not left to re-resolution. createAndPostOrder
      // wraps the build in _retryOnVersionUpdate, which re-reads the version AFTER the call and re-runs
      // the whole build when it changed; without this pin that second pass could sign a different
      // struct than the one approved above. options.version short-circuits createOrder's
      // `options?.version ?? await this.resolveVersion()`, so every signature stays v2 or none is made.
      const options = { tickSize: s.tickSize != null ? String(s.tickSize) : undefined, negRisk: s.negRisk, version: SUPPORTED_ORDER_VERSION };

      // ── BUILD AND SEND ARE SPLIT ON PURPOSE. WE DO NOT CALL createAndPostOrder. ──────────────────────
      // The SDK's createAndPostOrder wraps the whole build+post in _retryOnVersionUpdate:
      //
      //     async _retryOnVersionUpdate(retryFunc) {
      //       const version = await this.resolveVersion();
      //       for (let attempt = 0; attempt < 2; attempt++) {
      //         await retryFunc();                                  // ← createOrder AND postOrder
      //         if (version === await this.resolveVersion()) break;
      //       }
      //     }
      //
      // and postOrder itself force-refreshes the cached version on a version-mismatch response
      // (client.js:563 `if (this._isOrderVersionMismatch(res)) await this.resolveVersion(true)`). So if
      // the venue rolls the order version mid-flight, the equality check fails and retryFunc runs a
      // SECOND time — posting a second order while the first may already be resting. Our idempotency
      // latch cannot see that: it guards OUR call, and the duplicate happens inside the SDK, below it.
      //
      // Calling createOrder and postOrder ourselves removes the loop entirely: exactly one build, at
      // most one POST, no hidden retry. It also gives us the dry-run seam for free — a signed order we
      // can validate on-chain and then simply not send. `options.version` still pins the struct.
      const signedOrder = await client.createOrder(userOrder, options);

      // ── ASK THE EXCHANGE, BEFORE SENDING ANYTHING ───────────────────────────────────────────────────
      // validateOrder() is a view function: an eth_call that reverts on an invalid order and submits
      // nothing. It is the venue's own verdict on this exact signed struct, available without placing it.
      // FAIL CLOSED: valid===false refuses, and valid===null ("could not ask") ALSO refuses — an
      // unreachable node must never be read as approval.
      const verdict = await validateSignedOrder(signedOrder, { negRisk: s.negRisk === true, rpcUrl: opts.rpcUrl });
      if (verdict.valid !== true) {
        const why = verdict.valid === false
          ? `the exchange's own validateOrder() REVERTED for this signed order: ${verdict.reason}`
          : `could not reach ${verdict.exchange.name} to validate the order (${verdict.reason}) — refusing to send an order we could not verify`;
        safety.recordOutcome({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, ok: false, error: why });
        audit('postOrder', { requested: redact(req), response: `reject: validate-order (${verdict.valid === false ? 'reverted' : 'unreachable'})`, outcome: 'reject-validate-order', latencyMs: now() - t0, gate: 'validate-order', idempotencyKey });
        return { ok: false, sent: false, gate: 'validate-order', reason: why, validateOrder: verdict };
      }

      // A compact, non-secret description of EXACTLY what would go to the venue. The signature is a
      // public artefact of a public order, but it is long and noisy, so only its length is reported.
      const wouldSend = {
        exchange: `${verdict.exchange.name} ${verdict.exchange.addr}`,
        maker: signedOrder.maker, signer: signedOrder.signer, signatureType: signedOrder.signatureType,
        tokenId: String(signedOrder.tokenId), side: signedOrder.side,
        makerAmount: String(signedOrder.makerAmount), takerAmount: String(signedOrder.takerAmount),
        price: s.price, size: s.size, notionalUsd: +notionalUsd.toFixed(4),
        orderType: ttl.orderType, expiration: ttl.expiration, expirationIso: ttl.expirationIso,
        postOnly: s.postOnly !== false, negRisk: s.negRisk === true,
        signatureBytes: typeof signedOrder.signature === 'string' ? (signedOrder.signature.length - 2) / 2 : null,
        validateOrder: 'ACCEPTED (eth_call — nothing submitted)',
      };

      // ── THE DEFAULT IS TO NOT SEND. ─────────────────────────────────────────────────────────────────
      // placement='dry-run' means: build it, sign it, prove the venue's validator accepts it, report
      // exactly what would have gone — and stop. Reaching the venue's POST /order requires a deliberate
      // flip to 'send'; no mode, no config drift and no gate ordering can produce a send by accident,
      // because this is the last thing checked and it defaults closed.
      if (placement !== 'send') {
        // NO intent row and NO outcome row: nothing was sent, so nothing may be booked as exposure or
        // counted against the rate limit. The maker audit line below is the full record of a dry-run.
        audit('postOrder', { requested: redact(req), response: redact({ dryRun: true, wouldSend }), outcome: 'dry-run-validated', latencyMs: now() - t0, notionalUsd: +notionalUsd.toFixed(4), idempotencyKey });
        return { ok: true, sent: false, dryRun: true, placement, wouldSend, validateOrder: verdict, notionalUsd: +notionalUsd.toFixed(4), idempotencyKey };
      }

      // ── INTENT BEFORE SEND — idempotency + evidence. No durable intent ⇒ NO order (fail closed). ────
      // This is the last thing that happens before the venue call, which is exactly what usage.js
      // assumes when it treats every intent row as a possibly-live order. An intent that exists is an
      // order that may be resting; an order that rests always has an intent.
      let intentRes;
      try {
        intentRes = safety.recordIntent({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, side: s.side, price: s.price, size: s.size, notionalUsd: +notionalUsd.toFixed(4), decision: redact(s.decision || null), gates: gatesEvaluated, mode: execMode });
      } catch (e) {
        audit('postOrder', { requested: redact(req), response: 'reject: could not durably record intent', outcome: 'reject-audit-intent', latencyMs: now() - t0, idempotencyKey });
        return { ok: false, sent: false, gate: 'audit-intent', reason: 'could not durably record the intent before send — refusing to place (no evidence, no order)' };
      }
      if (intentRes.duplicate === true) {
        audit('postOrder', { requested: redact(req), response: 'reject: duplicate idempotency key', outcome: 'reject-idempotent', latencyMs: now() - t0, idempotencyKey });
        return { ok: false, sent: false, gate: 'idempotent-duplicate', reason: `an order for idempotency key ${idempotencyKey} was already attempted — refusing to place it twice` };
      }

      // ── SEND: exactly one POST, latched so it can never be entered twice for this key. ──────────────
      if (_sentKeys.has(idempotencyKey)) {
        audit('postOrder', { requested: redact(req), response: 'reject: idempotency latch — this key already reached the venue in this process', outcome: 'reject-idempotent-latch', latencyMs: now() - t0, idempotencyKey });
        return { ok: false, sent: false, gate: 'idempotent-latch', reason: `idempotency key ${idempotencyKey} has already been POSTed by this adapter — refusing a second send` };
      }
      _sentKeys.add(idempotencyKey);
      postAttempted = true;   // from here on, a throw is AMBIGUOUS: the order may be resting
      // v2 signature: postOrder(order, orderType, postOnly=false, deferExec=false).
      //
      // DELIBERATELY NOT WRAPPED IN withRetry. A POST that fails transiently (429/5xx/timeout) is
      // AMBIGUOUS, not failed: the order may already be resting at the venue. Retrying it here is the
      // classic way to end up with two orders from one intent. Retry belongs one layer up, keyed on the
      // same idempotencyKey — where the duplicate is REFUSED (see the idempotent-duplicate gate) rather
      // than silently re-sent. Reads and cancels still use withRetry; only the placement does not.
      const res = await client.postOrder(signedOrder, ttl.orderType, s.postOnly !== false, false);
      const orderId = res && (res.orderID || res.orderId || (res.order && res.order.id)) || null;
      // HONESTY AT THE VENUE BOUNDARY. The CLOB can return an HTTP error object (e.g. 403 "Trading
      // restricted in your region") WITHOUT a success:false field — a bare `{ error, status }`. The old
      // check `res.success !== false` read that as a SUCCESS, so a geoblocked/rejected order was reported
      // ok:true with a null id. Treat any non-2xx status, an `error` field, or explicit success:false as a
      // REJECTION: a rejected order is never reported as placed (that is the whole honest-engine point here).
      const httpStatus = res && Number(res.status);
      const httpError = Number.isFinite(httpStatus) && httpStatus >= 400;
      const venueError = !!(res && (res.error != null || res.success === false));
      const placed = !!res && !httpError && !venueError;
      const rejectReason = httpError ? `venue HTTP ${httpStatus}${res.error ? ': ' + String(res.error) : ''}` : venueError ? String(res.error || 'venue reported success:false') : null;
      safety.recordOutcome({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, ok: placed, orderId, response: redact({ success: res && res.success, status: res && res.status, error: res && res.error }) });
      audit('postOrder', { requested: redact(req), response: redact({ success: res && res.success, orderId, status: res && res.status, error: res && res.error }), outcome: placed ? 'ok' : 'reject-venue', latencyMs: now() - t0, notionalUsd: +notionalUsd.toFixed(4), idempotencyKey, ...(rejectReason ? { rejectReason } : {}) });
      return { ok: placed, sent: true, orderId, ...(rejectReason ? { reason: rejectReason } : {}), notionalUsd: +notionalUsd.toFixed(4), idempotencyKey, response: redact(res) };
    } catch (e) {
      // The venue call (or key decryption) threw AFTER the intent was recorded — the INTENT row persists
      // as evidence that something was attempted; write an outcome-error row referencing its key.
      // Only record an outcome against an intent that exists — an intent is written only on the send
      // path, so a throw before it has no intent to resolve and must not fabricate one.
      if (postAttempted) safety.recordOutcome({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, ok: false, error: safeError(e) });
      audit('postOrder', { requested: redact(req), response: safeError(e), outcome: 'error', latencyMs: now() - t0, idempotencyKey, postAttempted });
      return { ok: false, sent: postAttempted, ambiguous: postAttempted, error: safeError(e), idempotencyKey };
    }
  }

  // ── WRITE: cancel one resting order (idempotent) ──────────────────────────────
  async function cancelOrder(orderId) {
    if (!orderId) return { ok: false, error: 'orderId required' };
    if (!canWrite) return shadowOk('cancelOrder', { orderId }, { wouldCancel: true });
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.cancelOrder({ orderID: orderId }));
      audit('cancelOrder', { requested: { orderId }, response: redact(res), outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, sent: true, orderId, response: redact(res) };
    } catch (e) {
      const msg = safeError(e);
      if (isAlreadyGone(msg)) { audit('cancelOrder', { requested: { orderId }, response: msg, outcome: 'noop', latencyMs: now() - t0 }); return { ok: true, sent: false, noop: true, orderId }; }
      audit('cancelOrder', { requested: { orderId }, response: msg, outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: msg, orderId };
    }
  }

  // ── WRITE: cancel all the user's resting orders on a market (panic / stand-down) ─
  async function cancelMarketOrders(marketId) {
    if (!marketId) return { ok: false, error: 'marketId required' };
    if (!canWrite) return shadowOk('cancelMarketOrders', { marketId }, { wouldCancel: true });
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.cancelMarketOrders({ market: marketId }));
      audit('cancelMarketOrders', { requested: { marketId }, response: redact(res), outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, sent: true, marketId, response: redact(res) };
    } catch (e) {
      const msg = safeError(e);
      if (isAlreadyGone(msg)) { audit('cancelMarketOrders', { requested: { marketId }, response: msg, outcome: 'noop', latencyMs: now() - t0 }); return { ok: true, sent: false, noop: true, marketId }; }
      audit('cancelMarketOrders', { requested: { marketId }, response: msg, outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: msg, marketId };
    }
  }

  // ── READ: list the user's open orders on a market ─────────────────────────────
  // A READ needs L2 auth (creds), never the signing key. In off/paper we still avoid the network to keep
  // the "no venue write AND no key load" belt total; a read returns an empty, clearly-shadow result.
  async function listOpenOrders(marketId) {
    if (!canWrite) { audit('listOpenOrders', { requested: { marketId }, response: `${execMode}: no network read`, outcome: 'shadow', latencyMs: 0 }); return { ok: true, simulated: true, mode: execMode, orders: [] }; }
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.getOpenOrders(marketId ? { market: marketId } : undefined));
      const orders = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
      audit('listOpenOrders', { requested: { marketId }, response: { count: orders.length }, outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, count: orders.length, orders };
    } catch (e) {
      audit('listOpenOrders', { requested: { marketId }, response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: safeError(e) };
    }
  }

  // ── READ: filled inventory from the PUBLIC data-api (keyed by address; no key, read-only) ──
  async function getPositions(marketId) {
    if (!canWrite) { audit('getPositions', { requested: { marketId }, response: `${execMode}: no network read`, outcome: 'shadow', latencyMs: 0 }); return { ok: true, simulated: true, mode: execMode, positions: [] }; }
    const t0 = now();
    try {
      const { address } = await opts.credsProvider();
      const { httpGet } = require('../../httpGet');
      // Inventory belongs to the FUNDER, not the signer. On a proxy account the data-api answers a query
      // for the signer address with [] — silently indistinguishable from "flat", which is how a maker
      // ends up quoting against inventory it cannot see.
      const user = venueAccountAddress(funder, address);
      const url = `${DATA_API}/positions?user=${user}${marketId ? `&market=${marketId}` : ''}`;
      const r = await withRetry(() => httpGet(url, { timeoutMs: 6_000, headers: { Accept: 'application/json' } }));
      const positions = r && r.status === 200 && Array.isArray(r.data) ? r.data : [];
      audit('getPositions', { requested: { marketId }, response: { count: positions.length }, outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, count: positions.length, positions };
    } catch (e) {
      audit('getPositions', { requested: { marketId }, response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: safeError(e) };
    }
  }

  // ── READ: authenticate (L2) + a getOpenOrders read. Proves the maker path can reach the venue. ──
  async function healthCheck() {
    if (!canWrite) { audit('healthCheck', { response: `${execMode}: no network`, outcome: 'shadow', latencyMs: 0 }); return { ok: true, simulated: true, mode: execMode, authenticated: false }; }
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.getOpenOrders(undefined));
      const orders = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
      const { address } = await opts.credsProvider();
      audit('healthCheck', { response: { openOrders: orders.length }, outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, authenticated: true, address, funderAddress: funder.funderAddress || null, signatureType: funder.signatureType, openOrders: orders.length };
    } catch (e) {
      audit('healthCheck', { response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: safeError(e) };
    }
  }

  // Drop the signing key reference (GC-eligible) on stand-down/disarm. Best-effort scrub.
  function close() {
    if (_signerHandle && typeof _signerHandle.scrub === 'function') { try { _signerHandle.scrub(); } catch { /* ignore */ } }
    _signerHandle = null;
    audit('close', { response: 'signer scrubbed', outcome: 'ok', latencyMs: 0 });
    return { ok: true, scrubbed: true };
  }

  return { kind: 'maker', mode, dryRun, canWrite, placement, liveMinCapUsd, liveMinMarket, orderTtlSeconds,
    signatureType: funder.signatureType, funderAddress: funder.funderAddress || null,
    postOrder, cancelOrder, cancelMarketOrders, listOpenOrders, getPositions, healthCheck, close };
}

module.exports = { createMakerAdapter, ALLOWED_OPS, LIVE_MODES, LIVE_MIN_DEFAULT_CAP_USD, evaluatePlacementGate, evaluateLiveMinMarketGate, evaluateOrderVersionGate, SUPPORTED_ORDER_VERSION, v2SdkStatus, resolveFunder, _internal: { isTransient, isAlreadyGone, priceOnTick } };
