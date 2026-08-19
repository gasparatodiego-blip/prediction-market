'use strict';
// lib/maker/kill.js — the ONE-CALL maker KILL: durably STOP every lane and CANCEL every resting order.
//
// This is the control that must ALWAYS work. It runs entirely inside the Edgeradar backend — it never
// depends on polymarket.com being reachable in a browser (blocked by the operator's IT provider). It does
// two independent things, reports each honestly, and can sign or place NOTHING (cancel-only path):
//
//   1. STOP (durable): set the GLOBAL kill (lib/safety/kill-switch.setGlobalKill). Every lane that can
//      reach the venue re-reads this before placing (agent41's cycle and mini-cycle, agent40's manual
//      lane, auto-close included) and stands down, so placement is stopped even if the cancel sweep below
//      fails. Durable: a pm2 restart cannot clear it. setGlobalKill writes even when the prior state was
//      unreadable — tripping the kill is the safe direction and must always succeed.
//   2. CANCEL every resting order NOW via the cancel-only sweep (lib/maker/cancel-all), WITHOUT waiting for
//      any agent — the moment you most need the kill is exactly when an engine is wedged. Venue-reported
//      figures only; a failed venue read/cancel is reported as a failure, never a claimed success.
//
// FAIL-SAFE: with the maker already off and nothing resting, this is a safe no-op that STILL (a) sets the
// durable kill and (b) runs a real (empty) cancel sweep. It is never itself an error to kill a quiet engine.

const { setGlobalKill } = require('../safety/kill-switch');
const { cancelAllOrders } = require('./cancel-all');

/**
 * @param {object} args
 *   by             who pulled it (audit label), reason (audit string)
 *   credsProviders per-venue cancel creds ({} → dry-run cancel sweep). From buildCancelCredsProviders().
 * @param {object} deps  injection for tests: { setGlobalKill, cancelAllOrders, now }
 * @returns {Promise<{at,killed,killError,cancel,cancelError,simulated,cancelledTotal}>}
 */
async function killMaker({ by = 'operator', reason = 'manual kill', credsProviders = {} } = {}, deps = {}) {
  const setKill = deps.setGlobalKill || setGlobalKill;
  const cancel = deps.cancelAllOrders || cancelAllOrders;
  const now = deps.now || (() => Date.now());
  const at = new Date(now()).toISOString();

  // 1. STOP (durable). Always attempt; a kill must never be blocked by a bad prior state.
  let killed = null, killError = null;
  try { setKill({ reason, by }); killed = true; }
  catch (e) { killed = false; killError = (e && e.message) || String(e); }

  // 2. CANCEL everything now, independent of any agent. Never throws out — a cancel failure is reported.
  let cancelResults = [], cancelError = null;
  try { cancelResults = await cancel({ credsProviders }); }
  catch (e) { cancelError = (e && e.message) || String(e); }

  // simulated=true ONLY when EVERY venue ran a dry-run cancel (creds genuinely absent) — the honest signal
  // that no live cancel could be attempted. With real creds present the sweep is live (simulated=false).
  const simulated = cancelResults.length > 0 && cancelResults.every((r) => r && r.simulated === true);

  // ── IL KILL NON PUO' DIRE «FATTO» QUANDO NON HA LETTO ────────────────────────────────────────────
  // Qui c'era un `reduce` che sommava i `cancelled` trattando come 0 tutto cio' che non fosse un numero
  // finito. Con un venue illeggibile il totale usciva `0` accanto a `cancelError: null`, e la riga si
  // legge in un modo solo: «la spazzata e' andata, non c'era niente da togliere». E' l'opposto di cio'
  // che era successo — non lo sappiamo, e gli ordini possono essere ancora tutti a libro.
  //
  // Adesso: se ANCHE UN SOLO venue non e' stato letto, il totale e' `null` (non si sa) e
  // `letturaFallita` lo dice per nome, con l'elenco dei venue coinvolti. Un chiamante che stampa il
  // numero stampa «non si sa»; uno che decide, decide sul flag.
  const nonLetti = cancelResults.filter((r) => r && (r.letturaFallita === true || r.ok === false)).map((r) => r.venue);
  const letturaFallita = nonLetti.length > 0;
  const cancelledTotal = letturaFallita
    ? null
    : cancelResults.reduce((s, r) => s + (Number.isFinite(r && r.cancelled) ? r.cancelled : 0), 0);
  return { at, killed, killError, cancel: cancelResults, cancelError, simulated, cancelledTotal,
    letturaFallita, venuesNonLetti: nonLetti };
}

module.exports = { killMaker };
