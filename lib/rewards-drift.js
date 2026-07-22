'use strict';
// lib/rewards-drift.js — per-leg drift detection for the live reward band. PURE core
// (no I/O, no Date): agent34 supplies the live status + time state + rails and
// persists the result. Emits a DriftSignal when a leg leaves the band, writes only a
// SHADOW record, and can NEVER execute — drift is ADVISORY (the user re-quotes by
// hand). There is no cancel/place path here; `executed` is a hard-false invariant.
//
// HONEST ENGINE:
//   • seconds out of band is the measured proxy for reward lost (Polymarket samples
//     the book per minute) — we accrue real elapsed ms, never an invented figure.
//   • reward forgone comes ONLY from the market's already-computed rewardScore
//     (via the caller); null when that is unavailable — never fabricated.
//   • the drift-magnitude threshold is the EXISTING band radius (maxSpread/2), not a
//     new invented constant: |drift| >= radius is "a full half-band off".
//
// STRUCTURAL-BASELINE GATE (commit 00a5802): a permanently one-sided market has no
// two-sided band to drift from, so drift is suppressed there — no drift noise on a
// market that is one-sided by construction.

const { legStatus, round } = require('./rewards-live-band');

// Accrue elapsed time into in-band / out-of-band buckets based on the PREVIOUS
// sample's band membership. First observation only seeds the clock. Returns a NEW
// state object (caller stores it).
function accrue(timeState, inBandNow, now) {
  const s = timeState || { lastTs: null, inBandMs: 0, outBandMs: 0, prevInBand: null };
  if (s.lastTs == null) {
    return { lastTs: now, inBandMs: 0, outBandMs: 0, prevInBand: inBandNow };
  }
  const dt = Math.max(0, now - s.lastTs);
  const inc = s.prevInBand ? { inBandMs: s.inBandMs + dt } : { outBandMs: s.outBandMs + dt };
  return {
    lastTs: now,
    inBandMs: inc.inBandMs != null ? inc.inBandMs : s.inBandMs,
    outBandMs: inc.outBandMs != null ? inc.outBandMs : s.outBandMs,
    prevInBand: inBandNow,
  };
}

// Fire when the leg just LEFT the band, or drifted a full half-band (>= radius).
// Anticipatory ("mid approaching edge") is deliberately NOT emitted: although event
// cadence is high (~30/min), band-relevant MID moves are sparse and discrete
// (measured ~1 move / 5 markets / 5 min), so a velocity trigger would be mostly
// noise. We ship only the honest "already out"/"drifted" signal.
function shouldSignal(prevInBand, status, bandRadiusC) {
  const leftBand = prevInBand === true && status.inBandNow === false;
  const drifted = status.absDriftC != null && bandRadiusC > 0 && status.absDriftC >= bandRadiusC;
  if (!leftBand && !drifted) return { fire: false, reason: null };
  return { fire: true, reason: leftBand ? 'left-band' : `drift>=radius(${round(bandRadiusC, 2)}c)` };
}

// Reward forgone over the accumulated out-of-band time, from the market's existing
// est $/day (caller passes it from rewardScore). Null when unknown — never invented.
function forgoneUsd(estDailyUsd, outBandMs) {
  if (estDailyUsd == null || !(outBandMs >= 0)) return null;
  return round(estDailyUsd * (outBandMs / 86_400_000), 5);
}

/**
 * Decide a leg's drift outcome for this tick. PURE.
 *   leg      — persisted RewardsLeg (book, kind, price, mode, offsetC)
 *   market   — { mid, maxSpread, feedState, oneSided, estDailyUsd }
 *   timeState— prior accrual state for this leg (or null)
 *   config   — loadNewsGuardConfig() (armed/killSwitch/cooldownMs/maxPerHour)
 *   rails    — { cooldownActive, hourlyCapReached } precomputed by the caller
 *   now      — epoch ms (caller-stamped)
 * Returns { status, timeState, record|null, consumesSlot }.
 */
function decideDrift({ leg, market, timeState, config, rails, now }) {
  const status = legStatus(leg, market.mid, market.maxSpread, now);
  const nextTime = accrue(timeState, status.inBandNow, now);
  const bandRadiusC = market.maxSpread > 0 ? market.maxSpread / 2 : null;

  const base = {
    type: 'reward-drift',
    ts: now,
    marketId: leg.marketId,
    venue: leg.venue,
    userId: leg.userId ?? null,
    leg: { book: leg.book, kind: leg.kind, price: leg.price, mode: leg.mode, offsetC: leg.offsetC },
    live: {
      mid: market.mid ?? null,
      feedState: market.feedState,
      targetPrice: status.targetPrice,
      driftC: status.driftC,
      inBandNow: status.inBandNow,
      neverEarns: status.neverEarns,
      bandRadiusC,
    },
    measured: {
      inBandSec: round(nextTime.inBandMs / 1000, 1),
      outBandSec: round(nextTime.outBandMs / 1000, 1),
    },
    executed: false,   // INVARIANT — drift is advisory; no execution path exists
    mode: 'shadow',    // INVARIANT
  };

  // ── suppression gates (priority order) ──
  if (config.killSwitch)
    return { status, timeState: nextTime, record: { ...base, decision: 'suppressed', reason: 'kill-switch (NEWS_GUARD_KILL=true)' }, consumesSlot: false };
  // Only trust a LIVE book to judge band membership — never accrue a drift event off
  // stale/REST-fallback data we can't see move.
  if (market.feedState !== 'live')
    return { status, timeState: nextTime, record: null, consumesSlot: false };
  // STRUCTURAL-BASELINE GATE: one-sided-by-construction ⇒ no band ⇒ no drift noise.
  if (market.oneSided)
    return { status, timeState: nextTime, record: { ...base, decision: 'calm', reason: 'structural: one-sided-by-construction — no two-sided band to drift from' }, consumesSlot: false };

  const sig = shouldSignal(timeState ? timeState.prevInBand : null, status, bandRadiusC);
  if (!sig.fire)
    return { status, timeState: nextTime, record: null, consumesSlot: false };
  if (rails.cooldownActive)
    return { status, timeState: nextTime, record: { ...base, decision: 'suppressed', reason: `cooldown active (<= ${config.cooldownMs}ms since last drift signal on this leg)` }, consumesSlot: false };
  if (rails.hourlyCapReached)
    return { status, timeState: nextTime, record: { ...base, decision: 'suppressed', reason: `hourly cap reached (${config.maxPerHour}/h)` }, consumesSlot: false };

  // ── the DriftSignal — advisory, shadow only ──
  return {
    status,
    timeState: nextTime,
    record: {
      ...base,
      decision: 'drift',
      reason: `${sig.reason} — advisory: re-quote by hand (disarmed, no order placed)`,
      rewardForgone: market.estDailyUsd != null
        ? { estOverOutBandUsd: forgoneUsd(market.estDailyUsd, nextTime.outBandMs), estDailyUsd: market.estDailyUsd, basis: 'from market rewardScore × placement capital, scaled by measured out-of-band time (first-order)' }
        : null,
    },
    consumesSlot: true,
  };
}

module.exports = { accrue, shouldSignal, forgoneUsd, decideDrift };
