import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const MM_FILE  = '/tmp/mm-analysis.json';
const STALE_MS = 10 * 60_000; // 10 min (agent runs every 3 min)

export async function GET() {
  let data: any = null;
  let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

  try {
    data = JSON.parse(fs.readFileSync(MM_FILE, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt ?? 0).getTime();
    agentStatus = age < STALE_MS ? 'running' : 'stale';
  } catch { /* file absent */ }

  if (!data) {
    return NextResponse.json({
      agentStatus: 'offline',
      updatedAt:   null,
      rewardPoolNote: '',
      markets:     [],
      aggregate: {
        totalMarkets: 0, rewardMarkets: 0, balancedMarkets: 0,
        totalCycles: 0, openCycles: 0, perfectCycles: 0,
        adverseCycles: 0, resolvedCycles: 0,
        measuredPnl: 0, estRewardPerDay: 0, estimatedRewards: 0,
        totalWithRewards: 0, quotedHours: 0,
      },
      recentCycles: [],
      disclaimer: '',
    });
  }

  return NextResponse.json({
    agentStatus,
    updatedAt:      data.updatedAt,
    rewardPoolNote: data.rewardPoolNote ?? '',
    markets:        data.markets        ?? [],
    aggregate:      data.aggregate      ?? {},
    recentCycles:   data.recentCycles   ?? [],
    disclaimer:     data.disclaimer     ?? '',
  });
}
