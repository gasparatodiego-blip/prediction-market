import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const FILE     = '/root/prediction-market/data/liquidity-rewards.json';
const STALE_MS = 35 * 60_000;  // agent runs every 15 min; flag stale after 35 min

export async function GET() {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    const age  = data?.meta?.generatedAt
      ? Date.now() - new Date(data.meta.generatedAt).getTime()
      : Infinity;
    return NextResponse.json({ ...data, stale: age > STALE_MS });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message ?? 'failed to read liquidity-rewards.json', markets: [], meta: null, stale: true },
      { status: 500 },
    );
  }
}
