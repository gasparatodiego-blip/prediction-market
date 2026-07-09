import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { getCryptoSpreadsData } from '@/lib/spread-compute';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';

export const dynamic = 'force-dynamic';

export type { FuturesCoin, SlipPoint, SpreadItem } from '@/lib/spread-compute';

export async function GET() {
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Render-time sanity net (before redaction so cap checks see real values). Drops any
  // funding/perp-spot row with a null/NaN/absurd rate or an over-cap unlabeled annualized.
  const data = getCryptoSpreadsData();
  data.spreads = filterSane('funding', data.spreads);
  data.perpSpot = filterSane('perp-spot', data.perpSpot);
  data.usdcArb = filterSane('usdc', data.usdcArb);

  // Source-of-truth enforcement: drop rows the venue positively contradicts,
  // flag+demote rows we couldn't re-read at source, tag verified rows for the badge.
  data.spreads = enforceVerified('funding', data.spreads);
  data.perpSpot = enforceVerified('perp-spot', data.perpSpot);
  data.usdcArb = enforceVerified('usdc', data.usdcArb);

  // Guardian (rules A–E): the honest-engine auto-suppressor — hide/downgrade/relabel/
  // redact any row that violates a too-good/consistency/verify/capacity/price rule.
  // Display-only, never rewrites source; logs each action; runs before redaction so it
  // sees real values (like filterSane). agent26 runs the SAME module for alerting.
  data.spreads = applyGuardian('funding', data.spreads).rows;
  data.perpSpot = applyGuardian('perp-spot', data.perpSpot).rows;
  data.usdcArb = applyGuardian('usdc', data.usdcArb).rows;

  const body = redactForTier(data, 'crypto', isPaid);
  // Guardian H (rules 31–33): backstop the redaction — null + CRITICAL any derived-edge
  // field that leaked to the free tier (display-only; never fabricates). No-op for paid.
  if (!isPaid) assertRedacted(body, REDACTION_MAP['crypto'], { log: console.log });
  return NextResponse.json(body);
}
