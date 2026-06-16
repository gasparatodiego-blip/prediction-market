import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const LEADERBOARD_FILE = '/tmp/leaderboard.json';
const STALE_MS = 35 * 60_000; // 35 min (agent scans every 30 min)

export async function GET() {
  try {
    const raw  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const age  = Date.now() - new Date(raw.updatedAt ?? 0).getTime();
    const staleMinutes = Math.floor(age / 60_000);

    return NextResponse.json({
      ok:            true,
      stale:         age > STALE_MS,
      staleMinutes,
      updatedAt:     raw.updatedAt,
      windowDays:    raw.windowDays,
      marketsScanned: raw.marketsScanned,
      totalWallets:  raw.totalWallets,
      minMarketsToRank: raw.minMarketsToRank,
      categories:    raw.categories ?? {},
      disclaimer:    raw.disclaimer,
    });
  } catch {
    return NextResponse.json({
      ok:            false,
      stale:         true,
      staleMinutes:  null,
      updatedAt:     null,
      windowDays:    180,
      marketsScanned: 0,
      totalWallets:  0,
      minMarketsToRank: 5,
      categories:    {},
      disclaimer:    'Leaderboard agent is warming up — check back in a few minutes.',
    });
  }
}
