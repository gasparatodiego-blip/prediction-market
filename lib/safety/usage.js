'use strict';
// lib/safety/usage.js — the MEASURED usage snapshot the risk limits evaluate against. Read from durable
// storage at the chokepoint, never from the request.
//
// HONEST posture on what can and cannot be measured today:
//   • ordersInWindow — DERIVABLE now: count this user's placement INTENT rows in the last windowMs from
//     the execution-audit trail (the single source of truth for what the bot attempted). This is the
//     runaway-loop rate signal and it works in the disarmed build.
//   • openNotionalUsd / realisedDailyPnlUsd — require a real fill/position tracker, which does NOT exist
//     yet (no order has ever filled). Rather than fabricate a zero (which would silently DISABLE the
//     open-exposure and daily-loss limits), these return null. evaluateLimits then FAILS CLOSED on those
//     limits — the armed engine cannot place until a verified exposure/P&L feed is wired. That is the
//     correct, honest default: unknown exposure means no order, not unlimited exposure.
//
// A future fills tracker feeds real numbers here (or the engine passes a measured usage snapshot in);
// nothing else in the limit path changes.

const { queryByUser } = require('./execution-audit');

/**
 * @param {{userId:string, now?:number, windowMs?:number}} args
 * @returns {{openNotionalUsd:(number|null), ordersInWindow:number, realisedDailyPnlUsd:(number|null)}}
 */
function readUsage({ userId, now = Date.now(), windowMs = 60_000 }, deps = {}) {
  let ordersInWindow = 0;
  try {
    const rows = queryByUser({ userId, fromTs: now - windowMs, toTs: now }, deps);
    ordersInWindow = rows.filter(r => r.kind === 'intent').length;
  } catch (_e) {
    // Trail unreadable → we cannot bound the rate → fail closed by reporting a saturated window is unsafe;
    // instead report null so the rate limit fails closed on a non-finite value.
    return { openNotionalUsd: null, ordersInWindow: null, realisedDailyPnlUsd: null };
  }
  return {
    openNotionalUsd: null,        // no verified fill/position tracker yet → fail closed on exposure limit
    ordersInWindow,               // measured from the append-only trail
    realisedDailyPnlUsd: null,    // no verified realised-P&L feed yet → fail closed on daily-loss limit
  };
}

module.exports = { readUsage };
