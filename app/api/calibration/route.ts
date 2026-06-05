import { NextResponse } from 'next/server';
import { loadBucketsSync, runCalibration } from '@/lib/calibration';

export async function GET() {
  try {
    const buckets    = loadBucketsSync();
    const lastUpdate = buckets[0]?.updated_at ?? null;
    const ageMs      = lastUpdate ? Date.now() - new Date(lastUpdate).getTime() : Infinity;
    const isStale    = ageMs > 86_400_000; // 24 h

    if (isStale) {
      // Background refresh — don't block the response
      runCalibration().catch(err => console.error('[calibration] refresh error:', err));
    }

    const totalMarkets = buckets.reduce((s, b) => s + b.total, 0);
    return NextResponse.json({ buckets, totalMarkets, isStale, lastUpdate });
  } catch (err: any) {
    return NextResponse.json(
      { buckets: [], totalMarkets: 0, isStale: true, error: err.message },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    const buckets      = await runCalibration();
    const totalMarkets = buckets.reduce((s, b) => s + b.total, 0);
    return NextResponse.json({ buckets, totalMarkets, updated: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
