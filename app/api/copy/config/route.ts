import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession, type Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getIsPaid } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

// Copy-slot limits, enforced SERVER-SIDE (previously client-only via localStorage).
const SLOT_LIMIT_FREE = 1;
const SLOT_LIMIT_PRO  = 2;

const configSchema = z.object({
  walletAddr:       z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid wallet address'),
  categories:       z.array(z.string()).max(20).default([]),
  pctPerOrder:      z.number().min(1).max(25),
  maxOpenPositions: z.number().int().min(1).max(50),
  exitMode:         z.enum(['mirror', 'tpsl']),
  tpPct:            z.number().min(1).max(500).nullable().optional(),
  slPct:            z.number().min(1).max(100).nullable().optional(),
  // `mode` is intentionally NOT accepted from the client — always forced to 'paper'
  // below. Live execution stays OFF (AUTO_EXECUTE_ENABLED=false).
});

async function slotLimit(session: Session | null): Promise<number> {
  return (await getIsPaid(session)) ? SLOT_LIMIT_PRO : SLOT_LIMIT_FREE;
}

// GET → this user's copy configs + slot usage.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [configs, limit] = await Promise.all([
    prisma.copyConfig.findMany({
      where:   { userId: session.user.id },
      orderBy: { createdAt: 'asc' },
    }),
    slotLimit(session),
  ]);

  return NextResponse.json({ configs, slots: { used: configs.length, limit } });
}

// POST → create or update a copy config. Server-side slot enforcement on CREATE.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body   = await req.json().catch(() => ({}));
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const d = parsed.data;

  // TP/SL only meaningful in 'tpsl' exit mode — null them out otherwise (no fabrication).
  const tpPct = d.exitMode === 'tpsl' ? (d.tpPct ?? null) : null;
  const slPct = d.exitMode === 'tpsl' ? (d.slPct ?? null) : null;

  const existing = await prisma.copyConfig.findUnique({
    where: { userId_walletAddr: { userId, walletAddr: d.walletAddr } },
  });

  // Slot limit applies only to NEW slots (a new watched wallet). Editing an
  // existing config never consumes an extra slot.
  if (!existing) {
    const [count, limit] = await Promise.all([
      prisma.copyConfig.count({ where: { userId } }),
      slotLimit(session),
    ]);
    if (count >= limit) {
      return NextResponse.json(
        { error: `Copy-slot limit reached (${count}/${limit}). Upgrade to Pro for more slots.`,
          slots: { used: count, limit } },
        { status: 403 });
    }
  }

  const saved = await prisma.copyConfig.upsert({
    where:  { userId_walletAddr: { userId, walletAddr: d.walletAddr } },
    create: {
      userId, walletAddr: d.walletAddr, categories: d.categories,
      pctPerOrder: d.pctPerOrder, maxOpenPositions: d.maxOpenPositions,
      exitMode: d.exitMode, tpPct, slPct, mode: 'paper',   // paper-only, live OFF
    },
    update: {
      categories: d.categories, pctPerOrder: d.pctPerOrder,
      maxOpenPositions: d.maxOpenPositions, exitMode: d.exitMode,
      tpPct, slPct, mode: 'paper',
    },
  });

  const [used, limit] = await Promise.all([
    prisma.copyConfig.count({ where: { userId } }),
    slotLimit(session),
  ]);
  return NextResponse.json({ config: saved, slots: { used, limit } });
}

// DELETE → remove a config by ?id= or ?walletAddr= (scoped to this user).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const id         = searchParams.get('id');
  const walletAddr = searchParams.get('walletAddr');
  if (!id && !walletAddr) {
    return NextResponse.json({ error: 'id or walletAddr required' }, { status: 400 });
  }

  // deleteMany scoped by userId guarantees a user can only delete their own rows.
  const res = await prisma.copyConfig.deleteMany({
    where: id ? { id, userId } : { walletAddr: walletAddr!, userId },
  });

  const [used, limit] = await Promise.all([
    prisma.copyConfig.count({ where: { userId } }),
    slotLimit(session),
  ]);
  return NextResponse.json({ deleted: res.count, slots: { used, limit } });
}
