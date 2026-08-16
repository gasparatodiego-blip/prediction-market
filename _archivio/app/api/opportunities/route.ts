import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

// agent5-calculator rewrites /tmp/arbitrage-opportunities.json every ~45s. 5 min is ~6 missed
// cycles: wide of any transient slow scan, but trips permanently the moment the agent is stopped —
// the file then ages without bound and the surface must show "—", never the frozen rows.
const STALE_MS = 5 * 60_000;

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const age = Date.now() - new Date((raw.updatedAt ?? 0) as string | number).getTime();
    const opportunities = (raw.opportunities || []).slice(0, 4).map((o: any) => ({
      id: o.id,
      title: o.title,
      type: o.type,
      platform_a: o.platform_a,
      platform_b: o.platform_b,
      expected_return: o.expected_return,
      roi: o.roi,
      confidence: o.confidence,
      urgency: o.urgency,
    }));
    // Free users: null roi / expected_return / confidence server-side. Keep the
    // title/type/platform/urgency teaser.
    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    const body    = redactForTier(
      { opportunities, updatedAt: raw.updatedAt ?? null },
      'opportunities',
      isPaid,
    );
    return NextResponse.json({
      ...body,
      stale:        age > STALE_MS,
      staleMinutes: raw.updatedAt ? Math.floor(age / 60_000) : null,
    });
  } catch {
    return NextResponse.json({ opportunities: [], updatedAt: null, stale: true, staleMinutes: null });
  }
}
