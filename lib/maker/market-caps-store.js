'use strict';
// lib/maker/market-caps-store.js — the DURABLE per-market collateral ceiling the operator sets on the
// market screen. One JSON file under data/ (survives a pm2 restart, settable from a shell without a
// deploy), read by agent35 EVERY cycle and written by the gated /api/maker/market-cap route. There is
// exactly ONE read/write implementation, for the same reason lib/maker/selection.js has one: a second
// would reintroduce a file-vs-UI divergence on a number that bounds real money.
//
// FAIL CLOSED, and the store's three states are kept distinct because they mean different things:
//   • no entry for this market   → { capUsd: null, source: 'unset' }  — the caller decides the fallback
//                                   (agent35 falls back to the env rail cap, never to "unlimited").
//   • entry present               → { capUsd: <number>, source: 'per-market' }
//   • file present but UNREADABLE  → { capUsd: 0, source: 'unreadable' } — admit NOTHING. "We could not
//                                   read your ceiling" is not "your ceiling is fine".
//
// The ceiling is a HARD limit on committed collateral for one market, including everything a fill rule
// re-quotes onto the opposite side. That is its whole purpose: to bound inventory accumulation, which
// the global arming cap alone cannot do once 'opposite' can fire repeatedly.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CAPS_FILE = path.join(DATA_DIR, 'maker-market-caps.json');
const EMPTY = Object.freeze({ caps: {} });
// A ceiling above this is almost certainly a typo, not an intent. Refuse rather than persist it.
const MAX_CAP_USD = 100_000;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Raw read of the whole store. { ok, caps, error } — ok:false means UNREADABLE (fail closed). */
function readCaps(deps = {}) {
  const file = deps.capsFile || CAPS_FILE;
  const r = readStore(file, EMPTY, deps);
  if (!r.ok) return { ok: false, caps: {}, error: r.error };
  const caps = (r.value && typeof r.value.caps === 'object' && r.value.caps) ? r.value.caps : {};
  return { ok: true, caps, existed: !!r.existed };
}

/**
 * The ceiling for ONE market.
 * @param {string} marketId
 * @param {object} opts  fallbackUsd — used only when NO entry exists (source 'fallback'). deps for tests.
 * @returns {{capUsd:(number|null), source:'per-market'|'fallback'|'unset'|'unreadable', updatedAt, updatedBy, error}}
 */
function getMarketCap(marketId, opts = {}) {
  const r = readCaps(opts);
  if (!r.ok) return { capUsd: 0, source: 'unreadable', updatedAt: null, updatedBy: null, error: r.error };
  const row = r.caps[String(marketId)];
  if (row && fin(Number(row.capUsd)) && Number(row.capUsd) >= 0) {
    return { capUsd: Number(row.capUsd), source: 'per-market', updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ?? null, error: null };
  }
  const fb = opts.fallbackUsd;
  if (fin(fb) && fb >= 0) return { capUsd: fb, source: 'fallback', updatedAt: null, updatedBy: null, error: null };
  return { capUsd: null, source: 'unset', updatedAt: null, updatedBy: null, error: null };
}

/**
 * Persist a market's ceiling. Refuses a non-finite / negative / absurd value rather than storing it.
 * A cap of exactly 0 is LEGAL and meaningful: "quote nothing on this market".
 */
function setMarketCap(marketId, capUsd, updatedBy, deps = {}) {
  const id = String(marketId || '').trim();
  if (!id) return { ok: false, error: 'marketId required' };
  const n = Number(capUsd);
  if (!fin(n) || n < 0) return { ok: false, error: 'capUsd must be a finite number ≥ 0' };
  if (n > MAX_CAP_USD) return { ok: false, error: `capUsd above the ${MAX_CAP_USD} sanity ceiling — refusing (likely a typo)` };

  const file = deps.capsFile || CAPS_FILE;
  const r = readStore(file, EMPTY, deps);
  // Never overwrite a store we could not read — that would silently drop every OTHER market's ceiling.
  if (!r.ok) return { ok: false, error: `caps store unreadable (${r.error}) — refusing to overwrite` };
  const caps = (r.value && typeof r.value.caps === 'object' && r.value.caps) ? { ...r.value.caps } : {};
  const now = (deps.now ? deps.now() : Date.now());
  caps[id] = { capUsd: n, updatedAt: new Date(now).toISOString(), updatedBy: String(updatedBy || 'operator') };
  writeStoreAtomic(file, { caps }, deps);
  return { ok: true, marketId: id, capUsd: n, updatedAt: caps[id].updatedAt, updatedBy: caps[id].updatedBy };
}

/** Remove a market's ceiling (back to the caller's fallback). Idempotent. */
function clearMarketCap(marketId, deps = {}) {
  const file = deps.capsFile || CAPS_FILE;
  const r = readStore(file, EMPTY, deps);
  if (!r.ok) return { ok: false, error: `caps store unreadable (${r.error}) — refusing to overwrite` };
  const caps = (r.value && typeof r.value.caps === 'object' && r.value.caps) ? { ...r.value.caps } : {};
  delete caps[String(marketId)];
  writeStoreAtomic(file, { caps }, deps);
  return { ok: true, cleared: true };
}

module.exports = { getMarketCap, setMarketCap, clearMarketCap, readCaps, CAPS_FILE, MAX_CAP_USD };
