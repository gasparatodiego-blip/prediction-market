import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { isExpired } from '@/lib/instrument-expiry';
import { filterSane, enforceVerified } from '@/lib/display-sanity';

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

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Render-time expired-instrument guard (single source: lib/instrument-expiry).
  // Defense in depth behind agent19's producer filter — an expired dated future must
  // never reach a card. Log rejects so a producer regression is never silent.
  const now = Date.now();
  const keepLive = (rows: any[], label: string) =>
    (rows ?? []).filter((r) => {
      if (isExpired(r, now)) {
        console.log(`[carry] excluded expired instrument ${label}: ${r?.contract ?? r?.instrument ?? '?'} (expiry ${r?.expiry ?? '?'})`);
        return false;
      }
      return true;
    });

  // Layer: expired filter (Phase 2, specific log) then the render-time sanity net
  // (absurd/over-cap/missing-expiry money-field checks).
  // Source-of-truth enforcement: drop venue-contradicted rows, flag+demote
  // unreachable ones, tag verified rows for the badge.
  const opportunities = enforceVerified('basis', filterSane('basis', keepLive(data.opportunities, 'opportunity'), now), now);
  const backwardation = enforceVerified('basis', filterSane('basis', keepLive(data.backwardation, 'backwardation'), now), now);

  const body = redactForTier({
    agentStatus,
    updatedAt:     data.updatedAt,
    opportunities,
    backwardation,
    summary:       data.summary        ?? {},
    spot:          data.spot           ?? {},
    disclaimer:    data.disclaimer     ?? '',
  }, 'carry', isPaid);

  return NextResponse.json(body);
}
