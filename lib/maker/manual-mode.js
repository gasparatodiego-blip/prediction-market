'use strict';
// lib/maker/manual-mode.js — the PER-MARKET "the operator holds this market by hand" flag.
//
// WHAT IT IS FOR. The manual-orders panel and agent35 both reach the same venue with the same
// credentials. Without a declared owner per market they fight: the operator hand-places a quote, agent35's
// reconcile sees an order it did not plan and cancels it; or the stand-down sweep wipes it 60 seconds
// later. This flag is the ownership declaration — for ONE market at a time, it says "agent35 keeps its
// hands off; a human is driving here."
//
// WHAT IT IS NOT. It is NOT the kill switch. It does not stop the engine anywhere else, it does not
// disarm, it does not touch data/safety-kill-switch.json, and clearing it re-enables nothing that was not
// already enabled. The global kill remains the one control that stops everything; this one is a scalpel.
//
// SHAPE, and why it is a file under data/ rather than an env var:
//   • DURABLE — a pm2 restart of agent35 must not silently hand a market back to the engine while the
//     operator still has orders resting on it. An env var dies with the process; this does not.
//   • READ LIVE at the decision point — agent35 re-reads it every cycle, so taking a market manual binds
//     on the next tick (~3s) without a restart. A control that needs a deploy is not a control.
//   • AUDITED — every set/clear appends a who/when/why line to data/maker-manual-mode-audit.jsonl.
//   • It is tracked exactly like the other critical states (kill switch, arming, market caps): same
//     lib/safety/store durable+atomic reader/writer, same fail-closed contract, same data/ directory.
//
// FAIL CLOSED — IN BOTH DIRECTIONS. If the state cannot be read (corrupt JSON, permission error) we do
// NOT know who owns a market. Both sides then refuse:
//   • agent35 treats EVERY market as manual and places/cancels nothing (isManualMarket → manual:true);
//   • the manual endpoints refuse too, because they require readable:true before placing.
// So an unreadable ownership file means nobody places — never "both place". An ABSENT file is a readable
// state meaning "no market is manual" (the normal, engine-owned default), exactly as store.readStore
// distinguishes absent from unreadable.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const STATE_FILE = path.join(DATA_DIR, 'maker-manual-mode.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-manual-mode-audit.jsonl');
const EMPTY = Object.freeze({ markets: {} });

function cfg(deps) {
  return {
    stateFile: deps.stateFile || STATE_FILE,
    auditFile: deps.auditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function normId(marketId) {
  return typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
}

/**
 * Read the whole ownership map. Never throws.
 * @returns {{readable:boolean, error:(string|null), markets:object, marketIds:string[], stateFile:string}}
 */
function readManualMode(deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, marketIds: [], stateFile: c.stateFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const marketIds = Object.keys(markets).filter((k) => markets[k] && markets[k].manual === true);
  return { readable: true, error: null, markets, marketIds, stateFile: c.stateFile };
}

/**
 * THE DECISION POINT. Is this ONE market under manual control?
 *
 * FAIL CLOSED: an unreadable state answers manual:true with readable:false. agent35 reads `manual` and
 * stands off; the manual endpoints read `readable` and also refuse. Neither side may place on a market
 * whose owner it could not determine.
 *
 * @returns {{manual:boolean, readable:boolean, error:(string|null), record:(object|null), reason:string}}
 */
function isManualMarket(marketId, deps = {}) {
  const st = readManualMode(deps);
  if (!st.readable) {
    return {
      manual: true, readable: false, error: st.error, record: null,
      reason: `manual-mode state ${st.error} — failing CLOSED (treating EVERY market as manual: the engine stands off and the manual panel refuses, because ownership could not be read)`,
    };
  }
  const id = normId(marketId);
  if (!id) return { manual: false, readable: true, error: null, record: null, reason: 'no marketId supplied' };
  const rec = st.markets[id] || null;
  const manual = !!(rec && rec.manual === true);
  return {
    manual, readable: true, error: null, record: rec,
    reason: manual
      ? `manual mode is ACTIVE on ${id}${rec.reason ? ` — ${rec.reason}` : ''}`
      : `manual mode is not active on ${id} — the engine owns this market`,
  };
}

function appendManualAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort: an audit-write failure must never stop the flag from being set */ }
}

/**
 * Take a market manual (manual=true) or hand it back to the engine (manual=false). Audited.
 *
 * Read-modify-write on a FRESH object (readStore may hand back the frozen EMPTY singleton). We write even
 * when the prior state was unreadable IF we are SETTING manual — taking a market away from the engine is
 * the safe direction and must always succeed. CLEARING (handing back to the engine) on an unreadable
 * state is REFUSED: that would hand control to the engine on the strength of a state we cannot read.
 *
 * @returns {{ok:boolean, error?:string, marketId:string, manual:boolean, record?:object}}
 */
function setManualMode({ marketId, manual, by = null, reason = null }, deps = {}) {
  const c = cfg(deps);
  const id = normId(marketId);
  if (!id) return { ok: false, error: 'marketId required', marketId: '', manual: false };
  if (typeof manual !== 'boolean') return { ok: false, error: 'manual must be a boolean', marketId: id, manual: false };

  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok && manual === false) {
    return {
      ok: false, marketId: id, manual: false,
      error: `manual-mode state ${r.error} — refusing to hand ${id} back to the engine while ownership is unreadable (fix the file first; taking a market MANUAL is still permitted)`,
    };
  }
  const base = (r.ok && r.value) ? r.value : {};
  const st = { markets: { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) } };
  const at = c.now();
  const record = { manual, at, atIso: new Date(at).toISOString(), by, reason };
  st.markets[id] = record;
  st.updatedAt = at;
  writeStoreAtomic(c.stateFile, st, deps);
  appendManualAudit({ ts: at, event: manual ? 'manual-mode-on' : 'manual-mode-off', marketId: id, by, reason }, c);
  return { ok: true, marketId: id, manual, record };
}

// ── THE TWO FUNCTIONS agent35 CALLS. They live here, not inline in the agent, so the selfcheck can prove
//    the exact decisions the engine makes without booting it. ────────────────────────────────────────────

/**
 * agent35's placement gate for ONE market. Returns the human-readable block reason, or null to proceed.
 * The string deliberately contains "manual mode active, skip" — that phrase is what the operator greps
 * for in `pm2 logs agent35-maker` to prove the isolation is real.
 */
function placementBlockReason(marketId, deps = {}) {
  const m = isManualMarket(marketId, deps);
  if (!m.manual) return null;
  return m.readable
    ? 'manual mode active, skip — the operator holds this market by hand (data/maker-manual-mode.json)'
    : `manual mode active, skip — ownership unreadable (${m.error}), failing closed for every market`;
}

/**
 * agent35's cancel gate. A manual market must be EXCLUDED from the engine's routine cancel sweeps
 * (universe-leave, stand-down, auto-disarm) — those exist to clean up the ENGINE's own orders, and
 * cancelMarketOrders is indiscriminate: it would wipe the operator's hand-placed orders too.
 *
 * DELIBERATE SCOPE. This filters agent35's ROUTINE sweeps only. The operator's KILL (POST /api/maker/kill
 * → lib/maker/cancel-all, the cancel-only adapter) is untouched and still cancels EVERYTHING on every
 * market, manual included. The panic button must never have an exception; a housekeeping sweep must.
 *
 * @returns {{allowed:string[], skipped:string[], readable:boolean}}
 */
function filterCancelTargets(marketIds, deps = {}) {
  const list = Array.isArray(marketIds) ? marketIds : [];
  const st = readManualMode(deps);
  if (!st.readable) return { allowed: [], skipped: list.slice(), readable: false };
  const manualSet = new Set(st.marketIds);
  const allowed = [], skipped = [];
  for (const id of list) (manualSet.has(normId(id)) ? skipped : allowed).push(id);
  return { allowed, skipped, readable: true };
}

module.exports = {
  readManualMode, isManualMarket, setManualMode, placementBlockReason, filterCancelTargets,
  STATE_FILE, AUDIT_FILE,
};
