'use strict';
// lib/maker/market-cap.js — the PER-MARKET COLLATERAL CEILING, enforced on the quote set.
//
// WHY: the global arming record already carries one collateral cap for the whole arm
// (lib/maker/arming.js collateralCapUsd). That is not enough once a fill rule can RE-QUOTE the opposite
// side: a market that fills repeatedly and re-quotes each time accumulates inventory, and the operator's
// exposure on ONE market can grow far past the size they chose for it. This module is the ceiling the
// bot may never commit past on a single market, no matter how many times its legs fill and re-quote.
//
// PURE. No I/O, no Date, no venue. The store lives in lib/maker/market-caps-store.js; the engine reads
// the cap there and hands it here with the quotes it planned.
//
// ADMISSION ORDER IS DELIBERATE: quotes are admitted closest-to-mid first (highest reward score), so a
// cap that cannot fit the whole ladder keeps the levels that actually earn and drops the far ones —
// never an arbitrary array order. Ties break on price for determinism.
//
// FAIL CLOSED: a cap of 0, a negative cap, or a non-finite cap admits NOTHING. "We could not read your
// ceiling" and "your ceiling is unlimited" are different facts; this module never conflates them.

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Notional a quote would commit, in USD. Uses the quote's own notionalUsd when the planner set it. */
function notionalOf(q) {
  if (fin(q && q.notionalUsd)) return q.notionalUsd;
  if (fin(q && q.price) && fin(q && q.size)) return q.price * q.size;
  return null;
}

/**
 * Admit quotes up to a per-market collateral ceiling.
 *
 * @param {object} args
 *   quotes  Array of planned quotes (lib/maker/quote-plan output shape). Only `postable` quotes consume
 *           the ceiling — a quote already refused upstream commits nothing.
 *   capUsd  the ceiling in USD. null/undefined ⇒ NO ceiling configured (every quote passes through
 *           untouched; the caller decides whether an absent ceiling is acceptable). ≤ 0 ⇒ admits none.
 * @returns {{quotes:Array, capUsd:(number|null), plannedNotionalUsd:number, admittedNotionalUsd:number,
 *            blockedCount:number, capExceeded:boolean, unknownNotionalCount:number}}
 */
function applyCollateralCap({ quotes, capUsd } = {}) {
  const list = Array.isArray(quotes) ? quotes : [];
  const planned = list.reduce((s, q) => s + (q && q.postable ? (notionalOf(q) || 0) : 0), 0);

  // No ceiling configured — pass through verbatim, and SAY the cap was absent (never report "0 blocked
  // under a $0 cap", which reads as an enforced ceiling).
  if (capUsd === null || capUsd === undefined) {
    return {
      quotes: list, capUsd: null,
      plannedNotionalUsd: +planned.toFixed(4), admittedNotionalUsd: +planned.toFixed(4),
      blockedCount: 0, capExceeded: false,
      unknownNotionalCount: list.filter((q) => q && q.postable && notionalOf(q) == null).length,
    };
  }

  const cap = fin(capUsd) && capUsd > 0 ? capUsd : 0;   // unreadable / ≤0 ⇒ admit nothing

  // Closest-to-mid first: distanceC ascending (a nearer quote scores more under the quadratic). A quote
  // with an unknown distance sorts last — we never let an unmeasurable leg crowd out a measured one.
  const order = list
    .map((q, i) => ({ q, i }))
    .sort((a, b) => {
      const da = fin(a.q && a.q.distanceC) ? a.q.distanceC : Infinity;
      const db = fin(b.q && b.q.distanceC) ? b.q.distanceC : Infinity;
      if (da !== db) return da - db;
      const pa = fin(a.q && a.q.price) ? a.q.price : Infinity;
      const pb = fin(b.q && b.q.price) ? b.q.price : Infinity;
      return pa - pb || a.i - b.i;
    });

  const blockedIdx = new Set();
  let admitted = 0;
  let unknownNotionalCount = 0;
  for (const { q, i } of order) {
    if (!q || !q.postable) continue;
    const n = notionalOf(q);
    if (n == null) {
      // We cannot price this leg's commitment ⇒ we cannot prove it fits under the ceiling ⇒ refuse it.
      unknownNotionalCount++;
      blockedIdx.add(i);
      continue;
    }
    if (admitted + n <= cap + 1e-9) admitted += n;
    else blockedIdx.add(i);
  }

  const out = list.map((q, i) => {
    if (!blockedIdx.has(i)) return q;
    return {
      ...q,
      postable: false,
      capBlocked: true,
      reason: `oltre il tetto di collaterale del mercato ($${cap.toFixed(2)}) — non impegnato`,
    };
  });

  return {
    quotes: out,
    capUsd: cap,
    plannedNotionalUsd: +planned.toFixed(4),
    admittedNotionalUsd: +admitted.toFixed(4),
    blockedCount: blockedIdx.size,
    capExceeded: planned > cap + 1e-9,
    unknownNotionalCount,
  };
}

module.exports = { applyCollateralCap, notionalOf };
