import { NextResponse } from 'next/server';
import { getCryptoSpreadsData } from '@/lib/spread-compute';

export const dynamic = 'force-dynamic';

export type { FuturesCoin, SlipPoint, SpreadItem } from '@/lib/spread-compute';

export async function GET() {
  return NextResponse.json(getCryptoSpreadsData());
}
