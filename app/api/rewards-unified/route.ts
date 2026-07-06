import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

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

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    const body    = redactForTier({ ...data, stale: age > STALE_MS }, 'rewards-unified', isPaid);

    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'failed to read /tmp/liquidity-rewards.json', markets: [], meta: null, stale: true },
      { status: 500 },
    );
  }
}
