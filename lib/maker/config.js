'use strict';
// lib/maker/config.js — the SINGLE SOURCE OF TRUTH for the maker's staged activation + rails config.
//
// DISARMED BY DEFAULT. MAKER_MODE defaults to 'off'. Advancing a stage is an explicit env change by a
// human — never a code default, never inferred, never automatic. This mirrors lib/news-guard/config.js
// (same envBool discipline: ONLY the exact string wins, a typo is the safe default).
//
// THE STAGED ACTIVATION LADDER (MAKER_MODE):
//   off       (default) — the engine computes NOTHING that could post; venue writes are unreachable.
//   paper                — full pipeline runs; every decision is logged with the out-of-book gap and
//                          expected reward score it WOULD have posted; ZERO venue writes, no key load.
//   live-min             — REAL orders, ONLY on markets the operator has explicitly enabled
//                          (cfg.enabledMarketIds + the optional MAKER_LIVE_MIN_MARKET pin), with a HARD
//                          absolute per-order notional cap in the low tens of dollars
//                          (MAKER_LIVE_MIN_CAP_USD). Until 2026-07-31 the allowlist was capped at the
//                          single pinned market; the bound is now the operator's own enabled list, which
//                          is durable, audited, and still fails closed when empty or unreadable.
//   live                 — normal caps across markets.
//
// canWrite (a mutating venue call is reachable) requires mode∈{live-min,live} AND not killed AND not
// dry-run. off/paper can NEVER reach a venue write — proven in the maker selfcheck.

const { LIVE_MODES } = require('../venues/polymarket-clob-maker/adapter');

const MODES = Object.freeze(['off', 'paper', 'live-min', 'live']);

function envBool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return v === 'true';
}
function envNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function envStr(v, dflt = null) {
  return typeof v === 'string' && v !== '' ? v : dflt;
}

/**
 * The operator's enabled markets (data/maker-auto-reprice.json, master switch AND per-market opt-in).
 * Required lazily and wrapped: this module is imported by processes that only want the mode flags, and a
 * config-store read failure must degrade to "nothing enabled" rather than throw — [] is the fail-closed
 * value everywhere it is used (the adapter's allowlist gate refuses on an empty list).
 */
function readEnabledMarketIds() {
  try {
    const { readAutoRepriceConfig } = require('./auto-reprice-config');
    const cfg = readAutoRepriceConfig({});
    return Array.isArray(cfg.enabledMarketIds) ? cfg.enabledMarketIds : [];
  } catch { return []; }
}

/**
 * Resolve the maker config from an env bag (defaults to process.env). Every field defaults safe.
 */
function loadMakerConfig(env = process.env) {
  const rawMode = envStr(env.MAKER_MODE, 'off');
  const mode = MODES.includes(rawMode) ? rawMode : 'off';
  const dryRun = envBool(env.MAKER_ADAPTER_DRYRUN, false);
  const killSwitch = envBool(env.MAKER_KILL, false);
  const isLive = LIVE_MODES.includes(mode);
  return {
    mode,
    dryRun,
    killSwitch,
    // A venue write is reachable ONLY here. off/paper → false. kill/dry-run → false.
    canWrite: isLive && !killSwitch && !dryRun,
    // ── live-min market allowlist + hard per-order cap (belt below the engine's own caps) ──
    liveMinMarket: envStr(env.MAKER_LIVE_MIN_MARKET, null), // conditionId; ONE entry of the allowlist
    liveMinCapUsd: envNum(env.MAKER_LIVE_MIN_CAP_USD, 25),  // low tens of dollars
    // The REST of the allowlist: the operator's durable, audited per-market opt-in. Read here so the
    // engine's published heartbeat states which markets live-min may actually touch, instead of naming
    // one pin that stopped being the whole story. Unreadable ⇒ [] ⇒ the gate refuses (never "unlimited").
    enabledMarketIds: readEnabledMarketIds(),
    // ── venue-native order expiry (the ONLY protection that survives host death) — see lib/maker/order-ttl.js ──
    // Every order the maker places carries a signed GTD `expiration` this many seconds out. The venue
    // enforces it even if this whole machine dies. NOTE: the venue's GTD floor is 3 minutes, so a value
    // below ~120s effective is clamped UP to the floor (logged) — sub-floor freshness comes from the
    // maker's cancel/replace cadence, never from the native expiry.
    orderTtlSeconds: envNum(env.MAKER_ORDER_TTL_SECONDS, 60),
    // ── risk rails (Phase 6) — all default to conservative values ──
    rails: {
      perMarketNotionalCapUsd: envNum(env.MAKER_MARKET_NOTIONAL_CAP_USD, 200),
      totalExposureCapUsd: envNum(env.MAKER_TOTAL_EXPOSURE_CAP_USD, 1000),
      perMarketPositionCapUsd: envNum(env.MAKER_POSITION_CAP_USD, 200),
      dailyLossLimitUsd: envNum(env.MAKER_DAILY_LOSS_LIMIT_USD, 50),   // realised+unrealised below -this halts all
      errorRateMax: envNum(env.MAKER_ERROR_RATE_MAX, 5),               // venue errors within the window → breaker
      errorRateWindowMs: envNum(env.MAKER_ERROR_RATE_WINDOW_MS, 60_000),
    },
    // ── re-quote policy (Phase 5) — drift threshold is set from the Phase 1 measurement, overridable ──
    requote: {
      driftThresholdC: envNum(env.MAKER_REQUOTE_DRIFT_C, 0.8),         // default from measure-requote-economics
      hysteresisC: envNum(env.MAKER_REQUOTE_HYSTERESIS_C, 0.2),
      minIntervalMs: envNum(env.MAKER_REQUOTE_MIN_INTERVAL_MS, 15_000),
    },
    // convenience mirror of the news-guard kill, so a high-severity news signal on a market can halt it
    telemetryOnly: !isLive || killSwitch || dryRun,
  };
}

module.exports = { loadMakerConfig, MODES, envBool, envNum, envStr };
