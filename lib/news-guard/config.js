'use strict';
// lib/news-guard/config.js — the single source of truth for the news-guard's execution gates.
//
// DISARMED BY DEFAULT. Every field here defaults to the safe value: no arming, no execution.
// Arming is a later, explicit env flip by a human — never a code default and never inferred.
//
// This module reads env only; it holds NO credentials and talks to no venue. Both the pm2 agent
// (agent27) and any tool import it so the gate logic lives in exactly one place. The UI does NOT
// import this (server env isn't on the client) — it reads the resolved `armed`/`killSwitch` flags
// out of the agent's written output, so the panel can never claim a different arming state than
// the process actually runs under.

// Parse a boolean env var with an explicit default. ONLY the exact string 'true' is true — a
// missing var, empty string, '1', 'yes', or any typo is treated as the (safe) default/false, so
// arming can never happen by accident or by a fuzzy value.
function envBool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return v === 'true';
}

function envInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/**
 * Resolve the news-guard gate config from an env bag (defaults to process.env).
 *
 * Returned fields:
 *   armed       — NEWS_GUARD_ARMED. Master arm for the withdraw ACTION. Default FALSE.
 *                 When false the action layer runs in SHADOW: it computes and logs every
 *                 decision but makes ZERO venue network calls.
 *   killSwitch  — NEWS_GUARD_KILL. Instant global disable. When true the action layer takes
 *                 no action at all (not even shadow execution intent) and logs the suppression.
 *   cooldownMs  — one action per market per this window (idempotency).
 *   maxPerHour  — hard cap on actions considered per rolling hour.
 *   telemetryOnly — convenience: true whenever we are NOT armed OR the kill switch is on, i.e.
 *                   the current process cannot send a real order no matter what a market says.
 */
function loadNewsGuardConfig(env = process.env) {
  const armed = envBool(env.NEWS_GUARD_ARMED, false);
  const killSwitch = envBool(env.NEWS_GUARD_KILL, false);
  return {
    armed,
    killSwitch,
    cooldownMs: envInt(env.NEWS_GUARD_COOLDOWN_MS, 6 * 3_600_000), // 6h
    maxPerHour: envInt(env.NEWS_GUARD_MAX_ACTIONS_PER_HOUR, 20),
    telemetryOnly: !armed || killSwitch,
  };
}

module.exports = { loadNewsGuardConfig, envBool, envInt };
