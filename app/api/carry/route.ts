import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { isExpired } from '@/lib/instrument-expiry';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';

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
  // Guardian (rules A–E) is the last stage: auto-suppresses honest-engine violations
  // (over-cap net, OI/proxy capacity, thin-book "cashable", false verifying badge, …).
  // Display-only, never rewrites source; agent26 runs the same module for alerting.
  const opportunities = applyGuardian('basis',
    enforceVerified('basis', filterSane('basis', keepLive(data.opportunities, 'opportunity'), now), now),
    { now }).rows;
  const backwardation = applyGuardian('basis',
    enforceVerified('basis', filterSane('basis', keepLive(data.backwardation, 'backwardation'), now), now),
    { now }).rows;

  const body = redactForTier({
    agentStatus,
    updatedAt:     data.updatedAt,
    opportunities,
    backwardation,
    summary:       data.summary        ?? {},
    spot:          data.spot           ?? {},
    disclaimer:    data.disclaimer     ?? '',
    // Tier flag for the client render boundary: a paid user is never behind the
    // paywall, so the UI must show honest "—" for genuinely-null gated fields
    // (e.g. guardian-suppressed OI/proxy capacity) instead of the upgrade lock.
    // Not a redacted field; no numbers change.
    isPaid,
  }, 'carry', isPaid);

  // Guardian H (rules 31–33): backstop the redaction — null + CRITICAL any leaked
  // derived-edge field on the free tier (display-only; never fabricates). No-op for paid.
  if (!isPaid) assertRedacted(body, REDACTION_MAP['carry'], { log: console.log });

  return NextResponse.json(body);
}
