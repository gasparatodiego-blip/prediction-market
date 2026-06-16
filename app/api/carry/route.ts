import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const BASIS_FILE = '/tmp/basis-opportunities.json';
const STALE_MS   = 15 * 60_000; // agent runs every 5 min

export async function GET() {
  let data: any = null;
  let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

  try {
    data = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt ?? 0).getTime();
    agentStatus = age < STALE_MS ? 'running' : 'stale';
  } catch { /* file absent */ }

  if (!data) {
    return NextResponse.json({
      agentStatus:  'offline',
      updatedAt:    null,
      opportunities: [],
      backwardation: [],
      summary:      { count: 0, bestNetAnnualized: null, bestContract: null, bestExchange: null, bestAsset: null },
      spot:         {},
      disclaimer:   '',
    });
  }

  return NextResponse.json({
    agentStatus,
    updatedAt:     data.updatedAt,
    opportunities: data.opportunities  ?? [],
    backwardation: data.backwardation  ?? [],
    summary:       data.summary        ?? {},
    spot:          data.spot           ?? {},
    disclaimer:    data.disclaimer     ?? '',
  });
}
