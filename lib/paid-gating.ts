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
  | 'kalshi-rewards'
  | 'kalshi-rewards-book'
  | 'lp'
  | 'sports-snapshot'
  | 'leaderboard'
  | 'leaderboard-profile'
  | 'copy'
  | 'wallet'
  | 'poly-whales'
  | 'user-history';

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
  ],

  carry: [
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
    'profile.activityRecent[].price',
    'profile.activityRecent[].usdcSize',
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
