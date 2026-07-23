'use strict';
// lib/safety/index.js — the default execution-safety binding the placement chokepoint uses.
//
// It composes the venue-agnostic kill switch, risk limits, usage snapshot and audit trail into the exact
// surface the maker adapter's postOrder calls. The adapter takes this as opts.safety (default = this
// module); tests inject a controllable bag pointed at temp fixtures. Keeping the wiring here means the
// adapter never hardcodes a data path or a policy — it just asks the safety layer to decide.

const killSwitch = require('./kill-switch');
const riskLimits = require('./risk-limits');
const executionAudit = require('./execution-audit');
const { readUsage } = require('./usage');

// checkKill(userId) → definite kill decision (fail-closed inside kill-switch).
function checkKill({ userId }) { return killSwitch.checkKill({ userId }); }

// Resolve limits + evaluate them for one order. Returns a definite { allow, gate, reason, autoKill }.
// Fails closed if the config is unreadable. Also returns the resolved limits + clamp events for the audit.
function evaluateForOrder({ userId, venue, order }) {
  const resolved = riskLimits.resolveLimits({ userId });
  if (!resolved.ok) {
    return {
      venueAllowed: false,
      limits: { allow: false, gate: 'limits-unreadable', reason: `risk-limit config ${resolved.error} — failing closed` },
      clampEvents: [],
    };
  }
  const venueAllowed = riskLimits.isVenueAllowed({ venue, limits: resolved.limits });
  const usage = readUsage({ userId });
  const limits = riskLimits.evaluateLimits({ order, usage, limits: resolved.limits });
  return { venueAllowed, limits, clampEvents: resolved.clampEvents || [], usage };
}

module.exports = {
  checkKill,
  evaluateForOrder,
  recordIntent: executionAudit.recordIntent,
  recordOutcome: executionAudit.recordOutcome,
  deriveIdempotencyKey: executionAudit.deriveIdempotencyKey,
  setUserKill: killSwitch.setUserKill,
  // re-exports so a single require('lib/safety') reaches everything
  killSwitch, riskLimits, executionAudit,
};
