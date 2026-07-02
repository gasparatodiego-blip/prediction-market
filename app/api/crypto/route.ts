import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { getCryptoSpreadsData } from '@/lib/spread-compute';

export const dynamic = 'force-dynamic';

export type { FuturesCoin, SlipPoint, SpreadItem } from '@/lib/spread-compute';

export async function GET() {
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);
  const body    = redactForTier(getCryptoSpreadsData(), 'crypto', isPaid);
  return NextResponse.json(body);
}
