'use strict';
// lib/maker/kill.js — the ONE-CALL maker KILL: durably DISARM the engine and CANCEL every resting order.
//
// This is the control that must ALWAYS work. It runs entirely inside the Edgeradar backend — it never
// depends on polymarket.com being reachable in a browser (blocked by the operator's IT provider). It does
// three independent things, reports each honestly, and can sign or place NOTHING (cancel-only path):
//
//   1. DISARM (durable): set the GLOBAL kill (lib/safety/kill-switch.setGlobalKill). agent35 re-reads this
//      every tick and stands down (rails → halt-all/cancel-all), so the engine is disarmed even if the
//      cancel sweep below fails. Durable: a pm2 restart cannot clear it. setGlobalKill writes even when the
//      prior state was unreadable — tripping the kill is the safe direction and must always succeed.
//   2. DISARM the arming record (best-effort) so a later MAKER_MODE flip cannot resume a stale arm.
//   3. CANCEL every resting order NOW via the cancel-only sweep (lib/maker/cancel-all), WITHOUT waiting for
//      agent35 — the moment you most need the kill is exactly when agent35 is wedged. Venue-reported figures
//      only; a failed venue read/cancel is reported as a failure, never a claimed success.
//
// FAIL-SAFE: with the maker already off and nothing resting, this is a safe no-op that STILL (a) sets the
// durable kill and (b) runs a real (empty) cancel sweep. It is never itself an error to kill a quiet engine.

const { setGlobalKill } = require('../safety/kill-switch');
const { cancelAllOrders } = require('./cancel-all');

/**
 * @param {object} args
 *   by             who pulled it (audit label), reason (audit string)
 *   credsProviders per-venue cancel creds ({} → dry-run cancel sweep). From buildCancelCredsProviders().
 *   disarmArming   optional (reason:string)=>void — flip the arming record off (added in the arming commit).
 * @param {object} deps  injection for tests: { setGlobalKill, cancelAllOrders, now }
 * @returns {Promise<{at,killed,killError,armingDisarmed,cancel,cancelError,simulated,cancelledTotal}>}
 */
async function killMaker({ by = 'operator', reason = 'manual kill', credsProviders = {}, disarmArming = null } = {}, deps = {}) {
  const setKill = deps.setGlobalKill || setGlobalKill;
  const cancel = deps.cancelAllOrders || cancelAllOrders;
  const now = deps.now || (() => Date.now());
  const at = new Date(now()).toISOString();

  // 1. DISARM (durable). Always attempt; a kill must never be blocked by a bad prior state.
  let killed = null, killError = null;
  try { setKill({ reason, by }); killed = true; }
  catch (e) { killed = false; killError = (e && e.message) || String(e); }

  // 2. DISARM the arming record too (best-effort; the record may not exist in this build).
  let armingDisarmed = null;
  if (typeof disarmArming === 'function') {
    try { disarmArming('kill-switch'); armingDisarmed = true; } catch { armingDisarmed = false; }
  }

  // 3. CANCEL everything now, independent of agent35. Never throws out — a cancel failure is reported.
  let cancelResults = [], cancelError = null;
  try { cancelResults = await cancel({ credsProviders }); }
  catch (e) { cancelError = (e && e.message) || String(e); }

  // simulated=true ONLY when EVERY venue ran a dry-run cancel (creds genuinely absent) — the honest signal
  // that no live cancel could be attempted. With real creds present the sweep is live (simulated=false).
  const simulated = cancelResults.length > 0 && cancelResults.every((r) => r && r.simulated === true);
  const cancelledTotal = cancelResults.reduce((s, r) => s + (Number.isFinite(r && r.cancelled) ? r.cancelled : 0), 0);
  return { at, killed, killError, armingDisarmed, cancel: cancelResults, cancelError, simulated, cancelledTotal };
}

module.exports = { killMaker };
