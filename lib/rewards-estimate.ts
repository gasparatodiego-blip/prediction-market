// lib/rewards-estimate.ts — pure, auditable liquidity-reward estimator.
//
// ONE function of record for "what would I earn posting a limit order near the mid
// on this reward market?", shared by the Liquidity Rewards tab (client) and any
// server route. No I/O, no globals, no Date/Math.random — deterministic given input.
//
// HONEST-ENGINE CONTRACT (see .claude/skills/honest-engine)
//   - Net $/day is the PRIMARY output. Annualized is demoted and capped at 200%/yr
//     ("run-rate, not guaranteed").
//   - Fill logic uses the REAL executable book (bid/ask depth), never a midpoint.
//   - Being filled is usually BAD: adverseSelectionCost is subtracted from gross so
//     the net reflects that farming rewards is not free money. Naive calculators that
//     skip this read 3–5× too high.
//   - Missing inputs return `null` with an explicit reason. Nothing is fabricated:
//     pool unknown → grossReward null; qualifying liquidity unknown → share null;
//     book depth unknown → fill/adverse/net null.
//
// The transparent model (all terms are auditable arithmetic, not a black box):
//   proximity  = 1 - (distance / maxSpread)^2        quadratic penalty, clamp [0,1]
//   sizeFactor = 1 two-sided | 0.5 single-sided | 0 single-sided when mid∉[0.10,0.90]
//   timeFactor = TIME_BASE × (1 - fillProbability)   filled orders stop resting/earning
//   score      = capital × proximity × sizeFactor × timeFactor
//   competitorTotal = qualifyingLiquidity × REF_PROXIMITY × TIME_BASE   (existing makers,
//                     assumed two-sided at a representative in-band distance)
//   shareOfPool = score / (competitorTotal + score)
//   grossReward = dailyPool × shareOfPool
//   fillProbability   from real book depth vs capital and distance (thin+tight+big → higher)
//   adverseSelectionCost = fillProbability × capital × expectedAdverseMove
//   netPerDay   = grossReward - adverseSelectionCost      ← primary
//   annualized  = min(netPerDay/capital × 365 × 100, 200) ← demoted, run-rate
//
// All numeric defaults (TIME_BASE 0.83, 2–5% conservative adverse band, $1 floor,
// 200%/yr cap) are the task/honest-engine constants — not new magic thresholds.

// ── Tunable constants (task + honest-engine defaults) ────────────────────────
export const TIME_BASE            = 0.83;   // fraction of the UTC day an order rests if never filled
export const REF_PROXIMITY        = 0.75;   // existing makers assumed at distance ≈ maxSpread/2 → 1-0.25
export const MIN_PAYOUT_USD       = 1.0;    // Polymarket/Kalshi do not pay below $1/day
export const ANNUALIZED_CAP_PCT   = 200;    // honest-engine annualized ceiling
export const FILL_PROB_CAP        = 0.90;   // a resting maker is never ~certain to be adversely filled
export const ADVERSE_FLOOR        = 0.02;   // conservative expected adverse move, low end (2%)
export const ADVERSE_CEIL         = 0.05;   // conservative expected adverse move, high end (5%)
export const MARKET_VOL_MIN       = 0.005;  // clamp measured 24h stdev into a sane per-fill move band
export const MARKET_VOL_MAX       = 0.10;
// Kalshi exposes no reward band; use a nominal half-range so distance-based terms
// degrade gracefully (Kalshi's observed model is flat pro-rata with no proximity weight).
export const KALSHI_NOMINAL_BAND  = 50;     // cents

export type Venue = 'polymarket' | 'kalshi';

export interface MarketSnapshot {
  venue:               Venue;
  midpoint:            number | null;   // 0..1
  maxSpread:           number | null;   // cents (full band); null for Kalshi
  minSize:             number | null;   // shares
  dailyPool:           number | null;   // real $/day, null when genuinely unknown
  qualifyingLiquidity: number | null;   // USD of existing two-sided qualifying makers
  bookDepthAtBand:     number | null;   // USD resting near the band (fill-prob input)
  volatilityStdev?:    number | null;   // measured 24h price-fraction stdev (Polymarket)
  twoSidedRequired?:   boolean;         // true when mid∉[0.10,0.90]
}

export interface EstimateInput {
  venue:         Venue;
  capital:       number;   // USD deployed (across both sides if two-sided)
  twoSided:      boolean;
  distanceCents: number;   // distance from mid, in cents, where you rest your order
  market:        MarketSnapshot;
}

export interface EstimateResult {
  // primary
  netPerDay:            number | null;
  // components (all auditable)
  proximity:            number;
  sizeFactor:           number;
  timeFactor:           number;
  score:                number;
  competitorTotal:      number | null;
  shareOfPool:          number | null;
  fillProbability:      number | null;
  expectedAdverseMove:  number | null;
  adverseMoveSource:    'market-vol' | 'conservative-default' | 'unknown';
  grossReward:          number | null;
  adverseSelectionCost: number | null;
  // demoted
  dayYieldPct:          number | null;
  annualizedPct:        number | null;   // capped at ANNUALIZED_CAP_PCT
  annualizedCapped:     boolean;
  annualizedLabel:      string;
  // flags / honesty
  belowMinPayout:       boolean;
  twoSidedRequired:     boolean;
  reasons:              string[];        // why any field is null / notable caveats
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// proximity = 1 - (distance/maxSpread)^2, clamped. Kalshi (no band) → 1 (flat model).
export function proximityFactor(distanceCents: number, maxSpread: number | null): number {
  if (maxSpread == null || maxSpread <= 0) return 1;             // Kalshi flat pro-rata: no proximity weight
  const d = clamp(distanceCents / maxSpread, 0, 1);
  return clamp(1 - d * d, 0, 1);
}

// sizeFactor: two-sided pays full; single-sided pays half; single-sided scores 0 when
// mid is outside [0.10,0.90] (Polymarket rule — two-sided is REQUIRED there).
export function sizeFactorFor(twoSided: boolean, midpoint: number | null): number {
  if (twoSided) return 1;
  if (midpoint != null && (midpoint < 0.10 || midpoint > 0.90)) return 0;
  return 0.5;
}

// Fill probability from the REAL book: your capital vs resting depth, weighted by how
// tight to the mid you sit. Thin book + tight quote + large size ⇒ more likely filled.
// null when book depth is unknown (never invented).
export function fillProbabilityFor(
  capital: number,
  bookDepthAtBand: number | null,
  distanceCents: number,
  maxSpread: number | null,
): number | null {
  if (bookDepthAtBand == null) return null;
  const sizePressure = capital > 0 ? capital / (capital + bookDepthAtBand) : 0;
  const band = maxSpread != null && maxSpread > 0 ? maxSpread : KALSHI_NOMINAL_BAND;
  const tightness = clamp(1 - distanceCents / band, 0, 1);       // closer to mid → more fills
  const p = sizePressure * (0.5 + 0.5 * tightness);
  return clamp(p, 0, FILL_PROB_CAP);
}

// Expected per-fill adverse price move (fraction). Uses the market's own 24h vol when
// present; otherwise a conservative 2–5% band scaled by tightness (tighter quotes are
// picked off harder). Returns which source was used so the UI can be honest about it.
export function expectedAdverseMoveFor(
  volatilityStdev: number | null | undefined,
  distanceCents: number,
  maxSpread: number | null,
): { move: number; source: 'market-vol' | 'conservative-default' } {
  if (volatilityStdev != null && isFinite(volatilityStdev) && volatilityStdev > 0) {
    return { move: clamp(volatilityStdev, MARKET_VOL_MIN, MARKET_VOL_MAX), source: 'market-vol' };
  }
  const band = maxSpread != null && maxSpread > 0 ? maxSpread : KALSHI_NOMINAL_BAND;
  const tightness = clamp(1 - distanceCents / band, 0, 1);
  const move = ADVERSE_FLOOR + (ADVERSE_CEIL - ADVERSE_FLOOR) * tightness;
  return { move, source: 'conservative-default' };
}

export function estimateReward(input: EstimateInput): EstimateResult {
  const { capital, twoSided, distanceCents, market } = input;
  const { midpoint, maxSpread, dailyPool, qualifyingLiquidity, bookDepthAtBand } = market;
  const reasons: string[] = [];

  const twoSidedRequired = market.twoSidedRequired
    ?? (midpoint != null && (midpoint < 0.10 || midpoint > 0.90));

  const dist       = Math.max(0, distanceCents);
  const proximity  = proximityFactor(dist, maxSpread);
  const sizeFactor = sizeFactorFor(twoSided, midpoint);
  if (sizeFactor === 0) {
    reasons.push('single-sided order scores 0 here — mid is outside [0.10, 0.90], two-sided is required');
  }

  const fillProbability = fillProbabilityFor(capital, bookDepthAtBand, dist, maxSpread);
  if (fillProbability == null) reasons.push('book depth unknown — fill probability, adverse cost and net cannot be computed');

  // timeFactor shrinks with fill probability: a filled order is no longer resting.
  const timeFactor = TIME_BASE * (1 - (fillProbability ?? 0));

  const score = capital * proximity * sizeFactor * timeFactor;

  // competitor denominator, derived once from real qualifying liquidity.
  let competitorTotal: number | null = null;
  let shareOfPool: number | null = null;
  if (qualifyingLiquidity == null) {
    reasons.push('qualifying liquidity unknown — pool share cannot be computed');
  } else {
    competitorTotal = qualifyingLiquidity * REF_PROXIMITY * TIME_BASE;
    const denom = competitorTotal + score;
    shareOfPool = denom > 0 ? score / denom : (score > 0 ? 1 : 0);
  }

  // gross reward
  let grossReward: number | null = null;
  if (dailyPool == null) {
    reasons.push('pool unknown — gross reward cannot be computed');
  } else if (shareOfPool != null) {
    grossReward = dailyPool * shareOfPool;
  }

  // adverse-selection cost
  const adv = expectedAdverseMoveFor(market.volatilityStdev, dist, maxSpread);
  let expectedAdverseMove: number | null = null;
  let adverseMoveSource: EstimateResult['adverseMoveSource'] = 'unknown';
  let adverseSelectionCost: number | null = null;
  if (fillProbability != null) {
    expectedAdverseMove  = adv.move;
    adverseMoveSource    = adv.source;
    adverseSelectionCost = fillProbability * capital * adv.move;
  }

  // net = gross - adverse. Null if either side is unknown.
  let netPerDay: number | null = null;
  if (grossReward != null && adverseSelectionCost != null) {
    netPerDay = grossReward - adverseSelectionCost;
  } else if (grossReward != null && fillProbability == null) {
    // We know gross but not the adverse cost — do NOT publish a net that ignores risk.
    reasons.push('net withheld: adverse-selection cost unknown, so a net that ignores fill risk would overstate');
  }

  const belowMinPayout = grossReward != null && grossReward < MIN_PAYOUT_USD;
  if (belowMinPayout) reasons.push(`gross < $${MIN_PAYOUT_USD}/day — below the minimum daily payout; likely earns nothing`);

  // demoted annualized (capped, labeled)
  let dayYieldPct: number | null = null;
  let annualizedPct: number | null = null;
  let annualizedCapped = false;
  if (netPerDay != null && capital > 0) {
    dayYieldPct = (netPerDay / capital) * 100;
    const raw = dayYieldPct * 365;
    annualizedPct = Math.min(raw, ANNUALIZED_CAP_PCT);
    annualizedCapped = raw > ANNUALIZED_CAP_PCT;
  }
  const annualizedLabel = annualizedCapped
    ? `>${ANNUALIZED_CAP_PCT}%/yr · run-rate, not guaranteed`
    : 'run-rate, not guaranteed';

  return {
    netPerDay:            round(netPerDay, 4),
    proximity:            round(proximity, 4)!,
    sizeFactor,
    timeFactor:           round(timeFactor, 4)!,
    score:                round(score, 4)!,
    competitorTotal:      round(competitorTotal, 2),
    shareOfPool:          round(shareOfPool, 6),
    fillProbability:      round(fillProbability, 4),
    expectedAdverseMove:  round(expectedAdverseMove, 5),
    adverseMoveSource,
    grossReward:          round(grossReward, 4),
    adverseSelectionCost: round(adverseSelectionCost, 4),
    dayYieldPct:          round(dayYieldPct, 4),
    annualizedPct:        round(annualizedPct, 2),
    annualizedCapped,
    annualizedLabel,
    belowMinPayout,
    twoSidedRequired,
    reasons,
  };
}

function round(n: number | null, dp: number): number | null {
  if (n == null || !isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
