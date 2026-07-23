'use strict';
// lib/safety/kill-switch.js — durable, FAIL-CLOSED, GLOBAL + PER-USER execution kill switch.
//
// This is the "stop everything instantly" control that must exist before any venue is armed. It is
// venue-agnostic: the same kill blocks Polymarket, Kalshi and any crypto venue, because it is checked at
// the placement CHOKEPOINT (before any state-changing venue call AND before any key decryption), not
// inside a venue client.
//
// LOAD-BEARING PROPERTIES (all required by the safety spec):
//   • TWO scopes: global (stops everything, every user, every venue) and per-user (one user only).
//     GLOBAL ALWAYS WINS — checkKill reports global before user.
//   • DURABLE: state is a file under data/, not process memory. A pm2 restart cannot clear a kill.
//   • CHECKED LIVE at the chokepoint: checkKill re-reads the file every call. An engine running for
//     hours sees a kill set one second ago on its next placement attempt (no cache, no startup snapshot).
//   • FAIL CLOSED: if the state cannot be read (permission/I/O error, corrupt JSON) checkKill returns
//     killed:true. Never defaults to permitted. (An ABSENT file is "never killed" = permitted; that is a
//     readable state, handled by store.readStore — see its contract.)
//   • INSTANT TO SET without a deploy: scripts/safety-kill.js (shell) or the authenticated
//     /api/safety/kill route mutate this file; the next placement attempt sees it.
//   • AUDITED: every set/clear appends a who/when/scope/reason line to data/safety-kill-audit.jsonl.
//
// It does NOT arm anything and does NOT itself talk to a venue. Cancelling resting orders on a kill is a
// separate action driven by the engine through the existing cancel-only adapter (cancelAllOnKill below is
// the reusable helper; it takes an already-constructed cancel adapter and never builds one).

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('./store');
const { redact } = require('../venues/polymarket-clob/redact');

const STATE_FILE = path.join(DATA_DIR, 'safety-kill-switch.json');
const AUDIT_FILE = path.join(DATA_DIR, 'safety-kill-audit.jsonl');
const EMPTY = Object.freeze({ global: { killed: false }, users: {} });

function cfg(deps) {
  return {
    stateFile: deps.stateFile || STATE_FILE,
    auditFile: deps.auditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

/**
 * THE CHOKEPOINT CHECK. Reads durable state fresh, returns a DEFINITE decision, never throws.
 * @returns {{killed:boolean, scope:('global'|'user'|'unreadable'|null), gate:(string|null), reason:string}}
 */
function checkKill({ userId } = {}, deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok) {
    return {
      killed: true, scope: 'unreadable', gate: 'kill-switch-unreadable',
      reason: `kill-switch state ${r.error} — failing CLOSED (treating as KILLED until it is readable)`,
    };
  }
  const st = r.value || EMPTY;
  // GLOBAL always wins.
  if (st.global && st.global.killed === true) {
    return {
      killed: true, scope: 'global', gate: 'kill-global',
      reason: `GLOBAL execution kill is active${st.global.reason ? ` — ${st.global.reason}` : ''}`,
    };
  }
  if (userId && st.users && st.users[userId] && st.users[userId].killed === true) {
    const u = st.users[userId];
    return {
      killed: true, scope: 'user', gate: 'kill-user',
      reason: `per-user execution kill is active for ${userId}${u.reason ? ` — ${u.reason}` : ''}`,
    };
  }
  return { killed: false, scope: null, gate: null, reason: '' };
}

function appendKillAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(redact(rec)) + '\n');
  } catch (_e) { /* audit is best-effort; a log-write failure must NEVER stop a kill from being set */ }
}

// Read-modify-write. On a SET we still write even if the prior state was unreadable — tripping a kill
// must always succeed (that is the safe direction). Every mutation is audited.
function mutate(mutFn, event, deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.stateFile, EMPTY, deps);
  // Always build a FRESH mutable object — readStore may hand back the frozen EMPTY singleton on an absent
  // file, and a shared/frozen reference must never be mutated in place.
  const base = (r.ok && r.value) ? r.value : {};
  const st = {
    global: base.global ? { ...base.global } : { killed: false },
    users: { ...(base.users || {}) },
  };
  mutFn(st, c.now());
  writeStoreAtomic(c.stateFile, st, deps);
  appendKillAudit({ ts: c.now(), ...event }, c);
  return st;
}

/** @typedef {{reason?:(string|null), by?:(string|null)}} KillMeta */
/** @typedef {{userId:string, reason?:(string|null), by?:(string|null)}} UserKillMeta */

/** @param {KillMeta} [arg] @param {object} [deps] */
function setGlobalKill({ reason = null, by = null } = {}, deps = {}) {
  return mutate((st, at) => { st.global = { killed: true, reason, by, at }; },
    { event: 'kill', scope: 'global', reason, by }, deps);
}
/** @param {KillMeta} [arg] @param {object} [deps] */
function clearGlobalKill({ reason = null, by = null } = {}, deps = {}) {
  return mutate((st, at) => { st.global = { killed: false, clearedReason: reason, by, at }; },
    { event: 'unkill', scope: 'global', reason, by }, deps);
}
/** @param {UserKillMeta} arg @param {object} [deps] */
function setUserKill({ userId, reason = null, by = null }, deps = {}) {
  if (!userId) throw new Error('setUserKill: userId required');
  return mutate((st, at) => { st.users[userId] = { killed: true, reason, by, at }; },
    { event: 'kill', scope: 'user', userId, reason, by }, deps);
}
/** @param {UserKillMeta} arg @param {object} [deps] */
function clearUserKill({ userId, reason = null, by = null }, deps = {}) {
  if (!userId) throw new Error('clearUserKill: userId required');
  return mutate((st, at) => { st.users[userId] = { killed: false, clearedReason: reason, by, at }; },
    { event: 'unkill', scope: 'user', userId, reason, by }, deps);
}

// Human-readable status (for the CLI / API GET). Distinguishes unreadable (fail-closed) from clear.
function killStatus(deps = {}) {
  const c = cfg(deps);
  const r = readStore(c.stateFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, effectivelyKilled: true, global: null, users: null };
  const st = r.value || EMPTY;
  return {
    readable: true,
    global: st.global || { killed: false },
    users: st.users || {},
    effectivelyKilled: !!(st.global && st.global.killed),
    stateFile: c.stateFile,
  };
}

/**
 * Reusable cancel-on-kill helper. Given an ALREADY-CONSTRUCTED cancel-capable adapter (the frozen
 * cancel-only v1 adapter, or the maker adapter's own cancel path) and a list of market ids, attempt a
 * cancel-all per market. It NEVER builds or arms an adapter — if none is passed (the disarmed build), it
 * is a logged no-op. This is how "killing also attempts to cancel resting orders where the venue
 * supports cancel-only" is satisfied by REUSING the existing cancel path, not rewriting it.
 */
async function cancelAllOnKill({ adapter, marketIds = [] }, deps = {}) {
  const c = cfg(deps);
  if (!adapter || typeof adapter.cancelMarketOrders !== 'function') {
    appendKillAudit({ ts: c.now(), event: 'cancel-on-kill', outcome: 'no-adapter (disarmed) — nothing to cancel' }, c);
    return { attempted: 0, results: [] };
  }
  const results = [];
  for (const marketId of marketIds) {
    try { results.push({ marketId, res: await adapter.cancelMarketOrders(marketId) }); }
    catch (e) { results.push({ marketId, error: (e && e.message) || 'cancel failed' }); }
  }
  appendKillAudit({ ts: c.now(), event: 'cancel-on-kill', outcome: `attempted ${results.length} markets` }, c);
  return { attempted: results.length, results };
}

module.exports = {
  checkKill, setGlobalKill, clearGlobalKill, setUserKill, clearUserKill, killStatus, cancelAllOnKill,
  STATE_FILE, AUDIT_FILE,
};
