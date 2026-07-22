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

const HOST = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// The ONLY callable operations. The selfcheck asserts the surface against this list.
const ALLOWED_OPS = Object.freeze(['postOrder', 'cancelOrder', 'cancelMarketOrders', 'listOpenOrders', 'getPositions', 'healthCheck', 'close']);
// Modes in which a mutating call may actually reach the venue. off/paper never do.
const LIVE_MODES = Object.freeze(['live-min', 'live']);
const LIVE_MIN_DEFAULT_CAP_USD = 25;

// CLOB v2 capability. Polymarket migrated to CLOB v2 on 2026-04-28: new Exchange contracts
// (CTFExchangeV2 0xE1111800…, NegRiskCtfExchangeV2 0xe2222d27…), EIP-712 domain version "1"→"2",
// pUSD collateral, and an Order struct with NO feeRateBps. Our pinned @polymarket/clob-client@5.8.1 is
// the V1 client: it signs the DEPRECATED v1 exchange (0x4bFb41…) as the verifyingContract, which v2
// production REJECTS. v2 support lives in the SEPARATE package @polymarket/clob-client-v2 (≥1.0.0).
// Until that migration is done, a live placement would sign an order the venue throws away — so the
// maker FAILS CLOSED on the placement path. Cancel/list/health are L2 (no exchange contract in signing)
// and are unaffected.
function v2SdkPresent() {
  try { require.resolve('@polymarket/clob-client-v2'); return true; } catch { return false; }
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
 *   liveMinCapUsd  number — hard per-order notional cap in live-min (default 25).
 *   now / maxRetries — clock + retry injection (tests).
 */
function createMakerAdapter(opts = {}) {
  const mode = LIVE_MODES.includes(opts.mode) || opts.mode === 'paper' ? opts.mode : 'off';
  const dryRun = opts.dryRun === true;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const liveMinCapUsd = Number.isFinite(opts.liveMinCapUsd) ? opts.liveMinCapUsd : LIVE_MIN_DEFAULT_CAP_USD;
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
    const { ClobClient } = await import('@polymarket/clob-client'); // ESM, lazy — never at module load
    return new ClobClient(HOST, CHAIN_ID, _signerHandle.signer, creds);
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
    const req = { tokenId: s.tokenId, side: s.side, price: s.price, size: s.size, tickSize: s.tickSize, postOnly: s.postOnly !== false, negRisk: s.negRisk };

    // Defensive validation — INDEPENDENT of the engine's own checks (defense in depth). Never posts an
    // unsnapped price or a sub-tick order, and honours the live-min hard cap.
    if (!s.tokenId || (s.side !== 'BUY' && s.side !== 'SELL')) { audit('postOrder', { requested: redact(req), response: 'reject: tokenId+side required', outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: 'tokenId and side (BUY|SELL) required' }; }
    if (!(s.price > 0) || !(s.size > 0)) { audit('postOrder', { requested: redact(req), response: 'reject: price/size must be > 0', outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: 'price and size must be > 0' }; }
    if (s.tickSize != null && !priceOnTick(s.price, s.tickSize)) { audit('postOrder', { requested: redact(req), response: `reject: price ${s.price} not on tick ${s.tickSize}`, outcome: 'reject', latencyMs: 0 }); return { ok: false, sent: false, reason: `price ${s.price} is not a valid multiple of tick ${s.tickSize} (or out of [tick,1-tick])` }; }
    const notionalUsd = s.price * s.size;
    if (mode === 'live-min' && notionalUsd > liveMinCapUsd + 1e-9) { audit('postOrder', { requested: redact(req), response: `reject: notional $${notionalUsd.toFixed(2)} > live-min cap $${liveMinCapUsd}`, outcome: 'reject-cap', latencyMs: 0 }); return { ok: false, sent: false, reason: `live-min hard cap: order notional $${notionalUsd.toFixed(2)} exceeds $${liveMinCapUsd}` }; }

    if (!canWrite) return shadowOk('postOrder', req, { notionalUsd: +notionalUsd.toFixed(4), wouldPost: true });

    // FAIL CLOSED on CLOB v2: refuse to sign a v1 order the v2 venue would reject (no network, no key).
    if (!v2SdkPresent()) {
      audit('postOrder', { requested: redact(req), response: 'reject: v1 SDK — CLOB v2 rejects v1-signed orders', outcome: 'reject-v1-sdk', latencyMs: 0 });
      return { ok: false, sent: false, reason: 'CLOB v2: order signing is pinned to the v1 SDK (@polymarket/clob-client@5.8.1), which signs the deprecated v1 exchange (0x4bFb41…). Polymarket v2 (live 2026-04-28) rejects v1 orders. Migrate to @polymarket/clob-client-v2 (≥1.0.0) + pUSD collateral + v2 contracts before live placement.' };
    }

    try {
      const client = await liveClient();
      // FEE: do NOT hardcode feeRateBps. Under CLOB v2 fees are TAKER-ONLY and PROTOCOL-DETERMINED
      // per-market; the client resolves the authoritative base_fee from GET /fee-rate and signs the
      // order with THAT value. Passing feeRateBps:0 makes _resolveFeeRateBps THROW on any market whose
      // base_fee > 0 ("fee rate for the market must be N"); omitting it lets the server value stand
      // (a maker's resolved fee is 0 under taker-only, but we never assume it).
      const userOrder = { tokenID: String(s.tokenId), price: s.price, size: s.size, side: s.side };
      const options = { tickSize: s.tickSize != null ? String(s.tickSize) : undefined, negRisk: s.negRisk };
      // createAndPostOrder(userOrder, options, orderType='GTC', deferExec=false, postOnly) — post-only true.
      const res = await withRetry(() => client.createAndPostOrder(userOrder, options, 'GTC', false, s.postOnly !== false));
      const orderId = res && (res.orderID || res.orderId || (res.order && res.order.id)) || null;
      audit('postOrder', { requested: redact(req), response: redact({ success: res && res.success, orderId, status: res && res.status }), outcome: 'ok', latencyMs: now() - t0, notionalUsd: +notionalUsd.toFixed(4) });
      return { ok: !!(res && res.success !== false), sent: true, orderId, notionalUsd: +notionalUsd.toFixed(4), response: redact(res) };
    } catch (e) {
      audit('postOrder', { requested: redact(req), response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, sent: true, error: safeError(e) };
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
      const url = `${DATA_API}/positions?user=${address}${marketId ? `&market=${marketId}` : ''}`;
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
      return { ok: true, authenticated: true, address, openOrders: orders.length };
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

  return { kind: 'maker', mode, dryRun, canWrite, liveMinCapUsd, postOrder, cancelOrder, cancelMarketOrders, listOpenOrders, getPositions, healthCheck, close };
}

module.exports = { createMakerAdapter, ALLOWED_OPS, LIVE_MODES, LIVE_MIN_DEFAULT_CAP_USD, _internal: { isTransient, isAlreadyGone, priceOnTick } };
