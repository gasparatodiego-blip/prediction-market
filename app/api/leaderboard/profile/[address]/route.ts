import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

// Serves ONE trader's enriched profile (agent20 schema v2) on demand. The full
// `profiles` map in /tmp/leaderboard.json is multi-MB (172 traders × positions/
// trades/activity) — far too heavy to inline into the 60s-polled leaderboard
// list, so it's fetched per-wallet when a row is opened. hasProfile on the list
// entry tells the UI whether a profile exists before it fetches.
const LEADERBOARD_FILE = '/tmp/leaderboard.json';
const STALE_MS = 35 * 60_000; // 35 min (agent scans every 30 min)

export async function GET(_req: NextRequest, { params }: { params: { address: string } }) {
  const address = (params.address || '').toLowerCase();

  try {
    const raw  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const age  = Date.now() - new Date(raw.updatedAt ?? 0).getTime();
    const profile = raw.profiles?.[address] ?? null;

    if (!profile) {
      return NextResponse.json(
        { ok: false, address, profile: null, error: 'No profile for this wallet yet.' },
        { status: 404 },
      );
    }

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);

    // Premium monetary fields nulled server-side for free/unauth (never $0).
    const body = redactForTier(
      { ok: true, address, updatedAt: raw.updatedAt, stale: age > STALE_MS, profile },
      'leaderboard-profile',
      isPaid,
    );

    return NextResponse.json(body);
  } catch {
    return NextResponse.json(
      { ok: false, address, profile: null, error: 'Leaderboard data unavailable — agent may be warming up.' },
      { status: 503 },
    );
  }
}
