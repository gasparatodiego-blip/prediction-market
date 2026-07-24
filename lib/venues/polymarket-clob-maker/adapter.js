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
//
// Every call, in every mode, writes ONE redacted audit line. No credential/key can reach a log.

const { appendMakerAudit } = require('./audit');
const { redact, safeError, registerSecretValues } = require('../polymarket-clob/redact');
const { signingSignerFromKey } = require('./signer');
const { resolveFunder, venueAccountAddress } = require('./funder');
const { computeGtdExpiration } = require('../../maker/order-ttl');
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
 *   now / maxRetries — clock + retry injection (tests).
 */
function createMakerAdapter(opts = {}) {
  const mode = LIVE_MODES.includes(opts.mode) || opts.mode === 'paper' ? opts.mode : 'off';
  const dryRun = opts.dryRun === true;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const liveMinCapUsd = Number.isFinite(opts.liveMinCapUsd) ? opts.liveMinCapUsd : LIVE_MIN_DEFAULT_CAP_USD;
  // Venue-native order TTL (seconds). Every order carries a signed GTD expiration this many seconds out,
  // so the venue kills it even if this whole host is gone. A per-order spec.ttlSeconds overrides it.
  const orderTtlSeconds = Number.isFinite(opts.orderTtlSeconds) ? opts.orderTtlSeconds : 60;
  // Execution-safety layer + the user this adapter posts on behalf of (single-operator today).
  const safety = opts.safety || DEFAULT_SAFETY;
  const operatorUser = opts.operatorUser || DEFAULT_OPERATOR_USER;
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

  function audit(op, fields) { appendMakerAudit({ ts: now(), venue: 'polymarket', op, mode: execMode, ...fields }); }

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
  // spec: { tokenId, side:'BUY'|'SELL', price, size, tickSize, postOnly=true, negRisk }
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

    // ── INTENT BEFORE SEND — idempotency + evidence. No durable intent ⇒ NO order (fail closed). ──
    const idempotencyKey = s.idempotencyKey || safety.deriveIdempotencyKey({ userId, venue: VENUE, tokenId: s.tokenId, side: s.side, price: s.price, size: s.size });
    let intentRes;
    try {
      intentRes = safety.recordIntent({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, side: s.side, price: s.price, size: s.size, notionalUsd: +notionalUsd.toFixed(4), decision: redact(s.decision || null), gates: gatesEvaluated, mode: execMode });
    } catch (e) {
      audit('postOrder', { requested: redact(req), response: 'reject: could not durably record intent', outcome: 'reject-audit-intent', latencyMs: 0 });
      return { ok: false, sent: false, gate: 'audit-intent', reason: 'could not durably record the intent before send — refusing to place (no evidence, no order)' };
    }
    if (intentRes.duplicate === true) {
      audit('postOrder', { requested: redact(req), response: 'reject: duplicate idempotency key', outcome: 'reject-idempotent', latencyMs: 0, idempotencyKey });
      return { ok: false, sent: false, gate: 'idempotent-duplicate', reason: `an order for idempotency key ${idempotencyKey} was already attempted — refusing to place it twice` };
    }

    try {
      const client = await liveClient();
      // FEE: do NOT hardcode feeRateBps. Under CLOB v2 fees are TAKER-ONLY and PROTOCOL-DETERMINED
      // per-market; the client resolves the authoritative base_fee from GET /fee-rate and signs the
      // order with THAT value. Passing feeRateBps:0 makes _resolveFeeRateBps THROW on any market whose
      // base_fee > 0 ("fee rate for the market must be N"); omitting it lets the server value stand
      // (a maker's resolved fee is 0 under taker-only, but we never assume it).
      // `expiration` is a SIGNED field in the v2 order struct (UserOrderV2.expiration → NewOrderV2.expiration,
      // unix seconds) — setting it changes the order signature, which is exactly the point: the venue can
      // only honour an expiry it signed. GTD (not GTC) is required for a non-zero expiration to take effect.
      const userOrder = { tokenID: String(s.tokenId), price: s.price, size: s.size, side: s.side, expiration: ttl.expiration };
      const options = { tickSize: s.tickSize != null ? String(s.tickSize) : undefined, negRisk: s.negRisk };
      // v2 signature: createAndPostOrder(userOrder, options, orderType, postOnly=false, deferExec=false).
      // NOTE the v1→v2 arg SWAP: postOnly is now the 4th arg, deferExec the 5th (v1 had them reversed).
      const res = await withRetry(() => client.createAndPostOrder(userOrder, options, ttl.orderType, s.postOnly !== false, false));
      const orderId = res && (res.orderID || res.orderId || (res.order && res.order.id)) || null;
      safety.recordOutcome({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, ok: !!(res && res.success !== false), orderId, response: redact({ success: res && res.success, status: res && res.status }) });
      audit('postOrder', { requested: redact(req), response: redact({ success: res && res.success, orderId, status: res && res.status }), outcome: 'ok', latencyMs: now() - t0, notionalUsd: +notionalUsd.toFixed(4), idempotencyKey });
      return { ok: !!(res && res.success !== false), sent: true, orderId, notionalUsd: +notionalUsd.toFixed(4), idempotencyKey, response: redact(res) };
    } catch (e) {
      // The venue call (or key decryption) threw AFTER the intent was recorded — the INTENT row persists
      // as evidence that something was attempted; write an outcome-error row referencing its key.
      safety.recordOutcome({ idempotencyKey, userId, venue: VENUE, market: s.tokenId ? String(s.tokenId) : null, ok: false, error: safeError(e) });
      audit('postOrder', { requested: redact(req), response: safeError(e), outcome: 'error', latencyMs: now() - t0, idempotencyKey });
      return { ok: false, sent: true, error: safeError(e), idempotencyKey };
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

  return { kind: 'maker', mode, dryRun, canWrite, liveMinCapUsd, orderTtlSeconds,
    signatureType: funder.signatureType, funderAddress: funder.funderAddress || null,
    postOrder, cancelOrder, cancelMarketOrders, listOpenOrders, getPositions, healthCheck, close };
}

module.exports = { createMakerAdapter, ALLOWED_OPS, LIVE_MODES, LIVE_MIN_DEFAULT_CAP_USD, evaluatePlacementGate, v2SdkStatus, resolveFunder, _internal: { isTransient, isAlreadyGone, priceOnTick } };
