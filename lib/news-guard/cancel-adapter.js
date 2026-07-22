'use strict';
// lib/news-guard/cancel-adapter.js — the venue-cancel interface + the ONLY adapter in this build.
//
// A real withdraw needs to (a) cancel the user's resting reward orders on the affected market and
// (b) for any leg already filled, exit per that leg's fill rule. This file defines that interface
// and provides EXACTLY ONE implementation: ShadowCancelAdapter, which BUILDS the plan and makes
// ZERO venue network calls. No live adapter exists, and none is imported here — this module pulls
// in no key custody, no venue REST client, nothing that could reach an exchange.
//
// Wiring real cancellation LATER is a separate, reviewed change: implement CancelAdapter against a
// Polymarket/Kalshi client, register it, and satisfy the arming + liveVerified gates in action.js.
// Until then resolveCancelAdapter() ALWAYS returns the shadow adapter, so the action path is inert
// even if every env gate were flipped.

/**
 * @typedef {Object} CancelAdapter
 * @property {'shadow'|'live'} kind
 * @property {(plan:object)=>Promise<object>} cancelResting  cancel the resting orders in `plan`
 * @property {(leg:object)=>Promise<object>}  exitFilledLeg  exit a filled leg per its fill rule
 */

/** The only adapter that exists. Places/cancels NOTHING — returns a described plan, no network. */
const ShadowCancelAdapter = {
  kind: 'shadow',
  async cancelResting(plan) {
    // Deliberately no I/O. Echo what a real cancel WOULD target so the shadow log is complete.
    return { ok: true, simulated: true, sent: false, wouldCancel: plan.orders || [], venue: plan.venue };
  },
  async exitFilledLeg(leg) {
    return { ok: true, simulated: true, sent: false, wouldExit: leg };
  },
};

/**
 * Resolve which adapter to use. There is no live adapter registered in this build, so this returns
 * the shadow adapter unconditionally. The `armed`/`liveVerified` inputs are accepted (and echoed in
 * the reason) purely so a future live adapter can be gated here without changing call sites — today
 * they cannot select a live adapter because none exists.
 */
function resolveCancelAdapter(/* venue, { armed, liveVerified } = {} */) {
  return ShadowCancelAdapter;
}

module.exports = { ShadowCancelAdapter, resolveCancelAdapter };
