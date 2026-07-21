// Central server-side paid-gating layer.
//
// Honest-engine rule applies here too: redaction means setting a real field to
// null. Never substitute a rounded/teaser/fabricated number for a free user.
//
// isPaid mechanism: User.plan ('free' | 'pro' | 'profit_share') + User.planExpiresAt,
// same fields/shape as app/api/subscription/route.ts. An expired 'pro' plan is not paid.

import type { Session } from 'next-auth';
import prisma from './prisma';

export type RouteKey =
  | 'prediction'
  | 'crypto'
  | 'carry'
  | 'liquidity-rewards'
  | 'liquidity-rewards-book'
  | 'rewards-unified'
  | 'kalshi-rewards'
  | 'kalshi-rewards-book'
  | 'lp'
  | 'sports-snapshot'
  | 'leaderboard'
  | 'leaderboard-profile'
  | 'trader-feed'
  | 'copy'
  | 'wallet'
  | 'poly-whales'
  | 'user-history'
  | 'paper-book'
  // Headline / teaser feeds — these synthesize a single best derived-edge number
  // per category (or the raw unified opp array). Gated so a direct GET can't read
  // the edge the dashboard detail routes already redact.
  | 'ticker'
  | 'opps-preview'
  | 'opportunities'
  | 'unified-opportunities'
  | 'liquidity'
  | 'sport-arb';

function isPlanCurrentlyPaid(plan: string, planExpiresAt: Date | null, now = new Date()): boolean {
  if (plan === 'profit_share') return true;
  // planExpiresAt is only ever set on 'pro' upgrade (30-day window); a missing
  // value on an existing 'pro' row is a data anomaly, not an expiry — don't punish it.
  if (plan === 'pro') return planExpiresAt ? planExpiresAt > now : true;
  return false;
}

export async function getIsPaid(session: Session | null): Promise<boolean> {
  const userId = session?.user?.id;
  if (!userId) return false;

  const dbUser = await prisma.user.findUnique({
    where:  { id: userId },
    select: { plan: true, planExpiresAt: true },
  });

  return isPlanCurrentlyPaid(dbUser?.plan ?? 'free', dbUser?.planExpiresAt ?? null);
}

// ── Path grammar ────────────────────────────────────────────────────────────
// Dot-separated segments. A segment is a key optionally followed by wildcard
// markers: '[]' (iterate array elements) or '{}' (iterate object values).
// The final segment (no trailing wildcard) is the leaf field that gets nulled,
// or — if it has no further segments after it and IS itself the whole target
// (e.g. "history") — the whole field is nulled without iterating into it.
//
// Examples:
//   "valid[].lowMarket.probability"  → for each item in .valid, null .lowMarket.probability
//   "categories{}[].pnlUsdc"         → for each array value of .categories, for each row, null .pnlUsdc
//   "history"                        → null the whole .history field

type Segment = { key: string; wildcards: ('[]' | '{}')[] };

function parsePath(path: string): Segment[] {
  return path.split('.').map((raw) => {
    const m = raw.match(/^([a-zA-Z0-9_]+)((?:\[\]|\{\})*)$/);
    if (!m) throw new Error(`paid-gating: unparseable path segment "${raw}" in "${path}"`);
    const [, key, wildcardStr] = m;
    const wildcards = (wildcardStr.match(/\[\]|\{\}/g) ?? []) as ('[]' | '{}')[];
    return { key, wildcards };
  });
}

function applyWildcards(node: unknown, wildcards: ('[]' | '{}')[], rest: Segment[]): void {
  if (node == null) return;
  const [w, ...restW] = wildcards;

  if (w === '[]') {
    if (!Array.isArray(node)) return;
    for (const item of node) {
      if (restW.length > 0) applyWildcards(item, restW, rest);
      else if (rest.length > 0) redactPath(item, rest);
    }
  } else if (w === '{}') {
    if (typeof node !== 'object') return;
    for (const val of Object.values(node as Record<string, unknown>)) {
      if (restW.length > 0) applyWildcards(val, restW, rest);
      else if (rest.length > 0) redactPath(val, rest);
    }
  }
}

function redactPath(obj: unknown, segments: Segment[]): void {
  if (obj == null || typeof obj !== 'object') return;
  const [seg, ...rest] = segments;
  const record = obj as Record<string, unknown>;
  if (!(seg.key in record) || record[seg.key] == null) return;

  if (seg.wildcards.length === 0) {
    if (rest.length === 0) {
      record[seg.key] = null; // leaf — redact
    } else {
      redactPath(record[seg.key], rest);
    }
    return;
  }

  applyWildcards(record[seg.key], seg.wildcards, rest);
}

// ── Redaction map ────────────────────────────────────────────────────────────
// Sensitive JSON paths per route. Everything NOT listed here stays visible to
// free users as-is (teaser fields: titles, platform names, dates, tier chips,
// volume, URLs, counts).

export const REDACTION_MAP: Record<RouteKey, string[]> = {
  prediction: [
    'valid[].lowMarket.probability',
    'valid[].lowMarket.yesBid',
    'valid[].lowMarket.yesAsk',
    'valid[].lowMarket.depth',
    'valid[].lowMarket.capacityUsd',
    'valid[].highMarket.probability',
    'valid[].highMarket.yesBid',
    'valid[].highMarket.yesAsk',
    'valid[].highMarket.depth',
    'valid[].highMarket.capacityUsd',
    'valid[].spread',
    'valid[].roi',
    'valid[].earnPer100',
    'valid[].confidence',
    'valid[].capacityUsd',
    'valid[].confidenceNote',
    'valid[].capacityNote',
    'events[].platforms[].yesPrice',
    'events[].platforms[].noPrice',
    'events[].referenceMedian.yesPrice',
    'events[].lockableEdge',
    'stats.bestRoi',
  ],

  crypto: [
    // Raw per-exchange funding rates / mark prices / spot prices are public
    // reference data (same as any exchange ticker) — kept as teaser.
    // Only the DERIVED edge (APY, fees, breakeven, capacity, slippage) is sensitive.
    'spreads[].grossApy',
    'spreads[].netApy30d',
    'spreads[].totalFeesPct',
    'spreads[].breakevenDays',
    'spreads[].capacityUsd',
    'spreads[].greenCapacityUsd',
    'spreads[].slipCurveMaxFillable',
    'spreads[].slipCurve[].slipBps',
    'spreads[].slipCurve[].slipUsd',
    'spreads[].slipCurve[].grossDayUsd',
    'spreads[].slipCurve[].netDayUsd',
    'spreads[].slipCurve[].slipOverGross',
    'futures{}{}.openInterestUsd',
    'futures{}{}.openInterest',
    // Perp-vs-spot carry: raw funding rate + trailing count stay as teaser (public
    // reference); only the DERIVED dollar edge is gated. The UI locks the whole math
    // block when edge.netPerDay1k is redacted (null) — calm unlock, no login wall.
    'perpSpot[].edge.grossPerDay1k',
    'perpSpot[].edge.feesOneTime1k',
    'perpSpot[].edge.netPerDay1k',
    'perpSpot[].edge.breakevenDays',
    'perpSpot[].edge.annualizedRunRatePct',
    'perpSpot[].edge.netAnnualizedOnCapitalPct',
    // USDC-margined divergence lane: real funding + annualized divergence (grossApyPct)
    // stay public teaser; the DERIVED dollar edge is gated (UI locks the math block when
    // netPerDay1k is null — calm unlock, no login wall).
    'usdcArb[].edge.grossPerDay1k',
    'usdcArb[].edge.feesOneTime1k',
    'usdcArb[].edge.netPerDay1k',
    'usdcArb[].edge.breakevenDays',
    'usdcArb[].edge.netApy30dPct',
    'usdcArb[].edge.annualizedRunRatePct',
    // RWA commodities (beta) — raw per-leg funding + the capped gross divergence stay a
    // public teaser (same as usdcArb grossApyPct); only the DERIVED fee-adjusted net is
    // gated. Observation-only, never cashable.
    'rwa[].divergence.netApy',
  ],

  carry: [
    // Card projection for /dashboard/carry. Same derived edge as the rows below, reached
    // by a different shape — gate it identically or the card surface becomes a paywall
    // bypass for the numbers the row already locks. Public teaser stays: asset, venue,
    // expiry, days-to-expiry, spot ask, future bid, convergence progress.
    'basisCards[].netUsdPerDay',
    'basisCards[].annualizedPct',
    'basisCards[].capacityUsd',
    'basisCards[].feeUsd',
    'basisCards[].feeModel.legs',
    'basisCards[].feeModel.totalPct',
    'basisCards[].executableBasisPct',
    'basisCards[].indicativeBasisPct',
    'carryMeta.bestApyPct',
    // Raw spot/future/bid/ask prices are public reference quotes — teaser.
    // Only the derived basis/annualized/capacity numbers are sensitive.
    'opportunities[].indicativeBasisPct',
    'opportunities[].executableBasisPct',
    'opportunities[].basis',
    'opportunities[].grossAnnualized',
    'opportunities[].grossAnnualizedExec',
    'opportunities[].netAnnualizedIndicative',
    'opportunities[].netAnnualizedExecutable',
    'opportunities[].netAnnualized',
    'opportunities[].capacityUsd',
    // verdict is a prose headline that embeds the exact netAnnualizedExecutable
    // % (agent19-basis.js) — redact it too, or the number leaks through text
    // even with the numeric field nulled.
    'opportunities[].verdict',
    'opportunities[].bidSpreadPct',
    'opportunities[].oiUsd',
    // Carry-optimization overlay (CC-2/2b/2c). The same derived edge as above, reached
    // by a different path — gate it identically, or the venue comparison becomes a
    // paywall bypass for the very numbers the row itself locks.
    // Deliberately NOT gated: quoteAsset / quoteRiskTier / quoteRiskFlagged /
    // quoteRiskLabel / quoteRiskReason / spotInstrument / capacitySource / feeVerified.
    // Those are RISK DISCLOSURES and venue facts, not edge — a free user must still see
    // that the recommended route buys a synthetic dollar.
    'opportunities[].carryOpt.riskFreeDeltaPct',
    'opportunities[].carryOpt.optCapacityUsd',
    'opportunities[].carryOpt.feePct',
    'opportunities[].carryOpt.feeOfficialFraction',
    'opportunities[].carryOpt.feeLegs',
    'opportunities[].venueCompare.options[].executableBasisPct',
    'opportunities[].venueCompare.options[].netAnnualizedPct',
    'opportunities[].venueCompare.options[].riskFreeDeltaPct',
    'opportunities[].venueCompare.options[].capacityUsd',
    'opportunities[].venueCompare.options[].feePct',
    // backwardation[] items have a different (simpler) shape than
    // opportunities[] — confirmed against live /tmp/basis-opportunities.json:
    // { indicativeBasisPct, executableBasisPct, basis, annualized, ... }.
    // No grossAnnualized/netAnnualized*/capacityUsd/bidSpreadPct/oiUsd fields exist here.
    'backwardation[].indicativeBasisPct',
    'backwardation[].executableBasisPct',
    'backwardation[].basis',
    'backwardation[].annualized',
    'summary.bestNetAnnualized',
  ],

  'liquidity-rewards': [
    'markets[].rewardsDailyRate',
    'markets[].rewardsMaxSpread',
    'markets[].rewardsMinSize',
    'markets[].existing_depth_usd',
    'markets[].mid',
    'markets[].bookSpread',
    'markets[].levels{}.share',
    'markets[].levels{}.grossRewardDay',
    'markets[].levels{}.dayYieldPct',
    'markets[].levels{}.netRewardDay',
    'markets[].levels{}.netYieldPct',
    'markets[].levels{}.shareHigh',
    'markets[].levels{}.grossHigh',
    'markets[].levels{}.netHigh',
    'markets[].levels{}.shareLow',
    'markets[].levels{}.grossLow',
    'markets[].levels{}.netLow',
  ],

  'liquidity-rewards-book': [
    'yes',
    'no',
  ],

  // Unified normalized reward board (/tmp/liquidity-rewards.json). Redact the DERIVED,
  // personal, competitive figures so the estimator degrades to a calm "unlock" state on
  // the free tier. Teasers kept (owner-decided freemium split): title, category, venue,
  // hoursToResolution, twoSidedRequired, volatilityRisk, newsRisk, flags — AND the market's
  // published reward pool $/day (dailyPool / rewardScore.poolDay) plus the qualitative
  // saturated/open status bar (rewardScore.refShare = existing makers' pool share). Those
  // three are the free teaser hook; the personal edge (your est $/day, your share %, book
  // depth $, and the live order book) stays locked. `dailyPool` alone can never fabricate a
  // number: lib/liquidity-yield returns unknown whenever qualifyingLiquidity (depth) is null,
  // which it always is on the free tier — so no est/share leaks through the public pool.
  'rewards-unified': [
    'markets[].midpoint',
    'markets[].maxSpread',
    'markets[].minSize',
    'markets[].qualifyingLiquidity',
    'markets[].bookDepthAtBand',
    'markets[].volatilityStdev',
    'markets[].lastPrice',
    'markets[].bookSpread',
    // Per-side (YES/NO) book numbers are the same sensitive executable figures — redact
    // both sides so the estimator degrades to the calm "unlock" state on the free tier.
    'markets[].sides.yes.midpoint',
    'markets[].sides.yes.qualifyingLiquidity',
    'markets[].sides.yes.bookDepthAtBand',
    'markets[].sides.yes.bookSpread',
    'markets[].sides.yes.volatilityStdev',
    'markets[].sides.no.midpoint',
    'markets[].sides.no.qualifyingLiquidity',
    'markets[].sides.no.bookDepthAtBand',
    'markets[].sides.no.bookSpread',
    'markets[].sides.no.volatilityStdev',
    // Measured/observed reward-share block. The EXECUTABLE competitive intel stays locked:
    // the reference mid and the raw competitor qualifying depth. Deliberately PUBLIC (owner
    // freemium split): rewardScore.poolDay (the market's published reward pool $/day) and
    // rewardScore.refShare (existing makers' pool share → the qualitative saturated/open
    // status bar). source/model/vCents/minSize/refCapital are non-sensitive labels/params.
    'markets[].rewardScore.mid',
    'markets[].rewardScore.competitorQ',
  ],

  'kalshi-rewards': [
    'markets[].pool_day',
    'markets[].total_period_usd',
    'markets[].last_price',
    'markets[].book_mid',
    'markets[].best_bid',
    'markets[].best_ask',
    'markets[].competitor_qualifying_bids',
    'markets[].competitor_qualifying_asks',
    'markets[].levels{}.share',
    'markets[].levels{}.bidShare',
    'markets[].levels{}.askShare',
    'markets[].levels{}.grossRewardDay',
    'markets[].levels{}.dayYieldPct',
    'markets[].levels{}.netRewardDay',
    'markets[].levels{}.netYieldPct',
  ],

  'kalshi-rewards-book': [
    'orderbook',
    'orderbook_fp',
  ],

  lp: [
    'summary.totalExposure',
    'summary.totalFees',
    'summary.avgAPY',
    'summary.remainingCapital',
    'candidates[].price',
    'positions[].amountUSD',
    'positions[].feesEarned',
    'positions[].estimatedAPY',
    'history', // whole feed is the product — null the array, not just fields inside it
  ],

  'sports-snapshot': [
    'opportunities[].roiPct',
    'opportunities[].impliedSum',
    'opportunities[].legs[].odd',
    'opportunities[].legs[].stakePct',
    'flaggedArbs[].roiPct',
    'flaggedArbs[].impliedSum',
    'flaggedArbs[].legs[].odd',
    'flaggedArbs[].legs[].stakePct',
    'quarantine[].roiPct',
    'scannedEvents[].impliedSum',
    'scannedEvents[].marginPct',
    'scannedEvents[].bestLegs[].odd',
    // Sharp reference (Pinnacle) + edge-vs-sharp (agent12 8749e84). Gate every
    // NUMBER — Pinnacle raw price, de-vigged fair line, overround/margin, the
    // edge %, soft odds — plus edgeVsSharp.reason (its string embeds the raw
    // suppressed edge %, e.g. "edge_16.62pct_..."). Flags/labels/book names,
    // sharpReference.present, sharpReference.reason (no number), and outcome
    // names stay visible as teaser. Applied to all four carrier arrays.
    'opportunities[].sharpReference.raw[].odd',
    'opportunities[].sharpReference.overround',
    'opportunities[].sharpReference.marginPct',
    'opportunities[].sharpReference.noVig[].fairProb',
    'opportunities[].sharpReference.noVig[].fairOdds',
    'opportunities[].edgeVsSharp.edgePct',
    'opportunities[].edgeVsSharp.rawEdgePct',
    'opportunities[].edgeVsSharp.softOdd',
    'opportunities[].edgeVsSharp.fairOdds',
    'opportunities[].edgeVsSharp.reason',
    'flaggedArbs[].sharpReference.raw[].odd',
    'flaggedArbs[].sharpReference.overround',
    'flaggedArbs[].sharpReference.marginPct',
    'flaggedArbs[].sharpReference.noVig[].fairProb',
    'flaggedArbs[].sharpReference.noVig[].fairOdds',
    'flaggedArbs[].edgeVsSharp.edgePct',
    'flaggedArbs[].edgeVsSharp.rawEdgePct',
    'flaggedArbs[].edgeVsSharp.softOdd',
    'flaggedArbs[].edgeVsSharp.fairOdds',
    'flaggedArbs[].edgeVsSharp.reason',
    'quarantine[].sharpReference.raw[].odd',
    'quarantine[].sharpReference.overround',
    'quarantine[].sharpReference.marginPct',
    'quarantine[].sharpReference.noVig[].fairProb',
    'quarantine[].sharpReference.noVig[].fairOdds',
    'quarantine[].edgeVsSharp.edgePct',
    'quarantine[].edgeVsSharp.rawEdgePct',
    'quarantine[].edgeVsSharp.softOdd',
    'quarantine[].edgeVsSharp.fairOdds',
    'quarantine[].edgeVsSharp.reason',
    'scannedEvents[].sharpReference.raw[].odd',
    'scannedEvents[].sharpReference.overround',
    'scannedEvents[].sharpReference.marginPct',
    'scannedEvents[].sharpReference.noVig[].fairProb',
    'scannedEvents[].sharpReference.noVig[].fairOdds',
    'scannedEvents[].edgeVsSharp.edgePct',
    'scannedEvents[].edgeVsSharp.rawEdgePct',
    'scannedEvents[].edgeVsSharp.softOdd',
    'scannedEvents[].edgeVsSharp.fairOdds',
    'scannedEvents[].edgeVsSharp.reason',
    // True-arb (agent12): gate the guaranteed-profit number + the covering legs'
    // odds/stakes. kind (cashable/signal), arbReason (enum), and arbLegs book
    // names/outcomes stay public — same teaser convention as edgeVsSharp.
    'opportunities[].arbProfitPct',
    'opportunities[].arbLegs[].odd',
    'opportunities[].arbLegs[].stakePct',
    'flaggedArbs[].arbProfitPct',
    'flaggedArbs[].arbLegs[].odd',
    'flaggedArbs[].arbLegs[].stakePct',
    'quarantine[].arbProfitPct',
    'quarantine[].arbLegs[].odd',
    'quarantine[].arbLegs[].stakePct',
    'scannedEvents[].arbProfitPct',
    'scannedEvents[].arbLegs[].odd',
    'scannedEvents[].arbLegs[].stakePct',
  ],

  leaderboard: [
    'categories{}[].pnlUsdc',
    'categories{}[].winRate',
    'categories{}[].wilsonScore',
    'categories{}[].volumeUsdc',
    'categories{}[].wins',
    'categories{}[].losses',
    'mmCategories{}[].pnlUsdc',
    'mmCategories{}[].winRate',
    'mmCategories{}[].wilsonScore',
    'mmCategories{}[].volumeUsdc',
    'mmCategories{}[].wins',
    'mmCategories{}[].losses',
    'bots[].pnlUsdc',
    'bots[].winRate',
    'bots[].wilsonScore',
    'bots[].volumeUsdc',
    'bots[].wins',
    'bots[].losses',
  ],

  // Per-trader profile (agent20 schema v2), served by
  // app/api/leaderboard/profile/[address]/route.ts. Payload is { ok, profile }.
  // Only DERIVED monetary/edge fields are nulled — structure (market titles,
  // outcomes, sides, sizes/token counts, timestamps, ranks, resolvedMarkets,
  // won/lost result, actorType, opsCounts) stays visible as teaser.
  'leaderboard-profile': [
    'profile.windows{}.pnlUsdc',
    'profile.windows{}.volumeUsdc',
    'profile.categories[].pnlUsdc',
    'profile.categories[].winRate',
    'profile.categories[].volumeUsdc',
    'profile.positionsOpen[].avgPrice',
    'profile.positionsOpen[].currentValue',
    'profile.positionsOpen[].unrealizedPnl',
    'profile.tradesClosed[].realizedPnl',
    'profile.tradesClosed[].fills[].usd',   // drawer dollar-notional is premium (like activityRecent.usdcSize)
    'profile.activityRecent[].price',
    'profile.activityRecent[].usdcSize',
  ],

  // Trader detail feed (agent30). Structure/activity stays visible as teaser —
  // markets, sides, sizes, share counts, timestamps, statuses, held days,
  // fill counts, feed health. The MONEY is paid: fill prices, position
  // economics (avg entry, mark, cost basis, proceeds, realized/unrealized P&L),
  // and the reconstructed realized-P&L equity curve.
  'trader-feed': [
    'fills[].price',
    'positions[].avgEntry',
    'positions[].close',
    'positions[].costBasis',
    'positions[].proceeds',
    'positions[].pnl',
    'positions[].roiPct',
    'summary.realizedPnl',
    'summary.unrealizedPnl',
    'summary.costBasisOpen',
    'equityCurve',
    'categoryPnl',
  ],

  copy: [
    'wallets[].pnlUsdc',
    'wallets[].winRate',
    'wallets[].volumeUsdc',
    'wallets[].wins',
    'wallets[].losses',
    'recentAlerts', // whole feed is the product
  ],

  wallet: [
    'realizedPnl',
    'unrealizedPnl',
    'estimatedPnl',
    'winRate',
    'wins',
    'losses',
    'avgPositionSize',
    'totalVolume',
    'portfolioValue',
    'openPositions[].avgPrice',
    'openPositions[].curPrice',
    'openPositions[].currentValue',
    'openPositions[].initialValue',
    'openPositions[].unrealizedPnl',
    'openPositions[].unrealizedPct',
    'pnlHistory[].cumulativePnl',
    'recentTrades[].price',
    'recentTrades[].size',
  ],

  'poly-whales': [
    'topWallets[].wins',
    'topWallets[].losses',
    'topWallets[].winRatePct',
    'topWallets[].totalPnlUsdc',
    'topWallets[].avgPnlPerMarket',
    'topWallets[].pattern.avgExposurePerMarket',
  ],

  'user-history': [
    'history[].avgConf',
    'history[].best',
    'history[].accuracy7d',
    'currentOpps[].price_a',
    'currentOpps[].price_b',
    'currentOpps[].spread_pct',
    'currentOpps[].roi',
    'currentOpps[].expected_return',
    'currentOpps[].profit_on_1000',
    'currentOpps[].fees_estimate',
    'currentOpps[].net_profit',
    'currentOpps[].confidence',
    'currentStats.bestRoi',
  ],

  // /api/ticker — the per-category headline (bestNetPct = net $/day, ROI, %/yr, %/day).
  // note[] embeds derived money for the rewards ("$X/day est") and traders ("+$PnL")
  // cards, so it is nulled too (honest: the field goes missing, never a fabricated
  // teaser). Non-edge stays: label, unit, status, count, href, displayKind, platforms.
  ticker: [
    'categories[].bestNetPct',
    'categories[].note',
  ],

  // /api/opps-preview — netPct is the derived edge; note carries the verdict prose,
  // which embeds the same % (like carry.verdict), so null both. Keep type/label/venue/unit.
  'opps-preview': [
    'items[].netPct',
    'items[].note',
  ],

  // /api/opportunities — top-4 discovery teaser. Keep title/type/platforms/urgency.
  opportunities: [
    'opportunities[].roi',
    'opportunities[].expected_return',
    'opportunities[].confidence',
  ],

  // /api/unified-opportunities — the raw unified opp array (every derived-edge field)
  // plus summary.bestAnnualized. Keep structure/teaser: type, id, question, legs
  // (venue names), dates, tier/flags, notes-of-state. verdict embeds the % → null it.
  'unified-opportunities': [
    'opportunities[].annualizedROI',
    'opportunities[].netROI',
    'opportunities[].grossROI',
    'opportunities[].predictedGrossApy',
    'opportunities[].spread',
    'opportunities[].confidence',
    'opportunities[].totalFeesPct',
    'opportunities[].breakevenDays',
    'opportunities[].capacityUsd',
    'opportunities[].greenCapacityUsd',
    'opportunities[].slipCurveMaxFillable',
    'opportunities[].book20bpsUsd',
    'opportunities[].oiUsd',
    'opportunities[].slipCurve',
    'opportunities[].verdict',
    'summary.bestAnnualized',
  ],

  // /api/paper-book — unified forward-paper book (agent32 store). Structure/teaser
  // stays visible: strategy names, chips, venue/pair labels, statuses, counts,
  // freshness, executable prices (public exchange quotes), sizing/capacity. Only the
  // DERIVED EDGE is gated — every paper P&L (headline + THIN + per-strategy + per-
  // position value), funding accrued, basis edge, ROI/annualized run-rate, fees, the
  // equity-curve values, the copy sleeve P&L, and the liquidity est run-rate. Redaction
  // is a real null (honest-engine) — the free payload carries NO edge number to blur.
  'paper-book': [
    'headline.executablePnlUsd',
    'headline.thinPnlUsd',
    // Closed/matured REALIZED book — a $ figure, gated like every other derived P&L.
    // (closedCount / maturedCount stay public — counts, not edge.)
    'headline.closedRealizedUsd',
    'equityCurve[].netUsd',
    'strategies[].execPnlUsd',
    'strategies[].thinPnlUsd',
    'strategies[].realizedPnlUsd',   // per-category closed realized $ — gated
    'strategies[].positions[].value',
    // Per-position closed realized + its exit mark — gated $ figures (exit.reason /
    // exit.asOf stay public: they are labels/timestamps, not edge).
    'strategies[].positions[].realizedUsd',
    'strategies[].positions[].exit.markPx',
    'strategies[].positions[].exit.trailingNetPerDay',
    'strategies[].positions[].cumFundingUsd',
    'strategies[].positions[].entry.estNetPerDayAtEntry',
    'strategies[].positions[].entry.estNetRoiAtEntry',
    'strategies[].positions[].entry.estAnnualizedAtEntry',
    'strategies[].positions[].entry.netAnnualizedAtEntry',
    'strategies[].positions[].entry.liveRoiAtEntry',
    'strategies[].positions[].entry.entryBasisPct',
    'strategies[].positions[].entry.feesUsd',
    'strategies[].positions[].lastMark.netUsd',
    'strategies[].positions[].lastMark.unrealizedUsd',
    'strategies[].positions[].lastMark.cumFundingUsd',
    'strategies[].positions[].lastMark.currentBasisPct',
    'strategies[].positions[].lastMark.liveRoi',
    'strategies[].positions[].marks[].netUsd',
    'strategies[].positions[].marks[].unrealizedUsd',
    'strategies[].positions[].marks[].cumFundingUsd',
    'strategies[].positions[].marks[].currentBasisPct',
    'strategies[].positions[].marks[].liveRoi',
    'copy.pnlUsd',
    'copy.sleeves[].realizedUsd',
    'copy.sleeves[].unrealizedUsd',
    'copy.sleeves[].deployedUsd',
    'liquidity.realizedUsd',
    'liquidity.estRunRate.bestNetPerDay1k',
  ],

  // /api/liquidity — MM/LP position economics. Raw prices + volume stay as reference;
  // the derived APY / fees / P&L / notional exposure are gated.
  liquidity: [
    'positions[].lpApy',
    'positions[].feesEarned',
    'positions[].netPnl',
    'positions[].il',
    'positions[].notionalUSD',
    'topMarketsForLp[].lpApyEstimate',
    'summary.totalNetPnl',
    'summary.totalNotional',
  ],

  // Live sports cross-venue crossings. The raw venue prices are public reference data
  // (anyone can read a Kalshi book), so they stay visible as the teaser. Only the DERIVED
  // edge is gated: the post-fee return, the euro profit, and the executable size.
  // bindingLeg/jurisdiction stay — they are labels, not edge.
  'sport-arb': [
    'crossings[].netPct',
    'crossings[].netProfitEur',
    'crossings[].maxStakeEur',
  ],
};

/**
 * Paid → payload unchanged. Free → deep-clone with every mapped sensitive
 * path set to null. Teaser fields are left untouched. Never fabricates.
 */
export function redactForTier<T>(payload: T, routeKey: RouteKey, isPaid: boolean): T {
  if (isPaid) return payload;

  const clone: T = JSON.parse(JSON.stringify(payload));
  const paths = REDACTION_MAP[routeKey] ?? [];
  for (const path of paths) {
    redactPath(clone, parsePath(path));
  }
  return clone;
}
