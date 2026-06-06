import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';

const addSchema = z.object({
  type:       z.string(),
  title:      z.string().min(1).max(200),
  platformA:  z.string().optional(),
  platformB:  z.string().optional(),
  roiPct:     z.number(),
  confidence: z.number().int().min(0).max(100),
  amountUsd:  z.number().min(0).default(0),
  notes:      z.string().max(500).optional(),
});

const updateSchema = z.object({
  id:        z.string(),
  result:    z.enum(['correct', 'incorrect', 'open']),
  pnlUsd:    z.number().optional(),
});

export async function GET() {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [positions, portfolio] = await Promise.all([
    prisma.trackedOpportunity.findMany({
      where:   { userId: user.id },
      orderBy: { trackedAt: 'desc' },
    }),
    prisma.portfolio.findUnique({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({ positions, portfolio });
}

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  const opp = await prisma.trackedOpportunity.create({
    data: { userId: user.id, result: 'open', ...parsed.data },
  });

  // Update portfolio totals
  await prisma.portfolio.upsert({
    where:  { userId: user.id },
    create: { userId: user.id, totalInvested: parsed.data.amountUsd },
    update: { totalInvested: { increment: parsed.data.amountUsd } },
  });

  return NextResponse.json(opp, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  const existing = await prisma.trackedOpportunity.findFirst({
    where: { id: parsed.data.id, userId: user.id },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const updated = await prisma.trackedOpportunity.update({
    where: { id: parsed.data.id },
    data:  {
      result:     parsed.data.result,
      pnlUsd:     parsed.data.pnlUsd,
      resolvedAt: new Date(),
    },
  });

  // Update portfolio stats
  if (parsed.data.result === 'correct' || parsed.data.result === 'incorrect') {
    const isWin = parsed.data.result === 'correct';
    await prisma.portfolio.upsert({
      where:  { userId: user.id },
      create: {
        userId:    user.id,
        winCount:  isWin ? 1 : 0,
        lossCount: isWin ? 0 : 1,
        totalPnl:  parsed.data.pnlUsd ?? 0,
      },
      update: {
        winCount:  isWin ? { increment: 1 } : undefined,
        lossCount: isWin ? undefined : { increment: 1 },
        totalPnl:  { increment: parsed.data.pnlUsd ?? 0 },
      },
    });
  }

  return NextResponse.json(updated);
}
