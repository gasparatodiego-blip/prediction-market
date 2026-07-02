import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const FILE     = '/root/prediction-market/data/kalshi-rewards.json';
const STALE_MS = 30 * 60_000;

export async function GET() {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    const ts   = data?._meta?.timestamp;
    const age  = ts ? Date.now() - new Date(ts).getTime() : Infinity;

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    const body    = redactForTier({ ...data, stale: age > STALE_MS }, 'kalshi-rewards', isPaid);

    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message ?? 'failed to read kalshi-rewards.json', markets: [], _meta: null, stale: true },
      { status: 500 },
    );
  }
}
