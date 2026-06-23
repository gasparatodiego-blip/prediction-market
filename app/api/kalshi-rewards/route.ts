import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const FILE     = '/root/prediction-market/data/kalshi-rewards.json';
const STALE_MS = 30 * 60_000;

export async function GET() {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw);
    const ts   = data?._meta?.timestamp;
    const age  = ts ? Date.now() - new Date(ts).getTime() : Infinity;
    return NextResponse.json({ ...data, stale: age > STALE_MS });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message ?? 'failed to read kalshi-rewards.json', markets: [], _meta: null, stale: true },
      { status: 500 },
    );
  }
}
