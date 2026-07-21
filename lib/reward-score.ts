// lib/reward-score.ts — pure, shared liquidity-reward SCORING for the detail-page placement
// ticket. SINGLE SOURCE OF TRUTH for "given the exact orders I place (per side, per price
// level), what share of the reward pool and what gross $/day do I earn?"
//
// AGREEMENT WITH THE LIST IS NON-NEGOTIABLE (honest-engine): the list view
// (lib/liquidity-yield.ts, via RewardsUnified) prices a market at balance B as
//     share = B / (competitorDepth + B),  dailyUsd = pool × share
// where competitorDepth is BOTH sides' in-band qualifying depth summed. This module REUSES
// computeLiquidityYield so the detail ticket can never disagree with the list: when the user
// places capital B, balanced two-sided, in-band at the mid (proximity 1), the ticket's dailyUsd
// equals the list's dailyUsd for the same market at the same capital. See scripts/assert-reward-score.js.
//
// The two venue mechanics (both verified against source — see the list commits):
//   • Polymarket: quadratic distance-from-mid weighting  proximity = ((v − s)/v)²  (v = maxSpread,
//     s = distance from mid, in cents), in-band only. Two-sided quoting earns full credit; ONE-sided
//     quoting earns a ÷3 penalty when the mid ∈ [0.10, 0.90], and earns NOTHING when the mid is
//     outside that band (two-sided required). This is Polymarket/polymarket-liq-mining's Qmin =
//     max(min(Qbid,Qask), max(Qbid,Qask)/3) rule, expressed at the aggregate the list dilutes against.
//   • Kalshi: flat pro-rata, no proximity weighting; both sides pool into one score; no ÷3 penalty.
//
// PURE: no I/O, no Date/Math.random, deterministic given input. Missing pool/depth ⇒ dailyUsd null.

import { computeLiquidityYield } from './liquidity-yield';

export const ONE_SIDED_PENALTY = 3;     // Polymarket ÷3 credit when quoting a single side (mid in band)
export const MID_BAND_LO_C     = 10;    // cents — below this (or above HI) Polymarket REQUIRES two sides
export const MID_BAND_HI_C     = 90;    // cents

export type Venue = 'polymarket' | 'kalshi';

/** One resting order the user plans: `sizeUsd` at `priceCents`. */
export interface LevelAlloc { priceCents: number; sizeUsd: number }

export interface RewardScoreInput {
  venue:      Venue;
  midCents:   number;          // executable mid (cents), computed from best bid/ask — never mid-of-nothing
  maxSpreadC: number;          // reward band half-width in cents (Polymarket real; Kalshi nominal)
  pool:       number | null;   // reward pool $/day (null ⇒ dailyUsd null, never fabricated)
  // BOTH-sides in-band qualifying depth you dilute against — feed the SAME number the list used
  // (snapshot bookDepthAtBand + opposite side) so the ticket and the list agree exactly.
  competitorDepthUsd: number | null;
  // Your planned orders, per outcome side. Out-of-band levels are ignored (earn nothing).
  yes: LevelAlloc[];
  no:  LevelAlloc[];
}

export interface RewardScoreResult {
  yesScore:       number;       // in-band, proximity-weighted USD you contribute on the YES side
  noScore:        number;       // …on the NO side
  minSideScore:   number;       // min(yesScore, noScore) — the two-sided binding side (display/guidance)
  effectiveScore: number;       // the pooled score that actually dilutes (== capital at mid, balanced)
  penaltyApplied: boolean;      // Polymarket ÷3 one-sided penalty is in force
  twoSidedRequiredUnmet: boolean; // one-sided while mid outside [0.10,0.90] ⇒ earns nothing
  capital:        number;       // total USD you placed (in- AND out-of-band)
  share:          number;       // effectiveScore / (competitorDepth + effectiveScore)
  dailyUsd:       number | null;// pool × share (null when pool/depth missing)
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Quadratic in-band proximity for a single order. 1 at the mid, 0 at the band edge and beyond. */
function proximity(priceCents: number, midCents: number, maxSpreadC: number, venue: Venue): number {
  const s = Math.abs(priceCents - midCents);
  if (!(maxSpreadC > 0) || s > maxSpreadC) return 0;          // out of band ⇒ earns nothing
  if (venue === 'kalshi') return 1;                            // flat pro-rata: no distance weighting
  const p = (maxSpreadC - s) / maxSpreadC;                     // Polymarket quadratic ((v−s)/v)²
  return Math.max(0, Math.min(1, p * p));
}

function sideScore(levels: LevelAlloc[], midCents: number, maxSpreadC: number, venue: Venue): number {
  let sum = 0;
  for (const lv of levels) {
    if (!finite(lv.sizeUsd) || lv.sizeUsd <= 0 || !finite(lv.priceCents)) continue;
    sum += lv.sizeUsd * proximity(lv.priceCents, midCents, maxSpreadC, venue);
  }
  return sum;
}

export function computeRewardScore(input: RewardScoreInput): RewardScoreResult {
  const { venue, midCents, maxSpreadC, pool, competitorDepthUsd } = input;
  const yesScore = sideScore(input.yes ?? [], midCents, maxSpreadC, venue);
  const noScore  = sideScore(input.no  ?? [], midCents, maxSpreadC, venue);
  const capital  = [...(input.yes ?? []), ...(input.no ?? [])]
    .reduce((a, l) => a + (finite(l.sizeUsd) && l.sizeUsd > 0 ? l.sizeUsd : 0), 0);
  const minSideScore = Math.min(yesScore, noScore);

  const bothSides = yesScore > 0 && noScore > 0;
  const oneSide   = (yesScore > 0) !== (noScore > 0);
  const midInBand = midCents >= MID_BAND_LO_C && midCents <= MID_BAND_HI_C;

  // Pooled effective score that dilutes against competitorDepth. Balanced two-sided at the mid
  // ⇒ effective == capital ⇒ share == list. Polymarket one-sided applies the ÷3 penalty (mid in
  // band) or earns nothing (mid outside band, two-sided required). Kalshi pools both sides flat.
  let effectiveScore: number;
  let penaltyApplied = false;
  let twoSidedRequiredUnmet = false;
  if (venue === 'kalshi') {
    effectiveScore = yesScore + noScore;                       // flat pro-rata pools both sides
  } else if (bothSides) {
    effectiveScore = yesScore + noScore;                       // full two-sided credit
  } else if (oneSide) {
    if (midInBand) { effectiveScore = Math.max(yesScore, noScore) / ONE_SIDED_PENALTY; penaltyApplied = true; }
    else           { effectiveScore = 0; twoSidedRequiredUnmet = true; }
  } else {
    effectiveScore = 0;                                        // nothing placed in-band
  }

  // Dilute via the list's SSOT. competitorDepthUsd is the both-sides depth (Q); no venue cap.
  const y = computeLiquidityYield({
    poolPerDay: pool, cap: null, qualifyingLiquidity: competitorDepthUsd, balance: effectiveScore,
  });

  return {
    yesScore,
    noScore,
    minSideScore,
    effectiveScore,
    penaltyApplied,
    twoSidedRequiredUnmet,
    capital,
    share:    y.unknown ? 0 : y.share,
    dailyUsd: y.unknown ? null : y.dailyUsd,
  };
}
