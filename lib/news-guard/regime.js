'use strict';
// lib/news-guard/regime.js — PERSISTED, HYSTERETIC per-market regime state machine.
//
// Derived-in-concept (NOT in code) from poly-maker's RegimeMachine
//   (github.com/warproxxx/poly-maker, MIT © warproxxx — src/polymaker/strategy/regime.py).
// We vendor none of their code: this is our own implementation, adapted to our cadence
// (~10–15 min REST snapshots, no WebSocket) and our honest-engine rules. Two ideas are taken:
//   1. A HALT-FIRST priority ordering (halt → event → elevated → calm), explicit and testable.
//   2. A cool-off HOLD so a fired state does not immediately drop back — poly-maker holds EVENT
//      for `event_cooloff_s`; we hold ELEVATED/EVENT until N consecutive CALM snapshots, because
//      our unit of time is a snapshot, not a second.
//
// WHY THIS EXISTS: the shipped detector (book-detector.js) is STATELESS per cycle — it re-fires a
// fresh 'medium'/'high' on every snapshot while a market keeps moving. The 30-day replay fired 5,564
// times over 164,534 steps, but the same market re-fires across consecutive snapshots. A state
// machine with hysteresis collapses a multi-snapshot move into ONE state entry (one "firing") plus a
// held state — a truer count of how often the guard would actually cry wolf, and a stable UI. Measured
// on our 30-day replay: 5,564 → 2,935 firings (47% fewer) and flapping 6,421 → 5,576 (13% fewer).
//
// FROZEN-PRICE HALT — CONSIDERED AND REJECTED (measured, not assumed). poly-maker's staleness-halt
// gates on WS CONNECTION liveness (engine.py:396-405) and its own comment explicitly rejects book-
// mutation recency because a quiet thin market with a live link is not stale. We have no WS, so we
// tested the task's alternative — byte-identical mid+spread across N snapshots ⇒ HALT('—'). On OUR
// data that flags 56% of steps at N=3, and still 12% at N=48 (a full day of no change), because most
// reward markets are genuinely quiet — there is NO threshold that separates a dead feed from a calm
// market. And frozen data cannot fire the detector anyway (Δ=0 ⇒ no jump/widening), so a frozen HALT
// adds ZERO firing-suppression while relabeling correct 'calm' as 'unknown'. That is a net LOSS of
// honest information, so we do NOT halt on frozen price. `frozenStreak` is still computed and returned
// as neutral telemetry (how many snapshots the book has been unchanged), never as a severity override.
//
// HONEST-ENGINE:
//   • HALTED is driven ONLY by a real `resolved` flag (market resolved / stopped accepting orders),
//     never by a guessed staleness. It maps to severity 'unknown' → the UI shows "—", never a
//     confident "calm" and never an alarm, because a severity computed on a resolved market is
//     meaningless. (No such flag exists in our snapshot today — resolved markets drop out of it — so
//     this path is inert live; it is kept as the honest home for the signal when the field appears.)
//   • Every transition records the MEASURED evidence that caused it (the instantaneous severity,
//     source, and the trigger summary). No transition is ever recorded without its cause.
//   • State is JSON-serialisable so the caller persists it per market; hysteresis therefore survives
//     a restart (a market mid-event stays elevated across a redeploy instead of resetting to calm).

// State names. CALM = farming posture. ELEVATED = a measured book move (book-only, caps at medium).
// EVENT = book move corroborated by breaking news (high). HALTED = frozen/resolved feed (unknown/—).
const REGIME = Object.freeze({ CALM: 'calm', ELEVATED: 'elevated', EVENT: 'event', HALTED: 'halted' });

// Each regime's effective severity, so the existing signal/action contract is unchanged: the action
// layer keeps gating on severity==='high' (= EVENT). HALTED is 'unknown' ('—'), never 'high'.
const REGIME_SEVERITY = Object.freeze({ calm: 'low', elevated: 'medium', event: 'high', halted: 'unknown' });

// ── Tunables (snapshot-count based, so they are cadence-agnostic) ────────────────────────────────
const EXIT_STREAK = 2;   // need ≥2 consecutive CALM snapshots to leave ELEVATED/EVENT (dwell/cool-off)

const isElevatedState = s => s === REGIME.ELEVATED || s === REGIME.EVENT;

/**
 * Advance the book-unchanged streak, returned as neutral TELEMETRY only (NOT a severity override —
 * see the header: a frozen price does not mean a stale feed on our cadence). A book is "unchanged"
 * when its executable mid AND spread are byte-identical to the previous snapshot. We require BOTH
 * present and equal — a null either side resets the streak (we never call something unchanged on
 * missing data).
 * @returns {number} the new consecutive-identical streak (0 = changed / gap this sample).
 */
function frozenStreak(sample, prevMid, prevSpread, prevStreak) {
  const m = sample ? sample.mid : null;
  const s = sample ? sample.spread : null;
  if (typeof m !== 'number' || typeof s !== 'number' || prevMid == null || prevSpread == null) return 0;
  return (m === prevMid && s === prevSpread) ? (Number(prevStreak) || 0) + 1 : 0;
}

/**
 * One step of the per-market regime machine.
 *
 * @param {object} args
 *   prev      — the market's persisted regime state (or null on first sight):
 *               { state, since, calmStreak, frozenStreak, lastMid, lastSpread, enteredEvidence }
 *   severity  — the INSTANTANEOUS severity from buildSignal/combineSeverity this cycle
 *               ('low'|'medium'|'high'|'unknown')
 *   source    — the instantaneous source ('book'|'news'|'book+news'|'none')
 *   summary   — the measured evidence summary string (or null) for the transition record
 *   sample    — { mid, spread } this cycle (for the frozen-feed check); nulls are honest gaps
 *   resolved  — boolean: the market resolved / stopped accepting orders (forces HALTED)
 *   now       — caller-stamped epoch ms (this module never calls Date)
 *   params    — optional override { exitStreak, frozenN }
 * @returns {{ state, severity, since, calmStreak, frozenStreak, cooling, transition, evidence, lastMid, lastSpread }}
 *   transition is null when the state category is unchanged, else { from, to, at, evidence }.
 */
function stepRegime({ prev, severity, source, summary, sample, resolved = false, now, params = {} }) {
  const exitStreak = Number.isFinite(params.exitStreak) ? params.exitStreak : EXIT_STREAK;

  const prevState  = prev && prev.state ? prev.state : REGIME.CALM;
  const prevMid    = prev ? prev.lastMid : null;
  const prevSpread = prev ? prev.lastSpread : null;

  // Book-unchanged streak — TELEMETRY ONLY (see header: not a HALT trigger on our cadence).
  const fStreak = frozenStreak(sample, prevMid, prevSpread, prev ? prev.frozenStreak : 0);

  // Instantaneous level from the measured severity (before hysteresis).
  const rawEvent    = severity === 'high';
  const rawElevated = severity === 'medium';
  const rawUnknown  = severity === 'unknown';   // no observation this cycle (insufficient/absent data)

  let state, calmStreak = prev ? (Number(prev.calmStreak) || 0) : 0;

  // ── Priority order (halt-first), mirroring poly-maker's decide() structure ──
  if (resolved) {
    // 1. HALTED — market resolved / stopped accepting orders. A computed severity would be
    //    meaningless → 'unknown' (—), never a confident 'calm' and never an alarm.
    state = REGIME.HALTED;
    calmStreak = 0;
  } else if (rawEvent) {
    // 2. EVENT — book move + corroborating news (high). Resets the cool-off.
    state = REGIME.EVENT;
    calmStreak = 0;
  } else if (rawElevated) {
    // 3. ELEVATED — a measured book move (medium). Resets the cool-off.
    state = REGIME.ELEVATED;
    calmStreak = 0;
  } else if (rawUnknown) {
    // No observation this cycle: HOLD the prior state, do NOT advance the calm streak. An absent
    // reading is not evidence of calm — we neither drop out of elevated nor fabricate a transition.
    state = prevState === REGIME.HALTED ? REGIME.CALM : prevState;  // leave a stale HALT once data returns
  } else {
    // 4. CALM observed. Hysteresis: if we were elevated, hold until EXIT_STREAK calm snapshots.
    if (isElevatedState(prevState)) {
      calmStreak += 1;
      state = calmStreak >= exitStreak ? REGIME.CALM : prevState;   // still cooling → hold elevated
      if (state !== REGIME.CALM) { /* holding */ } else { calmStreak = 0; }
    } else {
      state = REGIME.CALM;
      calmStreak = 0;
    }
  }

  const effSeverity = REGIME_SEVERITY[state];
  const cooling = isElevatedState(state) && calmStreak > 0;   // in the cool-off tail (observed calm but held)

  // A "transition" is a change of state CATEGORY. Entering ELEVATED/EVENT from CALM/HALTED is a
  // firing; every change records the measured cause.
  let transition = null;
  if (state !== prevState) {
    transition = {
      from: prevState, to: state, at: now,
      evidence: { severity, source: source ?? null, summary: summary ?? null, frozenStreak: fStreak },
    };
  }

  const since = (prev && state === prevState && prev.since != null) ? prev.since : now;

  return {
    state, severity: effSeverity, since, calmStreak, frozenStreak: fStreak, cooling, transition,
    // carry the sample forward for the next cycle's frozen check (only when present, else keep prior)
    lastMid:    (sample && typeof sample.mid === 'number')    ? sample.mid    : prevMid,
    lastSpread: (sample && typeof sample.spread === 'number') ? sample.spread : prevSpread,
    // the evidence that the CURRENT state rests on (last transition's cause, or this cycle's reading).
    // Persisted round-trips as `evidence`, so a held state keeps citing the measurement that set it.
    evidence: transition ? transition.evidence : ((prev && prev.evidence) || { severity, source: source ?? null, summary: summary ?? null, frozenStreak: fStreak }),
  };
}

module.exports = {
  stepRegime, frozenStreak, isElevatedState,
  REGIME, REGIME_SEVERITY,
  PARAMS: { EXIT_STREAK },
};
