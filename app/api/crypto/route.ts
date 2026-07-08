import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { getCryptoSpreadsData } from '@/lib/spread-compute';
import { filterSane, enforceVerified } from '@/lib/display-sanity';

export const dynamic = 'force-dynamic';

export type { FuturesCoin, SlipPoint, SpreadItem } from '@/lib/spread-compute';

export async function GET() {
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Render-time sanity net (before redaction so cap checks see real values). Drops any
  // funding/perp-spot row with a null/NaN/absurd rate or an over-cap unlabeled annualized.
  const data = getCryptoSpreadsData();
  data.spreads = filterSane('funding', data.spreads);
  data.perpSpot = filterSane('perp-spot', data.perpSpot);
  data.usdcArb = filterSane('usdc', data.usdcArb);

  // Source-of-truth enforcement: drop rows the venue positively contradicts,
  // flag+demote rows we couldn't re-read at source, tag verified rows for the badge.
  data.spreads = enforceVerified('funding', data.spreads);
  data.perpSpot = enforceVerified('perp-spot', data.perpSpot);
  data.usdcArb = enforceVerified('usdc', data.usdcArb);

  const body = redactForTier(data, 'crypto', isPaid);
  return NextResponse.json(body);
}
