import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';
import { getPlanLimits, PLAN_PRICES } from '@/lib/plans';

const upgradeSchema = z.object({
  plan: z.enum(['free', 'pro', 'profit_share']),
});

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

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = upgradeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });

  const { plan } = parsed.data;
  const price    = PLAN_PRICES[plan];

  const expiresAt = plan === 'pro'
    ? new Date(Date.now() + 30 * 24 * 3600 * 1000)
    : null;

  await prisma.user.update({
    where: { id: user.id },
    data:  { plan, planExpiresAt: expiresAt },
  });

  await prisma.subscription.create({
    data: { userId: user.id, plan, price, expiresAt, status: 'active' },
  });

  return NextResponse.json({ ok: true, plan, expiresAt });
}
