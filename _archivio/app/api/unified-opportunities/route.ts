import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE = '/tmp/unified-opportunities.json';

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));

    const generatedAt  = typeof raw.generatedAt === 'number' ? raw.generatedAt : null;
    const staleMinutes = generatedAt !== null
      ? Math.floor((Date.now() - generatedAt) / 60_000)
      : null;

    // Free users: null every derived-edge field on each opp (ROIs, capacity $, fees,
    // breakeven, slipCurve, verdict prose) + summary.bestAnnualized, server-side.
    // Structure (question, legs/venues, dates, tier, flags) stays as teaser.
    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    const body    = redactForTier({
      ok:           true,
      generatedAt,
      staleMinutes,
      sources:      raw.sources      ?? null,
      summary:      raw.summary      ?? { total: 0, cashable: 0, signal: 0, sports: 0, funding: 0, bestAnnualized: null },
      opportunities: raw.opportunities ?? [],
    }, 'unified-opportunities', isPaid);

    return NextResponse.json(body);
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
