import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE = '/tmp/unified-opportunities.json';

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));

    const generatedAt  = typeof raw.generatedAt === 'number' ? raw.generatedAt : null;
    const staleMinutes = generatedAt !== null
      ? Math.floor((Date.now() - generatedAt) / 60_000)
      : null;

    return NextResponse.json({
      ok:           true,
      generatedAt,
      staleMinutes,
      sources:      raw.sources      ?? null,
      summary:      raw.summary      ?? { total: 0, cashable: 0, signal: 0, sports: 0, funding: 0, bestAnnualized: null },
      opportunities: raw.opportunities ?? [],
    });
  } catch {
    return NextResponse.json({
      ok:           false,
      generatedAt:  null,
      staleMinutes: null,
      sources:      null,
      summary:      { total: 0, cashable: 0, signal: 0, sports: 0, funding: 0, bestAnnualized: null },
      opportunities: [],
    });
  }
}
