'use strict';
// lib/news-guard/action.js — the ACTION LAYER, disarmed by default.
//
// Given a HIGH market-move signal + the user's placement + the resolved gate config, decide what
// the news-guard would do, and (in this build) ALWAYS do it in shadow: build the full decision,
// touch no venue. decideAction() is pure — it returns a record and whether it consumed an action
// slot; the caller persists idempotency state and appends the record to the shadow log.
//
// THE GATE (all four independent conditions must hold for a REAL order — none can today):
//   1. config.armed              (NEWS_GUARD_ARMED=true)         — default FALSE
//   2. placement.newsMode==='withdraw'  (per-user, per-market opt-in from the UI)
//   3. keyState.liveVerified===true     (the venue key was verified live by a human) — false for all
//   4. a LIVE cancel adapter is registered (resolveCancelAdapter → 'shadow' today) — none exists
// wouldExecute reflects 1∧2∧3; even when it is true, the adapter is 'shadow', so executed is false.
// Flipping ONLY arming, or ONLY the UI mode, therefore cannot produce an order — proven in verify.

const { resolveCancelAdapter } = require('./cancel-adapter');

// Estimate the reward the placement forgoes by pulling — REUSING the market's already-computed
// reward figures (rewardScore.refShare at refCapital). No new reward math: this is a first-order
// linear scale to the placement's capital, and it is LABELLED as such. Returns null if the market
// carries no computed reward figure (never fabricated).
function estRewardForgone(market, placement, cooldownMs) {
  const rs = market && market.rewardScore;
  const capital = (Number(placement.qtyPerSide) || 0) * (placement.side === 'both' ? 2 : 1);
  if (!rs || typeof rs.refShare !== 'number' || typeof rs.poolDay !== 'number' || !rs.refCapital || capital <= 0) {
    return null;
  }
  const refDailyUsd = rs.poolDay * rs.refShare;                 // $/day at the market's reference capital
  const perDay = refDailyUsd * (capital / rs.refCapital);       // first-order (linear in size)
  const windowDays = cooldownMs / 86_400_000;
  return {
    estDailyUsd: Math.round(perDay * 100) / 100,
    estOverCooldownUsd: Math.round(perDay * windowDays * 100) / 100,
    basis: `first-order: market reward $${refDailyUsd.toFixed(2)}/day at $${rs.refCapital} ref capital, scaled to $${capital} placement (linear in size; not self-dilution-adjusted)`,
    refCapital: rs.refCapital, placementCapital: capital,
  };
}

// Per-leg fill contingency, from the placement's OWN rules (defaults BUY→requote, SELL→close). We
// do not know live fill state (paper only), so this is expressed conditionally: IF a side is filled,
// this is the rule that would apply. Never invents a fill.
function fillContingency(placement) {
  return {
    yes: { ifFilled: placement.onFillYes === 'close' ? 'close' : 'requote' },
    no:  { ifFilled: placement.onFillNo  === 'close' ? 'close' : 'requote' },
    note: 'contingent on actual fill at execution time (paper build knows no live fills); follows the leg’s existing rule, not a new behavior',
  };
}

/**
 * Decide the action for one (market, placement) under a HIGH-or-lower signal.
 *
 * @param {object} args
 *   signal   — buildSignal() output for this market (severity/source/evidence)
 *   market   — the market row (venue, title, rewardScore, …)
 *   placement— { userId?, newsMode, side, qtyPerSide, onFillYes, onFillNo }
 *   config   — loadNewsGuardConfig() result
 *   keyState — { liveVerified:boolean } for this venue (default {liveVerified:false})
 *   rails    — { cooldownActive:boolean, hourlyCapReached:boolean } precomputed by the caller
 *   now      — epoch ms (caller-stamped; this module never calls Date)
 * @returns {{ record:object, consumesActionSlot:boolean }}
 */
function decideAction({ signal, market, placement, config, keyState, rails, now }) {
  const venue = market.venue;
  const base = {
    ts: now,
    marketId: market.marketId,
    venue,
    title: (market.title || '').slice(0, 120),
    severity: signal.severity,
    source: signal.source,
    evidence: signal.evidence,
    placement: {
      userId: placement.userId ?? null,
      newsMode: placement.newsMode,
      side: placement.side ?? null,
      qtyPerSide: placement.qtyPerSide ?? null,
      onFillYes: placement.onFillYes ?? null,
      onFillNo: placement.onFillNo ?? null,
    },
    executed: false,     // INVARIANT in this build — no code path sets this true
    mode: 'shadow',      // INVARIANT in this build
  };

  const kv = !!(keyState && keyState.liveVerified === true);
  const newsModeEligible = placement.newsMode === 'withdraw';
  const wouldExecute = config.armed && newsModeEligible && kv;   // 1∧2∧3
  const gates = {
    armed: config.armed,
    killSwitch: config.killSwitch,
    newsModeEligible,
    keyLiveVerified: kv,
    wouldExecute,
    adapterKind: resolveCancelAdapter(venue, { armed: config.armed, liveVerified: kv }).kind, // 'shadow'
  };
  base.gates = gates;

  // ── suppression / no-action gates (in priority order), each logged with its reason ──
  if (config.killSwitch)
    return { record: { ...base, decision: 'suppressed', reason: 'kill-switch (NEWS_GUARD_KILL=true)' }, consumesActionSlot: false };
  if (signal.severity !== 'high')
    return { record: { ...base, decision: 'monitor', reason: `severity ${signal.severity} < high — watch only` }, consumesActionSlot: false };
  if (placement.newsMode === 'off')
    return { record: { ...base, decision: 'off', reason: 'user chose Off — no monitoring action' }, consumesActionSlot: false };
  if (placement.newsMode === 'alert')
    return { record: { ...base, decision: 'alert-only', reason: 'user chose Alert only — notify, never execute' }, consumesActionSlot: false };
  // newsMode === 'withdraw' from here
  if (rails.cooldownActive)
    return { record: { ...base, decision: 'suppressed', reason: `cooldown active (≤ ${config.cooldownMs}ms since last action on this market)` }, consumesActionSlot: false };
  if (rails.hourlyCapReached)
    return { record: { ...base, decision: 'suppressed', reason: `hourly cap reached (${config.maxPerHour}/h)` }, consumesActionSlot: false };

  // ── the withdraw decision — built in full, executed in SHADOW (no network) ──
  const plan = {
    cancel: {
      venue,
      marketId: market.marketId,
      orders: [
        { side: 'yes', rests: (placement.side ?? 'both') !== 'sell' || (placement.side ?? 'both') === 'both' },
        { side: 'no',  rests: (placement.side ?? 'both') !== 'buy'  || (placement.side ?? 'both') === 'both' },
      ].filter(o => o.rests).map(o => ({ side: o.side })),
      note: 'cancel the user’s resting reward quotes on this market',
    },
    fillContingency: fillContingency(placement),
  };

  return {
    record: {
      ...base,
      decision: 'withdraw',
      reason: wouldExecute
        ? 'ARMED+opted-in+verified would execute, but no live cancel adapter is registered → shadow only'
        : `disarmed: wouldExecute=false (armed=${config.armed}, opted-in=${newsModeEligible}, keyLiveVerified=${kv}) → shadow only`,
      plan,
      rewardForgone: estRewardForgone(market, placement, config.cooldownMs),
    },
    consumesActionSlot: true,   // a real "withdraw" decision — burns the cooldown/hourly slot even in shadow
  };
}

module.exports = { decideAction, estRewardForgone, fillContingency };
