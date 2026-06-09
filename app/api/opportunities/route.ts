import { NextResponse } from 'next/server';
import fs from 'fs';

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
    return NextResponse.json({ opportunities, updatedAt: raw.updatedAt ?? null });
  } catch {
    return NextResponse.json({ opportunities: [], updatedAt: null });
  }
}
