import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE = '/tmp/unified-opportunities.json';
const BASIS_FILE   = '/tmp/basis-opportunities.json';

export interface OppPreviewItem {
  id:     string;
  type:   string;
  label:  string;
  netPct: number;
  unit:   string;
  venue:  string;
  note:   string;
}

export async function GET() {
  const items: OppPreviewItem[] = [];

  try {
    const u = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
    for (const o of (u.opportunities ?? []) as any[]) {
      if (o.type === 'FUNDING' && typeof o.netROI === 'number' && o.netROI > 0) {
        items.push({
          id:     o.id,
          type:   'Funding Rate',
          label:  o.question ?? '—',
          netPct: o.netROI,
          unit:   '%/yr',
          venue:  (o.legs as any[])?.map((l: any) => l.platform).join(' / ') ?? '—',
          note:   o.verdict ?? '',
        });
      } else if (o.type === 'CASHABLE' && typeof o.annualizedROI === 'number' && o.annualizedROI > 0) {
        items.push({
          id:     o.id,
          type:   'Prediction Arb',
          label:  o.question ?? '—',
          netPct: o.annualizedROI,
          unit:   '%/yr',
          venue:  (o.legs as any[])?.map((l: any) => l.platform).join(' / ') ?? '—',
          note:   o.lockupFlag ?? '',
        });
      }
    }
  } catch { /* file absent */ }

  try {
    const b = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    const age = Date.now() - new Date((b.updatedAt ?? 0) as string).getTime();
    if (age < 15 * 60_000) {
      for (const o of (b.opportunities ?? []) as any[]) {
        if (typeof o.netAnnualized === 'number' && o.netAnnualized > 0) {
          items.push({
            id:     `basis-${o.contract}`,
            type:   'Cash & Carry',
            label:  `${o.asset} ${o.contract}`,
            netPct: o.netAnnualized * 100,
            unit:   '%/yr',
            venue:  o.exchange ?? '—',
            note:   o.verdict ?? '',
          });
        }
      }
    }
  } catch { /* file absent */ }

  items.sort((a, b) => b.netPct - a.netPct);

  // Free users: null netPct (derived edge) and note (verdict prose embeds the %),
  // server-side, before serialization. Order is computed on real values first.
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);
  const body    = redactForTier(
    { items, total: items.length, generatedAt: Date.now() },
    'opps-preview',
    isPaid,
  );

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  });
}
