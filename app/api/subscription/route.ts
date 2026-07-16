import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';
import { getPlanLimits } from '@/lib/plans';

export async function GET() {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dbUser = await prisma.user.findUnique({
    where:   { id: user.id },
    select:  { plan: true, planExpiresAt: true, profitShareBalance: true, totalProfitTracked: true },
  });

  const sub = await prisma.subscription.findFirst({
    where:   { userId: user.id, status: 'active' },
    orderBy: { startedAt: 'desc' },
  });

  return NextResponse.json({
    plan:               dbUser?.plan ?? 'free',
    planExpiresAt:      dbUser?.planExpiresAt ?? null,
    profitShareBalance: dbUser?.profitShareBalance ?? 0,
    totalProfitTracked: dbUser?.totalProfitTracked ?? 0,
    subscription:       sub ?? null,
    limits:             getPlanLimits(dbUser?.plan ?? 'free'),
  });
}

// Plan changes are CLOSED at this endpoint.
//
// This route used to take `plan` from the request body and write it straight to
// User.plan with a 30-day window — no payment check, because there is no payment
// integration to check against (Stripe is not wired; User.stripeSubscriptionId is
// an unused column). That let any authenticated caller grant themselves 'pro' for
// free, so it was a hole, not a feature with a missing check.
//
// It stays closed until a real payment source of truth exists, at which point the
// plan must be written from that provider's verified webhook — never from a value
// the client supplies. Deliberately no admin bypass, env override, or trusted-email
// list here: each of those is the same hole with a longer key.
//
// 403 (not a silent no-op) so a blocked attempt is visible to the caller and in logs.
export async function POST() {
  return NextResponse.json(
    { error: 'Plan changes are not available at this endpoint.' },
    { status: 403 },
  );
}
