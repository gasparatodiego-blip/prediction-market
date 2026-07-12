import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
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
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ opportunities: [], updatedAt: null });
  }
}
