'use strict';
// lib/maker/requote-policy.js — PURE core for the re-quote decision (Phase 5). Driven by the Phase 1
// measurement (measure-requote-economics.js), NOT by intuition: chasing the mid too tightly cancels &
// replaces constantly, and every cancel+replace is a window with NOTHING resting — sampling is random
// within the minute, so time out of the book is directly lost reward. The threshold trades tracking
// error (quote drifts from mid → lower S) against churn (time out of book → lost samples).
//
// This module decides WHETHER to re-quote and in WHICH ORDER to cancel/replace to minimise time out of
// the book. It stamps nothing and touches no venue — the engine supplies now + measures the real gap.

/**
 * Should this leg be re-quoted?  Re-quote ⇔ the quote has drifted at least driftThresholdC cents from
 * its target AND at least minIntervalMs has elapsed since the last re-quote (rate limit). Hysteresis:
 * once a leg has re-quoted, it must drift a further hysteresisC beyond the base threshold before the
 * NEXT re-quote, so a quote hovering right at the threshold does not flap.
 *
 * @param {object} args
 *   driftC        signed |current − target| already in cents (caller computes from adjusted mid)
 *   lastRequoteAt epoch ms of the previous re-quote for this leg (or null)
 *   recentlyRequoted whether the last re-quote was within the hysteresis memory window
 *   config        { driftThresholdC, hysteresisC, minIntervalMs }
 *   now           epoch ms
 * @returns { requote:boolean, reason, waitMs }
 */
function decideRequote({ driftC, lastRequoteAt, recentlyRequoted, config, now }) {
  const absDrift = Math.abs(Number(driftC) || 0);
  const threshold = config.driftThresholdC + (recentlyRequoted ? config.hysteresisC : 0);
  if (absDrift < threshold) return { requote: false, reason: `drift ${absDrift.toFixed(2)}c < threshold ${threshold.toFixed(2)}c`, waitMs: 0 };
  const elapsed = lastRequoteAt != null ? now - lastRequoteAt : Infinity;
  if (elapsed < config.minIntervalMs) return { requote: false, reason: `rate-limited (${elapsed}ms < ${config.minIntervalMs}ms since last re-quote)`, waitMs: config.minIntervalMs - elapsed };
  return { requote: true, reason: `drift ${absDrift.toFixed(2)}c ≥ threshold ${threshold.toFixed(2)}c and rate-limit clear`, waitMs: 0 };
}

/**
 * Order the cancel/replace to minimise time out of the book.
 *   • If a transient double-size is within caps → PLACE-THEN-CANCEL: the new quote rests before the old
 *     one is pulled, so out-of-book time ≈ 0 (a sample can never land in a gap). Costs a brief window of
 *     doubled resting size (one round-trip) — acceptable only if caps allow it.
 *   • Otherwise → CANCEL-THEN-PLACE: pull first (out-of-book gap ≈ the post round-trip), then re-post.
 *     Reward-lossier but never breaches a cap.
 * The engine measures the ACTUAL out-of-book gap and records it per re-quote — this only picks the order.
 */
function planRequoteOrdering({ canDoubleTransiently }) {
  return canDoubleTransiently
    ? { order: 'place-then-cancel', expectedOutOfBookMs: 0, note: 'new rests before old is pulled — no sampling gap; brief transient double size' }
    : { order: 'cancel-then-place', expectedOutOfBookMs: null, note: 'pull first (gap = post round-trip) — cap-safe; engine measures the real gap' };
}

module.exports = { decideRequote, planRequoteOrdering };
