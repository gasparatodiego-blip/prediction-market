import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const MM_FILE  = '/tmp/mm-analysis.json';
const STALE_MS = 20 * 60_000;  // agent writes every 15 min; stale after 20 min

export async function GET() {
  let data: any = null;
  let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

  try {
    data = JSON.parse(fs.readFileSync(MM_FILE, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt ?? 0).getTime();
    agentStatus = age < STALE_MS ? 'running' : 'stale';
  } catch { /* file absent or malformed */ }

  if (!data) {
    return NextResponse.json({
      agentStatus:           'offline',
      updatedAt:             null,
      sampleCapital:         200,
      note:                  '',
      lpRewardRatePublished: false,
      lpRewardRateNote:      'Agent offline.',
      markets:               [],
      aggregate: {
        totalMarkets: 0, marketsWithDepth: 0, lowRiskMarkets: 0,
        emptyBookMarkets: 0, lpRewardRatePublished: false,
        headlineNote: 'LP reward rate not in public API — no yield estimate possible',
      },
      disclaimer: '',
    });
  }

  return NextResponse.json({
    agentStatus,
    updatedAt:             data.updatedAt,
    sampleCapital:         data.sampleCapital ?? 200,
    note:                  data.note          ?? '',
    lpRewardRatePublished: false,
    lpRewardRateNote:      data.lpRewardRateNote ?? '',
    markets:               data.markets       ?? [],
    aggregate:             data.aggregate     ?? {},
    disclaimer:            data.disclaimer    ?? '',
  });
}
