'use strict';
// lib/maker/fill-strategy-config.js — the switches and tunables for the FILL STRATEGY.
//
// WHAT THIS SWITCHES. With it OFF (the default, everywhere, and the state it fails to) a filled order
// behaves exactly as it does today. With it ON for a market, a fill triggers three things at once:
//   1. a TAKE-PROFIT exit on the opposite side, near the entry price;
//   2. a REPLACEMENT quote at the same side and price, so the market keeps being made;
//   3. unless the accumulated position on that market AND THAT SIDE has reached its ceiling, in which
//      case the replacement is withheld until the position comes back down.
// A stop-loss on the weighted-average drawdown sits over all three.
//
// SAME SHAPE AS THE AUTO-REPRICE AND AUTO-CLOSE SWITCHES, deliberately: a durable file under data/, a
// global master plus a per-market opt-in, BOTH required, both defaulting OFF, both fail-closed to OFF,
// every flip audited. An operator who has learned one of these has learned all three.
//
// WHY A THIRD FILE AND NOT A FLAG ON AN EXISTING ONE. Auto-reprice MOVES an order that is already yours.
// Auto-close OPENS an exit against inventory. This one does both AND re-arms the entry, so it is the only
// one of the three that can grow exposure on its own. Wiring it to either existing flag would mean
// switching on the most powerful of the three while reaching for a milder one.
//
// THE POSITION CEILING IS NOT HERE, AND THAT IS THE POINT. It is derived from the allocation plan
// (lib/maker/allocated-capital.js) and there is no setter for it on this module, no field for it in this
// file, and no endpoint that accepts one. The operator tunes the take-profit and the stop-loss; the
// ceiling is a consequence of how much capital the planner put in that market.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CONFIG_FILE = path.join(DATA_DIR, 'maker-fill-strategy.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-fill-strategy-audit.jsonl');
const EMPTY = Object.freeze({ global: { enabled: false }, markets: {} });

// The audit `source` for everything this feature does. Distinct from 'manual-ui' (a human), 'agent35'
// (the engine), 'auto-reprice-band-exit' (the band watcher) and 'auto-close-on-fill' (the plain exit), so
// the one trail always says which of the five moved an order.
const FILL_STRATEGY_SOURCE = 'fill-strategy';

// ── DEFAULTS, DECLARED ─────────────────────────────────────────────────────────────────────────────
// The take-profit default is 0 and means "mirror the entry offset": the exit goes the same distance from
// the mid as the entry did, on the opposite side. That is the brief's default and it is also the only one
// that needs no constant — it is derived from the order that actually filled.
const DEFAULT_TAKE_PROFIT_CENTS = 0;      // 0 ⇒ mirror the entry's own distance from the mid
const DEFAULT_STOP_LOSS_PCT = 4;          // % drawdown on the weighted-average entry
const DEFAULT_MAX_SLIPPAGE_PCT = 2.5;     // thin-book budget for the stop-loss exit (see fill-strategy.js)

// Bounds the setter enforces. A value outside them is REFUSED, never clamped: silently accepting 900%
// and storing 100 is how an operator ends up believing a limit they never set.
const TAKE_PROFIT_RANGE = Object.freeze({ min: 0, max: 10 });     // cents per share
const STOP_LOSS_RANGE = Object.freeze({ min: 0.5, max: 50 });     // percent
const SLIPPAGE_RANGE = Object.freeze({ min: 0.5, max: 10 });      // percent

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function normId(marketId) { return typeof marketId === 'string' ? marketId.trim().toLowerCase() : ''; }
function cfgDeps(deps) {
  return {
    configFile: deps.fillStrategyConfigFile || CONFIG_FILE,
    auditFile: deps.fillStrategyAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

/** Read the whole switch map. Unreadable ⇒ OFF (an automatism we cannot read never gets to act). */
function readFillStrategyConfig(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok) {
    return { readable: false, error: r.error, globalEnabled: false, markets: {}, optedInMarketIds: [], enabledMarketIds: [], configFile: c.configFile };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const g = (st.global && typeof st.global === 'object') ? st.global : {};
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const globalEnabled = g.enabled === true;
  const optedIn = Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true);
  return {
    readable: true, error: null, globalEnabled, globalRecord: g.enabled === undefined ? null : g,
    markets, optedInMarketIds: optedIn,
    enabledMarketIds: globalEnabled ? optedIn : [],
    configFile: c.configFile,
  };
}

/** The tunables in force for one market, with the defaults filled in and SAID to be defaults. */
function paramsFor(marketId, deps = {}) {
  const st = readFillStrategyConfig(deps);
  const rec = st.readable ? (st.markets[normId(marketId)] || null) : null;
  const tp = rec && fin(rec.takeProfitCents) ? rec.takeProfitCents : DEFAULT_TAKE_PROFIT_CENTS;
  const sl = rec && fin(rec.stopLossPct) ? rec.stopLossPct : DEFAULT_STOP_LOSS_PCT;
  const sp = rec && fin(rec.maxSlippagePct) ? rec.maxSlippagePct : DEFAULT_MAX_SLIPPAGE_PCT;
  return {
    takeProfitCents: tp, takeProfitIsDefault: !(rec && fin(rec.takeProfitCents)),
    takeProfitMirrorsEntry: tp === 0,
    stopLossPct: sl, stopLossIsDefault: !(rec && fin(rec.stopLossPct)),
    maxSlippagePct: sp, maxSlippageIsDefault: !(rec && fin(rec.maxSlippagePct)),
  };
}

/** May the strategy act on THIS market? Enabled ⇔ readable AND master on AND market opted in. */
function isFillStrategyEnabled(marketId, deps = {}) {
  const st = readFillStrategyConfig(deps);
  if (!st.readable) {
    return { enabled: false, readable: false, globalEnabled: false, marketEnabled: false, error: st.error, record: null,
      reason: `configurazione della strategia sul fill ${st.error} — fail CLOSED: nessuna azione` };
  }
  const id = normId(marketId);
  if (!id) return { enabled: false, readable: true, globalEnabled: st.globalEnabled, marketEnabled: false, error: null, record: null, reason: 'nessun marketId indicato' };
  const rec = st.markets[id] || null;
  const marketEnabled = !!(rec && rec.enabled === true);
  const enabled = st.globalEnabled && marketEnabled;
  return {
    enabled, readable: true, globalEnabled: st.globalEnabled, marketEnabled, error: null, record: rec,
    reason: enabled
      ? `strategia sul fill ATTIVA su ${id}`
      : !st.globalEnabled
        ? `strategia spenta globalmente${marketEnabled ? ' (questo mercato è acceso, ma l\'interruttore generale ha la precedenza)' : ''}`
        : `strategia non abilitata su ${id} — un fill resta una posizione aperta`,
  };
}

function appendAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort; an audit failure must never stop a switch being flipped */ }
}

/**
 * Flip a switch, or set a tunable. Enabling over an unreadable state is REFUSED; disabling is always
 * permitted — the direction that can only reduce activity must never be blocked.
 *
 * `patch` may carry takeProfitCents / stopLossPct / maxSlippagePct. Out-of-range values are REFUSED.
 * There is deliberately no key here for the position ceiling: it is derived, see allocated-capital.js.
 */
function setFillStrategy({ scope = 'market', marketId = null, enabled = null, patch = null, by = null, reason = null }, deps = {}) {
  const c = cfgDeps(deps);
  if (scope !== 'global' && scope !== 'market') return { ok: false, error: "scope must be 'global' or 'market'", scope, marketId };
  const id = scope === 'market' ? normId(marketId) : null;
  if (scope === 'market' && !id) return { ok: false, error: 'marketId required for scope:market', scope, marketId };
  if (enabled === null && !patch) return { ok: false, error: 'nothing to change: pass `enabled` or `patch`', scope, marketId: id };
  if (enabled !== null && typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean', scope, marketId: id };
  if (patch && scope !== 'market') return { ok: false, error: 'i valori take-profit / stop-loss sono per mercato', scope, marketId: id };

  // ── RANGE CHECKS, refusing rather than clamping. ──
  const clean = {};
  if (patch) {
    const checks = [
      ['takeProfitCents', TAKE_PROFIT_RANGE, 'take-profit (¢)'],
      ['stopLossPct', STOP_LOSS_RANGE, 'stop-loss (%)'],
      ['maxSlippagePct', SLIPPAGE_RANGE, 'slippage massimo (%)'],
    ];
    for (const [key, range, label] of checks) {
      if (patch[key] === undefined) continue;
      const v = Number(patch[key]);
      if (!fin(v)) return { ok: false, error: `${label}: valore non numerico`, scope, marketId: id };
      if (v < range.min || v > range.max) {
        return { ok: false, error: `${label}: ${v} fuori dall'intervallo ammesso ${range.min}–${range.max} — rifiutato, non troncato`, scope, marketId: id };
      }
      clean[key] = v;
    }
    // Anything not in the whitelist is refused outright — notably any attempt to write a ceiling.
    for (const k of Object.keys(patch)) {
      if (!['takeProfitCents', 'stopLossPct', 'maxSlippagePct'].includes(k)) {
        return { ok: false, error: `campo non modificabile: ${k}${k.toLowerCase().includes('cap') || k.toLowerCase().includes('tetto') ? ' — il tetto posizione è derivato dal capitale allocato e non si imposta qui' : ''}`, scope, marketId: id };
      }
    }
  }

  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok && enabled === true) {
    return { ok: false, scope, marketId: id,
      error: `configurazione ${r.error} — rifiuto di ACCENDERE la strategia su uno stato che non so leggere (spegnerla resta sempre permesso)` };
  }
  const base = (r.ok && r.value) ? r.value : {};
  const st = {
    global: (base.global && typeof base.global === 'object') ? { ...base.global } : { enabled: false },
    markets: { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) },
  };
  const at = c.now();
  if (scope === 'global') {
    st.global = { enabled: enabled === true, at, atIso: new Date(at).toISOString(), by, reason };
  } else {
    const prev = (st.markets[id] && typeof st.markets[id] === 'object') ? st.markets[id] : {};
    st.markets[id] = {
      ...prev, ...clean,
      enabled: enabled === null ? (prev.enabled === true) : enabled,
      at, atIso: new Date(at).toISOString(), by, reason,
    };
  }
  st.updatedAt = at;
  writeStoreAtomic(c.configFile, st, deps);
  appendAudit({
    ts: at, event: 'fill-strategy-set', scope, marketId: id,
    enabled: enabled === null ? undefined : enabled, patch: Object.keys(clean).length ? clean : undefined, by, reason,
  }, c);
  return { ok: true, scope, marketId: id, enabled: scope === 'global' ? st.global.enabled : st.markets[id].enabled, record: scope === 'global' ? st.global : st.markets[id] };
}

module.exports = {
  readFillStrategyConfig, isFillStrategyEnabled, setFillStrategy, paramsFor,
  CONFIG_FILE, AUDIT_FILE, FILL_STRATEGY_SOURCE,
  DEFAULT_TAKE_PROFIT_CENTS, DEFAULT_STOP_LOSS_PCT, DEFAULT_MAX_SLIPPAGE_PCT,
  TAKE_PROFIT_RANGE, STOP_LOSS_RANGE, SLIPPAGE_RANGE,
};
