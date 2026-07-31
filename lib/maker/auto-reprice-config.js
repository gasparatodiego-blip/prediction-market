'use strict';
// lib/maker/auto-reprice-config.js — the ON/OFF control for AUTOMATIC BAND-EXIT RE-PRICING, plus the
// watcher's own runtime state. Durable, audited, per-market AND global.
//
// WHAT THIS SWITCHES. With it OFF (the default, everywhere) a hand order behaves exactly as it always
// has: a fixed GTD expiry (~180s) kills it on a clock regardless of price. With it ON for a market, a
// hand order on that market rests as GTC — no venue-side expiry at all — and agent40-manual-reprice
// becomes the thing that decides when it moves: it re-prices ONLY when the mid has travelled far enough
// to push the order out of the reward band, and NEVER because time passed.
//
// WHY IT IS TWO SWITCHES, NOT ONE. `global` is a master kill for the whole automatism (one flip stops
// every market at once, without having to remember which markets were opted in). `markets[id]` is the
// per-market opt-in. BOTH must be true for the watcher to touch anything — an automatism that could be
// switched on for a market while the master is off would be exactly the invisible behaviour this file
// exists to prevent.
//
// DEFAULT OFF, AND FAIL CLOSED. An absent file means "nothing is automatic" (the normal state of a fresh
// install). An UNREADABLE file also means "nothing is automatic" — for an automatism, fail-closed is the
// direction that does nothing, which is the opposite of the manual-mode flag's fail-closed (there,
// refusing to place is the safe direction; here, refusing to ACT is). A control we cannot read never
// grants authority to move a real order.
//
// SHAPE, and why a file under data/ rather than an env var — identical reasoning to lib/maker/manual-mode:
//   • DURABLE — a pm2 restart must not silently re-arm (or silently disarm) an automatism while GTC
//     orders with no venue expiry are resting.
//   • READ LIVE at the decision point — the watcher re-reads it every cycle, so a flip binds in seconds
//     without a restart. A control that needs a deploy is not a control.
//   • AUDITED — every flip appends a who/when/why line to data/maker-auto-reprice-audit.jsonl.
//
// TWO FILES, TWO OWNERS. The CONFIG (this file's `markets`/`global`) is the OPERATOR's, written only by
// the panel. The STATE (last automatic re-price, counts, heartbeat) is the WATCHER's, written only by
// agent40. Keeping them apart means the watcher can never accidentally rewrite a switch the operator set,
// and a corrupt state file can never be mistaken for a config that turns something on.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CONFIG_FILE = path.join(DATA_DIR, 'maker-auto-reprice.json');
const STATE_FILE = path.join(DATA_DIR, 'maker-auto-reprice-state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-auto-reprice-audit.jsonl');

const EMPTY_CONFIG = Object.freeze({ global: { enabled: false }, markets: {} });
const EMPTY_STATE = Object.freeze({ markets: {}, heartbeatAt: null, cycles: 0 });

// The audit `source` this automatism stamps on everything it does. DELIBERATELY distinct from both
// 'manual-ui' (a human pressed a button) and 'agent35' (the automatic engine), so the one append-only
// trail always answers "what moved this order" without inference.
const AUTO_REPRICE_SOURCE = 'auto-reprice-band-exit';

// ── THE WATCHER'S TUNING, all overridable by env, all defaulting conservative ────────────────────────
// These are the rails on the automatism itself, not on the order: how sure it must be that the band was
// really breached, how often it may act, and how stale a mid it will refuse to act on.
const DEFAULTS = Object.freeze({
  // How often the watcher looks. agent34 republishes the live books every 3s, so looking faster than
  // that only re-reads the same snapshot; 5s is "coherent with the venue sampling cadence".
  pollMs: 5_000,
  // A breach must be seen this many CONSECUTIVE cycles before acting. One noisy sample is not a signal.
  confirmSamples: 2,
  // Extra distance beyond the band edge, in TICKS, before a breach counts. Stops an order sitting exactly
  // on the boundary from flapping in and out on rounding alone.
  hysteresisTicks: 1,
  // Rate limit per ORDER: never re-price the same leg twice inside this window.
  minIntervalMs: 30_000,
  // Runaway guard per MARKET: at most this many automatic re-prices per rolling hour.
  maxPerHour: 20,
  // The mid must be THIS fresh, and must come from agent34's live book — never from the slower board
  // row. Re-pricing against a stale mid is how an automatism walks an order somewhere nobody asked for.
  maxMidAgeSec: 30,
  requireLiveBook: true,
  // WHERE the re-priced order lands. Both keep it inside the band; they differ in intent:
  //   'band-edge'   (default) — the nearest qualifying price to where the order ALREADY was, i.e. the
  //                 band edge on the same side of the mid. Minimum movement, preserves the operator's
  //                 original above/below-mid stance, and stays as far from the mid (and from being
  //                 filled) as the band allows.
  //   'nearest-mid' — the qualifying price closest to the mid. Scores the most reward (the published
  //                 quadratic rewards proximity to the mid) and carries the most fill risk.
  strategy: 'band-edge',
});

const STRATEGIES = Object.freeze(['band-edge', 'nearest-mid']);

function envNum(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }

/** Resolve the watcher's tuning from an env bag. Every field falls back to the conservative default. */
function loadAutoRepriceTuning(env = process.env) {
  const rawStrategy = typeof env.MAKER_AUTO_REPRICE_STRATEGY === 'string' ? env.MAKER_AUTO_REPRICE_STRATEGY.trim() : '';
  return {
    pollMs: envNum(env.MAKER_AUTO_REPRICE_POLL_MS, DEFAULTS.pollMs),
    confirmSamples: envNum(env.MAKER_AUTO_REPRICE_CONFIRM_SAMPLES, DEFAULTS.confirmSamples),
    hysteresisTicks: envNum(env.MAKER_AUTO_REPRICE_HYSTERESIS_TICKS, DEFAULTS.hysteresisTicks),
    minIntervalMs: envNum(env.MAKER_AUTO_REPRICE_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs),
    maxPerHour: envNum(env.MAKER_AUTO_REPRICE_MAX_PER_HOUR, DEFAULTS.maxPerHour),
    maxMidAgeSec: envNum(env.MAKER_AUTO_REPRICE_MAX_MID_AGE_SEC, DEFAULTS.maxMidAgeSec),
    // Only the exact string 'false' relaxes the live-book requirement, and it is a deliberate, visible act.
    requireLiveBook: env.MAKER_AUTO_REPRICE_REQUIRE_LIVE_BOOK !== 'false',
    strategy: STRATEGIES.includes(rawStrategy) ? rawStrategy : DEFAULTS.strategy,
  };
}

function cfgDeps(deps) {
  return {
    configFile: deps.configFile || CONFIG_FILE,
    stateFile: deps.autoStateFile || STATE_FILE,
    auditFile: deps.autoAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function normId(marketId) { return typeof marketId === 'string' ? marketId.trim().toLowerCase() : ''; }

/**
 * Read the whole switch map. Never throws.
 * @returns {{readable:boolean, error:(string|null), globalEnabled:boolean, markets:object,
 *            enabledMarketIds:string[], configFile:string, record:(object|null)}}
 */
function readAutoRepriceConfig(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.configFile, EMPTY_CONFIG, deps);
  if (!r.ok) {
    // Unreadable ⇒ the automatism is OFF. For a thing that MOVES ORDERS BY ITSELF, "we could not read
    // the switch" must mean "do nothing", never "carry on".
    return { readable: false, error: r.error, globalEnabled: false, markets: {}, enabledMarketIds: [], configFile: c.configFile, record: null };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY_CONFIG;
  const g = (st.global && typeof st.global === 'object') ? st.global : {};
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const globalEnabled = g.enabled === true;
  return {
    readable: true, error: null,
    globalEnabled,
    globalRecord: g.enabled === undefined ? null : g,
    markets,
    // Markets opted in AND covered by the master switch. When the master is off this is empty, which is
    // the honest answer to "what will the watcher touch right now".
    enabledMarketIds: globalEnabled ? Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true) : [],
    // What the operator has opted in, independent of the master — the panel shows both.
    optedInMarketIds: Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true),
    configFile: c.configFile,
  };
}

/**
 * THE DECISION POINT. May the watcher touch orders on THIS market right now?
 * Enabled ⇔ the state is readable AND the master switch is on AND this market is opted in.
 * @returns {{enabled:boolean, readable:boolean, globalEnabled:boolean, marketEnabled:boolean,
 *            error:(string|null), record:(object|null), reason:string}}
 */
function isAutoRepriceEnabled(marketId, deps = {}) {
  const st = readAutoRepriceConfig(deps);
  if (!st.readable) {
    return {
      enabled: false, readable: false, globalEnabled: false, marketEnabled: false, error: st.error, record: null,
      reason: `auto-reprice config ${st.error} — failing CLOSED (the automatism does NOTHING; a switch we cannot read never authorises moving a real order)`,
    };
  }
  const id = normId(marketId);
  if (!id) return { enabled: false, readable: true, globalEnabled: st.globalEnabled, marketEnabled: false, error: null, record: null, reason: 'no marketId supplied' };
  const rec = st.markets[id] || null;
  const marketEnabled = !!(rec && rec.enabled === true);
  const enabled = st.globalEnabled && marketEnabled;
  return {
    enabled, readable: true, globalEnabled: st.globalEnabled, marketEnabled, error: null, record: rec,
    reason: enabled
      ? `auto-reprice is ACTIVE on ${id}${rec.reason ? ` — ${rec.reason}` : ''}`
      : !st.globalEnabled
        ? `auto-reprice is off globally (master switch) — ${marketEnabled ? 'this market is opted in but the master switch overrides it' : 'and this market is not opted in either'}`
        : `auto-reprice is not enabled on ${id} — hand orders here keep the fixed ${180}s GTD expiry`,
  };
}

function appendAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort: an audit-write failure must never stop a switch from being flipped */ }
}

/**
 * Flip a switch. scope:'global' is the master; scope:'market' needs a marketId. Audited.
 *
 * Read-modify-write on a FRESH object (readStore may return the frozen EMPTY singleton). An unreadable
 * config REFUSES an ENABLE (we will not turn an automatism on over a state we cannot read) but PERMITS a
 * DISABLE — turning it off is the direction that can only reduce activity, and must always be available.
 *
 * @returns {{ok:boolean, error?:string, scope:string, marketId:(string|null), enabled:boolean, record?:object}}
 */
function setAutoReprice({ scope = 'market', marketId = null, enabled, by = null, reason = null }, deps = {}) {
  const c = cfgDeps(deps);
  if (scope !== 'global' && scope !== 'market') return { ok: false, error: "scope must be 'global' or 'market'", scope, marketId, enabled: false };
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean', scope, marketId, enabled: false };
  const id = scope === 'market' ? normId(marketId) : null;
  if (scope === 'market' && !id) return { ok: false, error: 'marketId required for scope:market', scope, marketId, enabled: false };

  const r = readStore(c.configFile, EMPTY_CONFIG, deps);
  if (!r.ok && enabled === true) {
    return {
      ok: false, scope, marketId: id, enabled: false,
      error: `auto-reprice config ${r.error} — refusing to ENABLE the automatism over a state we cannot read (fix the file first; DISABLING is still permitted)`,
    };
  }
  const base = (r.ok && r.value) ? r.value : {};
  const st = {
    global: (base.global && typeof base.global === 'object') ? { ...base.global } : { enabled: false },
    markets: { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) },
  };
  const at = c.now();
  const record = { enabled, at, atIso: new Date(at).toISOString(), by, reason };
  if (scope === 'global') st.global = record; else st.markets[id] = record;
  st.updatedAt = at;
  writeStoreAtomic(c.configFile, st, deps);
  appendAudit({ ts: at, event: enabled ? 'auto-reprice-on' : 'auto-reprice-off', scope, marketId: id, by, reason }, c);
  return { ok: true, scope, marketId: id, enabled, record };
}

// ── THE WATCHER'S OWN STATE (written ONLY by agent40, read by the panel) ─────────────────────────────
// It carries no authority: nothing here can enable anything. It answers "when did this last move, and is
// the thing that is supposed to be minding my GTC orders actually alive?"

/**
 * Read the watcher's runtime state. Unreadable ⇒ an EMPTY state flagged readable:false — the panel then
 * shows "unknown", which is a different fact from "never re-priced".
 */
function readAutoRepriceState(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.stateFile, EMPTY_STATE, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, heartbeatAt: null, heartbeatAgeSec: null, cycles: 0, stateFile: c.stateFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY_STATE;
  const heartbeatAt = Number.isFinite(st.heartbeatAt) ? st.heartbeatAt : null;
  return {
    readable: true, error: null,
    markets: (st.markets && typeof st.markets === 'object') ? st.markets : {},
    heartbeatAt,
    heartbeatAgeSec: heartbeatAt != null ? Math.max(0, Math.round((c.now() - heartbeatAt) / 1000)) : null,
    cycles: Number.isFinite(st.cycles) ? st.cycles : 0,
    lastCycleAt: Number.isFinite(st.lastCycleAt) ? st.lastCycleAt : null,
    stateFile: c.stateFile,
  };
}

/**
 * The watcher's heartbeat + per-market record of the last automatic re-price. Best-effort: a failed
 * state write must never stop the watcher, and must never be read as "it did not happen" — the
 * append-only maker audit trail is the real record of what moved.
 */
function recordAutoRepriceState({ marketId = null, reprice = null, heartbeat = true }, deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.stateFile, EMPTY_STATE, deps);
  const base = (r.ok && r.value && typeof r.value === 'object') ? r.value : {};
  const at = c.now();
  const markets = { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) };
  const id = normId(marketId);
  if (id && reprice) {
    const prev = markets[id] || {};
    // A rolling hour of timestamps — this is what the maxPerHour runaway guard counts.
    const recent = Array.isArray(prev.recentAt) ? prev.recentAt.filter((t) => Number.isFinite(t) && at - t < 3_600_000) : [];
    recent.push(at);
    markets[id] = {
      lastRepriceAt: at,
      lastRepriceIso: new Date(at).toISOString(),
      lastOrderId: reprice.orderId || null,
      lastFromPrice: Number.isFinite(reprice.fromPrice) ? reprice.fromPrice : null,
      lastToPrice: Number.isFinite(reprice.toPrice) ? reprice.toPrice : null,
      lastOk: reprice.ok === true,
      lastSent: reprice.sent === true,
      lastGate: reprice.gate || null,
      lastReason: reprice.reason || null,
      count: (Number.isFinite(prev.count) ? prev.count : 0) + 1,
      recentAt: recent,
    };
  }
  const st = {
    markets,
    heartbeatAt: heartbeat ? at : (Number.isFinite(base.heartbeatAt) ? base.heartbeatAt : null),
    lastCycleAt: heartbeat ? at : (Number.isFinite(base.lastCycleAt) ? base.lastCycleAt : null),
    cycles: (Number.isFinite(base.cycles) ? base.cycles : 0) + (heartbeat ? 1 : 0),
  };
  try { writeStoreAtomic(c.stateFile, st, deps); return { ok: true, at }; }
  catch (e) { return { ok: false, error: e.message, at }; }
}

/** How many automatic re-prices this market has had in the rolling last hour (the runaway guard's input). */
function repricesInLastHour(marketId, deps = {}, now = Date.now()) {
  const st = readAutoRepriceState(deps);
  const rec = st.markets[normId(marketId)];
  if (!rec || !Array.isArray(rec.recentAt)) return 0;
  return rec.recentAt.filter((t) => Number.isFinite(t) && now - t < 3_600_000).length;
}

module.exports = {
  readAutoRepriceConfig, isAutoRepriceEnabled, setAutoReprice,
  readAutoRepriceState, recordAutoRepriceState, repricesInLastHour,
  loadAutoRepriceTuning,
  CONFIG_FILE, STATE_FILE, AUDIT_FILE, AUTO_REPRICE_SOURCE, DEFAULTS, STRATEGIES,
};
