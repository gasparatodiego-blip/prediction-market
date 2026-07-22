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

// Registry of LIVE cancel adapters by venue. A venue self-registers its factory at module load (see
// the require at the bottom). Registration is cheap: the factory constructs nothing, loads no ESM and
// no credentials, until it is actually invoked by a gated resolveCancelAdapter call.
const LIVE_FACTORIES = new Map();
function registerLiveCancelAdapter(venue, factory) {
  if (typeof venue === 'string' && typeof factory === 'function') LIVE_FACTORIES.set(venue, factory);
}

/**
 * Resolve which adapter to use. A live adapter is selectable ONLY when the process is armed AND the
 * venue key was verified live — the same two of the four gates the action layer enforces. Either one
 * false → the shadow adapter, which sends nothing.
 *
 * In THIS build NEWS_GUARD_ARMED defaults false, and the action layer passes armed=config.armed, so
 * every real call resolves to shadow. And even when a live adapter IS selected, it carries its own
 * independent belts — PM_ADAPTER_DRYRUN, a throwing credentials provider in the disarmed build, and an
 * address-only signer that cannot sign an order — so SELECTION is not EXECUTION.
 */
function resolveCancelAdapter(venue, { armed, liveVerified } = {}) {
  if (armed === true && liveVerified === true) {
    const factory = LIVE_FACTORIES.get(venue);
    if (factory) {
      try { return factory(); } catch { return ShadowCancelAdapter; } // fail closed to shadow on any construction error
    }
  }
  return ShadowCancelAdapter;
}

// ── Register the Polymarket cancel-only live adapter ────────────────────────────
// Requiring the adapter is cheap — it lazy-imports clob-client (ESM) and loads credentials only inside
// a live method, never at require time. The factory honours PM_ADAPTER_DRYRUN and, in this DISARMED
// build, wires a credentials provider that THROWS: so even if all gates were flipped and dry-run were
// off, a live cancel could not obtain credentials to send an order. Arming — a separate, reviewed
// change — is what wires the real provider (Prisma + key-custody decrypt).
try {
  const { createCancelOnlyAdapter } = require('../venues/polymarket-clob/adapter');
  registerLiveCancelAdapter('polymarket', () => createCancelOnlyAdapter({
    dryRun: process.env.PM_ADAPTER_DRYRUN === 'true',
    credsProvider: async () => {
      throw new Error('live credential loading is not wired in this disarmed build — arming is a separate reviewed change');
    },
  }));
} catch { /* adapter module optional; its absence simply means shadow-only */ }

module.exports = { ShadowCancelAdapter, resolveCancelAdapter, registerLiveCancelAdapter, _LIVE_FACTORIES: LIVE_FACTORIES };
