import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// Per-market liquidity-reward placement config. Auth is required to WRITE (a row is
// tied to a user); the detail PAGE has NO login wall — it just falls back to a
// device-local store when the visitor isn't signed in. Paper-only: `mode` is forced
// to 'paper' server-side (live execution OFF, AUTO_EXECUTE_ENABLED=false).

const placementSchema = z.object({
  marketId:   z.string().trim().min(1).max(200),
  venue:      z.enum(['polymarket', 'kalshi']),
  side:       z.enum(['both', 'buy', 'sell']).default('both'),
  qtyPerSide: z.number().min(1).max(1_000_000),
  distanceC:  z.number().min(0).max(100),
  onFill:     z.enum(['requote', 'flatten']).default('requote'),
  newsMode:   z.enum(['withdraw', 'alert', 'off']).default('withdraw'),
  // `mode` intentionally NOT accepted from the client — always forced to 'paper'.
});

// GET → this user's placement for ?marketId= (or all placements if none given).
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const marketId = req.nextUrl.searchParams.get('marketId');
  if (marketId) {
    const placement = await prisma.rewardsPlacement.findUnique({
      where: { userId_marketId: { userId, marketId } },
    });
    return NextResponse.json({ placement });
  }
  const placements = await prisma.rewardsPlacement.findMany({
    where:   { userId },
    orderBy: { updatedAt: 'desc' },
  });
  return NextResponse.json({ placements });
}

// POST → create or update this user's placement for a market.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body   = await req.json().catch(() => ({}));
  const parsed = placementSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const d = parsed.data;

  const saved = await prisma.rewardsPlacement.upsert({
    where:  { userId_marketId: { userId, marketId: d.marketId } },
    create: {
      userId, marketId: d.marketId, venue: d.venue, side: d.side,
      qtyPerSide: d.qtyPerSide, distanceC: d.distanceC, onFill: d.onFill,
      newsMode: d.newsMode, mode: 'paper',   // paper-only, live OFF
    },
    update: {
      venue: d.venue, side: d.side, qtyPerSide: d.qtyPerSide, distanceC: d.distanceC,
      onFill: d.onFill, newsMode: d.newsMode, mode: 'paper',
    },
  });
  return NextResponse.json({ placement: saved });
}

// DELETE → remove this user's placement for ?marketId= (scoped to the user).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

  const res = await prisma.rewardsPlacement.deleteMany({ where: { userId, marketId } });
  return NextResponse.json({ deleted: res.count });
}
