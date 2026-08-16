import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const WHALE_FILE = '/tmp/poly-whales.json';
const STALE_MS   = 15 * 60_000; // 15 min (agent17 runs every 5 min)

export async function GET() {
  let data: any = null;
  let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

  try {
    data = JSON.parse(fs.readFileSync(WHALE_FILE, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt ?? 0).getTime();
    agentStatus = age < STALE_MS ? 'running' : 'stale';
  } catch { /* file absent */ }

  if (!data) {
    return NextResponse.json({
      agentStatus: 'offline',
      updatedAt: null,
      topWallets: [],
      marketsProcessed: 0,
      uniqueWallets: 0,
      qualifiedWallets: 0,
      recentMarkets: [],
      stats: null,
    });
  }

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);
  const body    = redactForTier({
    agentStatus,
    updatedAt:         data.updatedAt,
    windowDays:        data.windowDays,
    minMarketsToRank:  data.minMarketsToRank,
    marketsProcessed:  data.marketsProcessed  ?? 0,
    marketsInWindow:   data.marketsInWindow   ?? 0,
    uniqueWallets:     data.uniqueWallets      ?? 0,
    qualifiedWallets:  data.qualifiedWallets   ?? 0,
    topWallets:        data.topWallets         ?? [],
    recentMarkets:     data.recentMarkets      ?? [],
    stats:             data.stats              ?? null,
  }, 'poly-whales', isPaid);

  return NextResponse.json(body);
}
