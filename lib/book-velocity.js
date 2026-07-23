'use strict';

/**
 * BOOK VELOCITY — depth-normalised executable-price movement, with an explicit
 * REVERTING vs PERSISTENT split.
 *
 * WHY THIS EXISTS
 *   For a liquidity provider, a fast one-directional price move is adverse selection
 *   in progress: resting orders are about to be picked off at a stale price. The book
 *   is the fastest free signal for that. This module turns a series of book snapshots
 *   into that signal. It computes nothing else and fetches nothing.
 *
 * Imported by:
 *   agents/agent36-book-velocity.js  (require '../lib/book-velocity')
 *
 * ── HONEST-ENGINE CONTRACT ────────────────────────────────────────────────────
 *   • EXECUTABLE PRICES ONLY. Every number here comes from best bid / best ask and
 *     the size resting at those two levels. Mid is never used as the movement input.
 *     A maker cares where they would actually get filled, and mid is a fiction that
 *     moves when only one side moves.
 *   • NO INFERENCE FROM MISSING DATA. A snapshot with a missing/NaN/non-positive
 *     price or size, a crossed book (bid >= ask), or an out-of-range price is
 *     INVALID and produces `null` — never a zero, never a carried-forward value.
 *     Unknown book → no signal, full stop.
 *   • NO THIN-BOOK RE-DERIVATION. `thinBook` is an INPUT to this module, never
 *     computed here. It is the flag agent24 (`levels[].thinBookFlag` / `flags[]`)
 *     and agent25 (`flags.THIN_CAP`) already emit and that lib/reward-gating.ts
 *     gates on (isSanePolymarketLevel / isSaneKalshiMarket). This module is a plain
 *     Node script and cannot import the .ts gate, so it does not try to: it consumes
 *     the flag the gate consumes rather than re-implementing the 2%/day rule.
 *   • PURE. No I/O, no clock, no global state. Every function is a deterministic
 *     transform of its arguments, so the whole detector is node-testable offline
 *     against recorded history.
 *
 * ── THE THREE DEFINITIONS, AND WHY ────────────────────────────────────────────
 *
 * 1. DIRECTIONAL EXECUTABLE MOVE (cents)
 *      dBid = bid(t1) - bid(t0)
 *      dAsk = ask(t1) - ask(t0)
 *      move = sign-consistent component:
 *               same sign → sign * min(|dBid|, |dAsk|)
 *               opposite  → 0
 *    Both executable sides must move the SAME way before we call it a price move.
 *    If the bid falls while the ask rises, the book did not move — it widened. That
 *    is liquidity withdrawal, a different event with a different response, and
 *    counting it as velocity would fire on every spread flare. Taking the MIN of the
 *    two magnitudes is deliberately the conservative reading: we credit only the
 *    movement both sides confirm.
 *
 * 2. DEPTH NORMALISATION
 *      weight = ln(1 + depthUsd / minSizeUsd)
 *      nv     = |moveCents| * weight / horizonMinutes        [cent-weights per minute]
 *
 *    A 10c move on a $4 book and a 10c move on a $5,000 book are not the same event,
 *    so the metric must not score them the same. The distinguishing fact is how much
 *    resting liquidity was run over to produce the move: $4 is one small order and no
 *    maker with real size was hurt; $5,000 means five thousand dollars of resting
 *    liquidity got lifted at the old price and a maker WAS picked off. So severity
 *    must RISE with depth, not fall — this is not a "divide by size" normalisation.
 *
 *    It rises sub-linearly (log), because the difference between a $4 book and a $500
 *    book is enormous while the difference between $5,000 and $10,000 is marginal.
 *
 *    The anchor `minSizeUsd` is NOT a tuned constant: it is the reward program's own
 *    minimum qualifying order size, already carried per-market by agent24 (`minSize`)
 *    and agent25 (`min_size`). That is exactly the size the LP has at risk in this
 *    market, which makes it the only non-arbitrary unit of "is this book big enough
 *    for the move to matter to me". Consequences:
 *      depth == the program minimum  → weight = ln 2  ≈ 0.69
 *      depth == 10x the minimum      → weight = ln 11 ≈ 2.40
 *      depth == $4 against a $200 min→ weight = ln 1.02 ≈ 0.02  (self-suppressing)
 *    So a book too thin to hold a qualifying order is damped ~35x relative to a book
 *    at the minimum, before the explicit thin-book flag is even consulted.
 *
 *    Depth is taken on the side that was CONSUMED (the side the price moved away
 *    from), measured at t0 — the liquidity that actually stood there before the move,
 *    not what is left after.
 *
 * 3. REVERTING vs PERSISTENT
 *      retention = (px(t1 + hold) - px(t0)) / (px(t1) - px(t0))
 *      PERSISTENT  when retention >= retentionMin
 *      REVERTING   when retention <  retentionMin
 *      UNKNOWN     when there is no valid book at t1 + hold  (never guessed)
 *    A move that snaps back is noise a maker profits from — they collect the spread
 *    and the price returns. A move that holds is information, and the maker's fill
 *    is permanently wrong. Only PERSISTENT is adverse selection. `holdMs` and
 *    `retentionMin` are calibrated from recorded history (see scripts/), never guessed.
 *
 * ── CALIBRATED DEFAULTS ───────────────────────────────────────────────────────
 * Derived in Phase 2 from 162,654 recorded Kalshi/Polymarket book snapshots
 * (data/sport-raw, 45s cadence, 75.3h) plus a live 10s recording of the exact
 * agent24+agent25 reward market set. See DEFAULTS below for each value's provenance.
 */

// ── Structural limits (not tuned; these are facts about binary prediction books) ──
const MIN_PRICE = 0;
const MAX_PRICE = 1;

/**
 * Calibrated tunables. Every one of these is set from the recorded-history study in
 * scripts/book-velocity-calibrate.js — see FINAL REPORT for the distributions.
 */
const DEFAULTS = {
  /** Comparison horizon. 60s because the best recorded cadence on the venues we
   *  quote on is 45s (data/sport-raw, p10=p50=p90=45s); no threshold is claimed at
   *  a horizon the recorded data cannot evidence. The live agent samples faster
   *  than this — that buys resolution inside the window, not a shorter horizon. */
  horizonMs: 60_000,

  /** Forward window used to decide revert-vs-hold.
   *  CALIBRATED: over the 162,654-snapshot corpus, the share of extreme moves that
   *  hold is flat from 60s (89.5%) to 180s (87.3%) and then degrades — 300s 85.5%,
   *  600s 76.5%. That knee is where genuine mean-reversion starts to dominate, so
   *  180s is the longest window that still separates noise from information. It is
   *  also the longest window that leaves the alert operationally useful: telling a
   *  maker about adverse selection ten minutes late is worthless. */
  holdMs: 180_000,

  /** Fraction of the move that must survive `holdMs` to count as PERSISTENT.
   *  Half the move is the natural break: above it the maker's fill is still wrong,
   *  below it the spread they collected has largely paid for the excursion. */
  retentionMin: 0.5,

  /** Alert threshold on normalised velocity, in cent-weights per minute.
   *  CALIBRATED to p84.3 of the nv distribution over the 9,852 moved pairs in the
   *  75.3h corpus — the top ~16% of moves that actually occur. What it demands in
   *  raw terms on the real reward population, at 60s:
   *      deep Polymarket book  ($4.0k at touch, $50 min)  → >= 2.3c
   *      typical Polymarket    ($407,          $50 min)   → >= 4.5c
   *      deep Kalshi           ($2.8k,         $1k min)   → >= 7.6c
   *      thin Kalshi           ($115,          $1k min)   → >= 92c, i.e. never
   *  Expected fire rate, from the 17-day executable-move ceiling measured on the
   *  real reward population (scripts/book-velocity-baserate.js): Polymarket needs
   *  >=3c → 5.2/day ceiling, Kalshi needs >=8c → 5.1/day ceiling, combined 10.3/day.
   *  Times the 66% persistent share leaves ~6.8/day, before the 60s-horizon
   *  restriction (the ceiling counts 30-minute drifts a 60s detector cannot see)
   *  and before the per-market cooldown. A handful per day, which is the target. */
  nvThreshold: 10.0,

  /** Floor on the raw executable move. Below this the move is one tick of quote
   *  jitter and no depth weighting should be able to promote it into an alert.
   *  At nvThreshold 10 this only binds where depth/minSize exceeds e^10-1 (~22,025)
   *  — about $881k at the touch against a $40 minimum. Below that a sub-tick move
   *  cannot reach the threshold anyway, so the floor is a backstop, not a filter. */
  minMoveCents: 1.0,

  /** Snapshots older than this cannot be paired — a gap means we did not observe
   *  the path between them, so any "move" across it is an artifact of absence. */
  maxPairGapMs: 150_000,
};

// ── helpers ──────────────────────────────────────────────────────────────────
function isFinitePositive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
function isFiniteNonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate one book snapshot. Returns null (never a partial/patched object) when
 * anything required is missing or incoherent — the "unknown book → no signal" rule.
 *
 * @param {{t:number,bid:number,ask:number,bidSz:number,askSz:number}} s
 * @returns {null|{t:number,bid:number,ask:number,bidSz:number,askSz:number}}
 */
function normalizeSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  const { t, bid, ask, bidSz, askSz } = s;
  // A timestamp only has to be a finite number; ordering sanity is enforced by the
  // elapsedMs > 0 check in velocityPair, not by an arbitrary "must be positive".
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (!isFinitePositive(bid) || !isFinitePositive(ask)) return null;
  // Sizes may legitimately be 0 only if the level is absent — which means no
  // executable price at all, so a 0 size invalidates the snapshot rather than
  // silently contributing a zero-depth weight.
  if (!isFinitePositive(bidSz) || !isFinitePositive(askSz)) return null;
  if (bid <= MIN_PRICE || ask <= MIN_PRICE) return null;
  if (bid >= MAX_PRICE || ask >= MAX_PRICE) return null;
  if (bid >= ask) return null;                    // crossed or locked → not executable
  return { t, bid, ask, bidSz, askSz };
}

/**
 * Sign-consistent executable move, in CENTS. See definition (1) above.
 * @returns {{moveCents:number, dBidCents:number, dAskCents:number, direction:-1|0|1}}
 */
function executableMove(prev, curr) {
  const dBid = (curr.bid - prev.bid) * 100;
  const dAsk = (curr.ask - prev.ask) * 100;
  let moveCents = 0;
  if (dBid > 0 && dAsk > 0)      moveCents =  Math.min(dBid, dAsk);
  else if (dBid < 0 && dAsk < 0) moveCents = -Math.min(-dBid, -dAsk);
  // else: spread widened/narrowed without a directional shift → 0, by design.
  const direction = moveCents > 0 ? 1 : moveCents < 0 ? -1 : 0;
  return { moveCents, dBidCents: dBid, dAskCents: dAsk, direction };
}

/**
 * USD resting at the touch on the side that gets CONSUMED by a move in `direction`,
 * measured on the earlier snapshot. Price rising ⇒ asks were lifted; price falling
 * ⇒ bids were hit.
 */
function consumedDepthUsd(prev, direction) {
  if (direction > 0) return prev.ask * prev.askSz;
  if (direction < 0) return prev.bid * prev.bidSz;
  return 0;
}

/**
 * Depth weight, definition (2). `minSizeUsd` is the reward program's minimum
 * qualifying size for this market; when it is unknown we cannot form the ratio and
 * therefore return null rather than substituting a guessed anchor.
 * @returns {number|null}
 */
function depthWeight(depthUsd, minSizeUsd) {
  if (!isFiniteNonNeg(depthUsd)) return null;
  if (!isFinitePositive(minSizeUsd)) return null;
  return Math.log1p(depthUsd / minSizeUsd);
}

/**
 * Normalised velocity for one pair of snapshots.
 *
 * @param {object} prev  raw snapshot at t0
 * @param {object} curr  raw snapshot at t1
 * @param {{minSizeUsd:number, maxPairGapMs?:number}} ctx
 * @returns {null|{
 *   t0:number,t1:number,elapsedMs:number,
 *   bid0:number,ask0:number,bid1:number,ask1:number,
 *   bidSz0:number,askSz0:number,bidSz1:number,askSz1:number,
 *   moveCents:number,dBidCents:number,dAskCents:number,direction:number,
 *   depthUsd0:number,depthUsd1:number,depthWeight:number,nv:number
 * }}
 *   null whenever either book is unreadable, the gap is too large to have observed
 *   the path, or minSizeUsd is unknown. Never a fabricated zero.
 */
function velocityPair(prev, curr, ctx) {
  const a = normalizeSnapshot(prev);
  const b = normalizeSnapshot(curr);
  if (!a || !b) return null;

  const elapsedMs = b.t - a.t;
  if (elapsedMs <= 0) return null;
  const maxGap = ctx && isFinitePositive(ctx.maxPairGapMs) ? ctx.maxPairGapMs : DEFAULTS.maxPairGapMs;
  if (elapsedMs > maxGap) return null;            // unobserved path → no signal

  const mv = executableMove(a, b);
  const depthUsd0 = consumedDepthUsd(a, mv.direction);
  const depthUsd1 = consumedDepthUsd(b, mv.direction);
  const w = depthWeight(depthUsd0, ctx && ctx.minSizeUsd);
  if (w === null) return null;                    // unknown qualifying size → no signal

  const minutes = elapsedMs / 60_000;
  const nv = (Math.abs(mv.moveCents) * w) / minutes;

  return {
    t0: a.t, t1: b.t, elapsedMs,
    bid0: a.bid, ask0: a.ask, bid1: b.bid, ask1: b.ask,
    bidSz0: a.bidSz, askSz0: a.askSz, bidSz1: b.bidSz, askSz1: b.askSz,
    moveCents: mv.moveCents, dBidCents: mv.dBidCents, dAskCents: mv.dAskCents,
    direction: mv.direction,
    depthUsd0, depthUsd1, depthWeight: w, nv,
  };
}

/**
 * Classify a detected move as PERSISTENT / REVERTING once the hold window has
 * elapsed. Uses the SAME executable side that moved, so the revert test is measured
 * where the maker would actually be filled.
 *
 * @param {object} pair    output of velocityPair()
 * @param {object} future  raw snapshot at >= pair.t1 + holdMs
 * @param {{holdMs?:number, retentionMin?:number}} [opts]
 * @returns {{state:'PERSISTENT'|'REVERTING'|'UNKNOWN', retention:number|null, pxHold:number|null, holdElapsedMs:number|null}}
 */
function classifyHold(pair, future, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const f = normalizeSnapshot(future);
  if (!pair || !f) return { state: 'UNKNOWN', retention: null, pxHold: null, holdElapsedMs: null };

  const holdElapsedMs = f.t - pair.t1;
  if (holdElapsedMs < o.holdMs) return { state: 'UNKNOWN', retention: null, pxHold: null, holdElapsedMs };

  // Follow the executable side the move consumed: an up-move is judged on the ask
  // (where a resting maker ask got lifted), a down-move on the bid.
  const px = q => (pair.direction > 0 ? q.ask : q.bid);
  const px0 = pair.direction > 0 ? pair.ask0 : pair.bid0;
  const px1 = pair.direction > 0 ? pair.ask1 : pair.bid1;
  const denom = px1 - px0;
  if (denom === 0) return { state: 'UNKNOWN', retention: null, pxHold: px(f), holdElapsedMs };

  const retention = (px(f) - px0) / denom;
  return {
    state: retention >= o.retentionMin ? 'PERSISTENT' : 'REVERTING',
    retention,
    pxHold: px(f),
    holdElapsedMs,
  };
}

/**
 * Should this pair fire an alert?
 * Thin-book markets are FLAGGED, not silently dropped — the caller decides, and the
 * alert text says so. `thinBook` is agent24/agent25's already-computed flag (the one
 * lib/reward-gating.ts gates on); it is never derived here.
 *
 * @param {object} pair
 * @param {{nvThreshold?:number, minMoveCents?:number}} [opts]
 */
function isDetection(pair, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!pair) return false;
  if (pair.direction === 0) return false;
  if (Math.abs(pair.moveCents) < o.minMoveCents) return false;
  return pair.nv >= o.nvThreshold;
}

/**
 * Scan one market's ordered snapshot series and return every detection, each already
 * classified PERSISTENT/REVERTING/UNKNOWN against the forward hold window.
 *
 * Pure and offline-replayable: this is the exact function used to calibrate the
 * thresholds against recorded history AND the one the live agent calls, so the
 * shipped detector and the backtest cannot drift apart.
 *
 * @param {Array<object>} samples  raw snapshots, ascending by t
 * @param {{minSizeUsd:number, thinBook?:boolean}} ctx
 * @param {object} [opts] overrides of DEFAULTS
 * @returns {Array<object>} detections
 */
function scanSeries(samples, ctx, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (!Array.isArray(samples) || samples.length < 2) return [];

  // Keep only readable snapshots; an unreadable one is a hole, not a data point.
  const s = samples.map(normalizeSnapshot).filter(Boolean).sort((x, y) => x.t - y.t);
  if (s.length < 2) return [];

  const out = [];
  let j = 0;      // left edge of the horizon window
  for (let i = 1; i < s.length; i++) {
    // Advance j to the oldest snapshot still within horizonMs of s[i].
    while (j < i && s[i].t - s[j].t > o.horizonMs) j++;
    if (j === i) continue;
    // Prefer the sample closest to exactly horizonMs back, so the measured elapsed
    // time is as near the calibrated horizon as the data allows.
    let best = j;
    for (let k = j; k < i; k++) {
      if (Math.abs((s[i].t - s[k].t) - o.horizonMs) < Math.abs((s[i].t - s[best].t) - o.horizonMs)) best = k;
    }
    const pair = velocityPair(s[best], s[i], { minSizeUsd: ctx && ctx.minSizeUsd, maxPairGapMs: o.maxPairGapMs });
    if (!pair) continue;
    if (!isDetection(pair, o)) continue;

    // Forward-looking hold classification: first snapshot at or past t1 + holdMs.
    let hold = { state: 'UNKNOWN', retention: null, pxHold: null, holdElapsedMs: null };
    for (let k = i + 1; k < s.length; k++) {
      if (s[k].t - pair.t1 >= o.holdMs) { hold = classifyHold(pair, s[k], o); break; }
    }
    out.push({ ...pair, ...hold, thinBook: !!(ctx && ctx.thinBook) });
  }
  return out;
}

module.exports = {
  DEFAULTS,
  normalizeSnapshot,
  executableMove,
  consumedDepthUsd,
  depthWeight,
  velocityPair,
  classifyHold,
  isDetection,
  scanSeries,
};
