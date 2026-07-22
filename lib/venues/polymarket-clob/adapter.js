'use strict';
// lib/venues/polymarket-clob/adapter.js — the CANCEL-ONLY Polymarket CLOB adapter.
//
// SCOPE — this adapter can do exactly four things, all non-fund-moving:
//   listOpenOrders(marketId)      READ  — the user's resting orders (used by the verify command)
//   cancelOrder(orderId)          WRITE — cancel one resting order (removes a quote; opens nothing)
//   cancelMarketOrders(marketId)  WRITE — cancel all the user's resting orders on a market
//   healthCheck()                 READ  — authenticate + a getOpenOrders read; proves the L2 creds work
// and it exposes the ShadowCancelAdapter drop-in shape (cancelResting / exitFilledLeg) so it can be
// selected by the news-guard action layer without changing call sites.
//
// It DELIBERATELY has NO method that can open exposure or move funds: no placeOrder, no closePosition,
// no transfer, no withdraw, no approve, no redeem. Closing a FILLED leg needs a marketable (taker)
// order = order placement, which this adapter does not have — exitFilledLeg() therefore returns an
// ALERT-ONLY result (notify a human to close), never an order. See the README/report for that call.
//
// FOUR/FIVE SAFETY BELTS layered here, independent:
//   1. It runs with an ADDRESS-ONLY signer (signer.js) that cannot sign L1 → cannot place/derive.
//   2. dryRun (PM_ADAPTER_DRYRUN=true): every method short-circuits to a synthetic success and makes
//      ZERO network calls and does NOT even load credentials. A second belt independent of arming.
//   3. It is only ever CONSTRUCTED/selected by resolveCancelAdapter when armed && liveVerified.
//   4. Credentials arrive via an injected credsProvider; in the disarmed build the wired provider
//      throws, so even a live (non-dry-run) call cannot obtain creds. Arming wires the real provider.
//   5. clob-client (ESM) is imported lazily, only inside a live mutating/read path — never at load.
//
// Every call, in every mode, writes ONE redacted audit line (audit.js). No credential can reach a log.

const { addressOnlySigner } = require('./signer');
const { appendAudit } = require('./audit');
const { redact, safeError, registerSecretValues } = require('./redact');

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// The ONLY method names this adapter exposes as callable operations. The selfcheck asserts the surface
// against this list so no fund-moving method can ever creep in unnoticed.
const ALLOWED_OPS = Object.freeze(['listOpenOrders', 'cancelOrder', 'cancelMarketOrders', 'healthCheck', 'cancelResting', 'exitFilledLeg']);

// Retry only these — transient. A 4xx (except the idempotent already-gone cases handled below) is a
// rejected instruction and must NEVER be retried blindly.
function isTransient(status) { return status === 429 || (status >= 500 && status <= 599); }

// The CLOB reports an already-cancelled / already-filled / unknown order as a 4xx we must treat as a
// NO-OP success (idempotency), not an error. Conservative substring match on the safe (redacted) text.
function isAlreadyGone(msg) {
  return /not found|already (cancel|fill)|no such order|does not exist|invalid order id/i.test(String(msg || ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the cancel-only adapter.
 * @param {object} opts
 *   credsProvider  async () => { creds:{key,secret,passphrase}, address }  — REQUIRED. Called lazily on
 *                  a live (non-dry-run) call only. In the disarmed build the wired provider throws.
 *   dryRun         boolean — when true, every method is a logged no-op returning synthetic success.
 *   now            () => number — clock injection (tests/replay). Defaults to Date.now.
 *   maxRetries     number — transient-error retries (default 3).
 */
function createCancelOnlyAdapter(opts = {}) {
  const dryRun = opts.dryRun === true;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const credsProvider = opts.credsProvider;
  if (!dryRun && typeof credsProvider !== 'function') {
    throw new Error('createCancelOnlyAdapter: a credsProvider is required for a live (non-dry-run) adapter');
  }

  const mode = dryRun ? 'dryrun' : 'live';

  // Audit one call. `response`/`requested` are redacted before write; never pass raw creds in.
  function audit(op, fields) {
    appendAudit({ ts: now(), venue: 'polymarket', op, mode, ...fields });
  }

  // Synthetic success for a mutating call in dry-run: no network, no creds, logged.
  function dryOk(op, fields) {
    const rec = { ok: true, dryRun: true, sent: false, simulated: true, op, ...fields };
    audit(op, { requested: redact(fields), response: 'dry-run: no network call', outcome: 'dryrun', latencyMs: 0 });
    return rec;
  }

  // Lazily construct a live client from the injected creds + an address-only signer.
  async function liveClient() {
    const { creds, address } = await credsProvider();
    if (!creds || !creds.key || !creds.secret || !creds.passphrase || !address) {
      throw new Error('credsProvider returned incomplete credentials');
    }
    // Register the secret VALUES so redact() blanks them out of any later error text.
    registerSecretValues([creds.key, creds.secret, creds.passphrase]);
    const { ClobClient } = await import('@polymarket/clob-client'); // ESM, lazy — never at module load
    const signer = addressOnlySigner(address); // cannot sign → cannot place/derive
    return new ClobClient(HOST, CHAIN_ID, signer, creds);
  }

  // Run a live call with transient-only backoff. Non-transient 4xx propagate (caller decides no-op vs
  // error). Never retries a rejected instruction.
  async function withRetry(fn) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (e) {
        const status = e && (e.status || (e.response && e.response.status));
        if (isTransient(status) && attempt < maxRetries) {
          attempt++;
          await sleep(250 * 2 ** (attempt - 1)); // 250ms, 500ms, 1s
          continue;
        }
        throw e;
      }
    }
  }

  // ── READ: list the user's open orders on a market ─────────────────────────────
  async function listOpenOrders(marketId) {
    if (dryRun) { audit('listOpenOrders', { requested: { marketId }, response: 'dry-run', outcome: 'dryrun', latencyMs: 0 }); return { ok: true, dryRun: true, orders: [] }; }
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.getOpenOrders(marketId ? { market: marketId } : undefined));
      const orders = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
      // Audit only the COUNT + ids, never full order bodies (which are non-secret but noisy).
      audit('listOpenOrders', { requested: { marketId }, response: { count: orders.length }, outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, count: orders.length, orders };
    } catch (e) {
      audit('listOpenOrders', { requested: { marketId }, response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: safeError(e) };
    }
  }

  // ── WRITE: cancel one resting order (idempotent) ──────────────────────────────
  async function cancelOrder(orderId) {
    if (!orderId) return { ok: false, error: 'orderId required' };
    if (dryRun) return dryOk('cancelOrder', { orderId });
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.cancelOrder({ orderID: orderId }));
      audit('cancelOrder', { requested: { orderId }, response: redact(res), outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, sent: true, orderId, response: redact(res) };
    } catch (e) {
      const msg = safeError(e);
      if (isAlreadyGone(msg)) { // already cancelled/filled → no-op success, not an error
        audit('cancelOrder', { requested: { orderId }, response: msg, outcome: 'noop', latencyMs: now() - t0 });
        return { ok: true, sent: false, noop: true, orderId, reason: 'already cancelled or filled' };
      }
      audit('cancelOrder', { requested: { orderId }, response: msg, outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: msg, orderId };
    }
  }

  // ── WRITE: cancel all the user's resting orders on a market (idempotent) ───────
  async function cancelMarketOrders(marketId) {
    if (!marketId) return { ok: false, error: 'marketId required' };
    if (dryRun) return dryOk('cancelMarketOrders', { marketId });
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.cancelMarketOrders({ market: marketId }));
      audit('cancelMarketOrders', { requested: { marketId }, response: redact(res), outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, sent: true, marketId, response: redact(res) };
    } catch (e) {
      const msg = safeError(e);
      if (isAlreadyGone(msg)) {
        audit('cancelMarketOrders', { requested: { marketId }, response: msg, outcome: 'noop', latencyMs: now() - t0 });
        return { ok: true, sent: false, noop: true, marketId, reason: 'no resting orders' };
      }
      audit('cancelMarketOrders', { requested: { marketId }, response: msg, outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: msg, marketId };
    }
  }

  // ── READ: prove the L2 creds authenticate (used by the verify command) ────────
  async function healthCheck() {
    if (dryRun) { audit('healthCheck', { response: 'dry-run', outcome: 'dryrun', latencyMs: 0 }); return { ok: true, dryRun: true, authenticated: false }; }
    const t0 = now();
    try {
      const client = await liveClient();
      const res = await withRetry(() => client.getOpenOrders(undefined));
      const orders = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);
      const { address } = await credsProvider();
      audit('healthCheck', { response: { openOrders: orders.length }, outcome: 'ok', latencyMs: now() - t0 });
      return { ok: true, authenticated: true, address, openOrders: orders.length };
    } catch (e) {
      audit('healthCheck', { response: safeError(e), outcome: 'error', latencyMs: now() - t0 });
      return { ok: false, error: safeError(e) };
    }
  }

  // ── Drop-in shape for the news-guard action layer ─────────────────────────────
  // cancelResting(plan): cancel the user's resting reward quotes on the plan's market. We cancel by
  // MARKET (cancelMarketOrders) rather than by leg, because the action-layer plan carries sides, not
  // exchange order ids — cancelling the market's resting orders is the correct, idempotent superset.
  async function cancelResting(plan) {
    const marketId = plan && plan.marketId;
    const r = await cancelMarketOrders(marketId);
    return { ...r, venue: 'polymarket', wouldCancel: (plan && plan.orders) || [] };
  }

  // exitFilledLeg(leg): closing a filled leg requires a marketable order — order PLACEMENT — which this
  // cancel-only adapter deliberately lacks. So this NEVER sends an order; it returns an alert-only
  // result telling the caller a human must close the leg. Honest and fund-safe by construction.
  async function exitFilledLeg(leg) {
    audit('exitFilledLeg', { requested: redact(leg || {}), response: 'alert-only: cancel-only adapter cannot place a closing order', outcome: 'alert-only', latencyMs: 0 });
    return { ok: true, sent: false, alertOnly: true, reason: 'cancel-only adapter has no order-placement path; a filled leg must be closed by a human', leg: redact(leg || {}) };
  }

  return {
    kind: 'live',
    dryRun,
    listOpenOrders,
    cancelOrder,
    cancelMarketOrders,
    healthCheck,
    cancelResting,
    exitFilledLeg,
  };
}

module.exports = { createCancelOnlyAdapter, ALLOWED_OPS, _internal: { isTransient, isAlreadyGone } };
