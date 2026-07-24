import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';
import { computeLiquidityYield } from '@/lib/liquidity-yield';
// Server-side filtering — the SINGLE filter math path (shared, node-testable). Applied here,
// before tier redaction, so the returned row COUNT is correct for every tier and the payload
// is genuinely filtered (not fetch-all-and-hide-in-the-browser).
import { parseRewardFilters, applyRewardFilters, deriveRanges } from '@/lib/rewards-server-filter';
// The SAME resolved-market drop the bot's universe resolver uses — shared so board and bot agree.
import { dropResolvedRewards } from '@/lib/maker/universe';
// The live depth-at-touch floor ($) — surfaced in meta so the "hide thin books" help text states the
// REAL value (env REWARD_DEPTH_TOUCH_FLOOR_USD or the $25 default) and can never drift from the code.
import { depthFloorUsd } from '@/lib/reward-depth-floor';

// Reference balance the guardian evaluates at — the SAME default the list first shows (RewardsUnified
// BAL_DEFAULT). The stamped day-yield is what a paid user sees at that balance.
const GUARDIAN_REF_BAL = 1000;

export const dynamic = 'force-dynamic';

// Unified normalized reward board written by lib/rewards-normalize.js (agent24/25).
const FILE       = '/tmp/liquidity-rewards.json';
const GUARD_FILE = '/tmp/news-guard.json';       // written by agent27-news-guard (optional)
const STALE_MS   = 35 * 60_000;                  // agents scan every 15 min

// Merge the news-guard's per-market severity + measured evidence + advisory PROTECT action, keyed
// by marketId. Absent/stale guard → severity 'unknown' (—), never fabricated. Returns the per-market
// merge AND the guard's execution posture (armed/shadow) so the UI states the truth, not intent.
function mergeNewsGuard(markets: any[]): { markets: any[]; guardMeta: any } {
  let guard: any = null;
  try { guard = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf-8')); } catch { /* optional */ }
  const byId: Record<string, any> = {};
  if (guard && Array.isArray(guard.markets)) {
    for (const g of guard.markets) if (g?.marketId) byId[g.marketId] = g;
  }
  const guardStale = guard?.meta?.generatedAt
    ? Date.now() - new Date(guard.meta.generatedAt).getTime() > STALE_MS
    : true;
  // Execution posture — read from the agent's OWN written meta (not env), so the UI can never claim
  // a different arming state than the process runs under. Stale/absent guard ⇒ report unknown, and
  // default armed:false (the safe default) so the panel never implies live execution when it can't tell.
  const guardMeta = {
    present: !!guard && !guardStale,
    armed: guard?.meta?.armed === true && !guardStale,
    killSwitch: guard?.meta?.killSwitch === true,
    executionMode: guardStale ? 'unknown' : (guard?.meta?.executionMode ?? 'shadow'),
    generatedAt: guard?.meta?.generatedAt ?? null,
  };
  const merged = markets.map(m => {
    const g = byId[m.marketId];
    if (!g || guardStale) return { ...m, newsRisk: 'unknown', severity: 'unknown', newsSignals: null, newsEvidence: null, protect: null };
    return {
      ...m,
      newsRisk:     g.severity ?? g.newsRisk ?? 'unknown',
      severity:     g.severity ?? g.newsRisk ?? 'unknown',
      newsSource:   g.source ?? null,
      newsSignals:  g.signals ?? null,
      newsEvidence: g.evidence ? { summary: g.evidence.summary ?? null, sourceCount: g.evidence.sourceCount ?? null } : null,
      protect:      g.protect ?? null,
    };
  });
  return { markets: merged, guardMeta };
}

export async function GET(request: NextRequest) {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    const age  = data?.meta?.generatedAt
      ? Date.now() - new Date(data.meta.generatedAt).getTime()
      : Infinity;

    const merged = mergeNewsGuard(Array.isArray(data.markets) ? data.markets : []);
    data.markets = merged.markets;
    data.newsGuard = merged.guardMeta;   // execution posture for the UI's news-guard panel
    // Render-time sanity net: drop any reward row with a negative pool/liquidity or a
    // price outside [0,1] (logged as sanity-reject; UI shows fewer rows, calmly).
    data.markets = filterSane('rewards', data.markets);
    // Source-of-truth enforcement: drop pools the platform no longer pays, flag+demote
    // unverifiable ones (e.g. Kalshi's derived pool), tag verified rows for the badge.
    data.markets = enforceVerified('rewards', data.markets);
    // Stamp the guardian's APR input (dayYieldPct) from the REAL displayed estimator
    // (lib/liquidity-yield computeLiquidityYield) at the $1k reference — the SAME math the list renders.
    // Previously the guardian's rewards rule read dayYieldPct, which the feed never carried, so it was
    // inert. This is EPHEMERAL: server-only, deleted before the response (never reaches any tier). It is
    // the guardian's input, NOT a displayed value — the displayed $/day is unchanged (client-computed).
    for (const m of data.markets) {
      const y = computeLiquidityYield({
        poolPerDay: m.dailyPool,
        cap: null,                                    // Polymarket exposes no reward cap; Kalshi one-sided
        qualifyingLiquidity: m.bookDepthAtBand,
        qualifyingLiquidityOpposite: m.venue === 'polymarket' ? (m.sides?.no?.bookDepthAtBand ?? null) : null,
        balance: GUARDIAN_REF_BAL,
      });
      if (!y.unknown) m.dayYieldPct = (y.dailyUsd / GUARDIAN_REF_BAL) * 100; // daily %; guardian ×365 → %/yr
    }
    // Guardian (rules A–E): a reward row over the 200%/yr cap is RELABELLED "run-rate, not guaranteed"
    // (value kept — the arithmetic is correct), never blanked or hidden. Display-only; agent26 audits
    // rewards independently via auditRewardsTooGood.
    data.markets = applyGuardian('rewards', data.markets).rows;
    // Remove the ephemeral guardian input — it must never reach the client or the free tier.
    for (const m of data.markets) delete m.dayYieldPct;

    // Drop already-resolved markets (resolution time in the past ⇒ no active rewards) server-side,
    // so the counts below and the rows the client shows are the same set. A missing (null)
    // resolution time is NOT treated as resolved — we never fabricate one.
    data.markets = dropResolvedRewards(data.markets);

    // ── SERVER-SIDE FILTERING ── applied on the REAL values, BEFORE redaction, so the returned
    // count is correct for every tier. Ranges/options are computed over the FULL verified set so
    // tightening one filter never shrinks another's slider range. The counts are the visible
    // proof the filter is wired: meta.totalMarkets → meta.matchedMarkets.
    const fullMarkets   = data.markets;
    const totalMarkets  = fullMarkets.length;
    const ranges        = deriveRanges(fullMarkets);
    const filters       = parseRewardFilters(request.nextUrl.searchParams);
    data.markets        = applyRewardFilters(fullMarkets, filters);
    data.meta = {
      ...(data.meta || {}),
      totalMarkets,
      matchedMarkets: data.markets.length,
      ranges,
      appliedFilters: filters,
      rewardDepthFloorUsd: depthFloorUsd(),   // real "thin book" floor ($) — the help text states this
    };

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    // Stamp the server-evaluated tier into the payload so the client can tell a LOCKED null
    // (free → 🔒) from a genuinely-not-measured null (paid → "—"). This flag is a presentation
    // hint only: the sensitive VALUES are already physically absent for free (redactForTier
    // nulled them below), so a client that forged isPaid:true would still see no hidden number.
    const body    = redactForTier({ ...data, isPaid, stale: age > STALE_MS }, 'rewards-unified', isPaid);

    // Guardian H (rules 31–33): backstop the redaction — null + CRITICAL any leaked
    // executable/pool field on the free tier (display-only; never fabricates). No-op for paid.
    if (!isPaid) assertRedacted(body, REDACTION_MAP['rewards-unified'], { log: console.log });

    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'failed to read /tmp/liquidity-rewards.json', markets: [], meta: null, stale: true },
      { status: 500 },
    );
  }
}
