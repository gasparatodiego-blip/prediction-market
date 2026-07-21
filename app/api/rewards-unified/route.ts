import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';

export const dynamic = 'force-dynamic';

// Unified normalized reward board written by lib/rewards-normalize.js (agent24/25).
const FILE       = '/tmp/liquidity-rewards.json';
const GUARD_FILE = '/tmp/news-guard.json';       // written by agent27-news-guard (optional)
const STALE_MS   = 35 * 60_000;                  // agents scan every 15 min

// Merge the news-guard's per-market risk level + advisory PROTECT action, keyed by
// marketId. Absent/stale guard → newsRisk 'unknown' (calm), never fabricated.
function mergeNewsGuard(markets: any[]): any[] {
  let guard: any = null;
  try { guard = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf-8')); } catch { /* optional */ }
  const byId: Record<string, any> = {};
  if (guard && Array.isArray(guard.markets)) {
    for (const g of guard.markets) if (g?.marketId) byId[g.marketId] = g;
  }
  const guardStale = guard?.meta?.generatedAt
    ? Date.now() - new Date(guard.meta.generatedAt).getTime() > STALE_MS
    : true;
  return markets.map(m => {
    const g = byId[m.marketId];
    if (!g || guardStale) return { ...m, newsRisk: 'unknown', newsSignals: null, protect: null };
    return {
      ...m,
      newsRisk:    g.newsRisk ?? 'unknown',
      newsSignals: g.signals ?? null,
      protect:     g.protect ?? null,
    };
  });
}

export async function GET() {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    const age  = data?.meta?.generatedAt
      ? Date.now() - new Date(data.meta.generatedAt).getTime()
      : Infinity;

    data.markets = mergeNewsGuard(Array.isArray(data.markets) ? data.markets : []);
    // Render-time sanity net: drop any reward row with a negative pool/liquidity or a
    // price outside [0,1] (logged as sanity-reject; UI shows fewer rows, calmly).
    data.markets = filterSane('rewards', data.markets);
    // Source-of-truth enforcement: drop pools the platform no longer pays, flag+demote
    // unverifiable ones (e.g. Kalshi's derived pool), tag verified rows for the badge.
    data.markets = enforceVerified('rewards', data.markets);
    // Guardian (rules A–E): auto-suppress any reward row implying an over-cap/impossible
    // APR, a false verifying badge, or a below-floor book. Display-only, never rewrites
    // source; agent26 runs the same module for alerting.
    data.markets = applyGuardian('rewards', data.markets).rows;

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
