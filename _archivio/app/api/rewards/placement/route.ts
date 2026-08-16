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

// Per-side fill rules are the source of truth. The legacy single `onFill`
// ('requote' | 'flatten') is still ACCEPTED for one release and translated
// server-side onto BOTH sides ('flatten' == 'close'). The DB keeps a legacy
// `onFill` column in sync ('close' -> 'flatten') so older readers don't break.
const RULE = z.enum(['requote', 'close']);
const placementSchema = z.object({
  marketId:   z.string().trim().min(1).max(200),
  venue:      z.enum(['polymarket', 'kalshi']),
  side:       z.enum(['both', 'buy', 'sell']).default('both'),
  qtyPerSide: z.number().min(1).max(1_000_000),
  distanceC:  z.number().min(0).max(100),
  onFillYes:  RULE.optional(),
  onFillNo:   RULE.optional(),
  onFill:     z.enum(['requote', 'flatten']).optional(),   // DEPRECATED legacy single field
  newsMode:   z.enum(['withdraw', 'alert', 'off']).default('withdraw'),
  // Per-market MAXIMUM INVENTORY in dollars. DEFAULT 0, and 0 is the instruction "do not accumulate":
  // after a fill the engine stops quoting that side instead of re-quoting the opposite one. Accumulating
  // is opt-in per market, by typing a number (lib/maker/inventory-manager).
  maxInventoryUsd: z.number().min(0).max(1_000_000).default(0),
  // `mode` intentionally NOT accepted from the client — always forced to 'paper'.
});

// Resolve the two per-side rules from the parsed body, honouring the legacy field.
function resolveFillRules(d: z.infer<typeof placementSchema>): { onFillYes: 'requote' | 'close'; onFillNo: 'requote' | 'close' } {
  const legacy = d.onFill === 'flatten' ? 'close' : d.onFill;         // 'requote' | 'close' | undefined
  const onFillYes = d.onFillYes ?? legacy ?? 'requote';
  const onFillNo  = d.onFillNo  ?? legacy ?? 'requote';
  return { onFillYes, onFillNo };
}
const toLegacy = (rule: 'requote' | 'close'): 'requote' | 'flatten' => (rule === 'close' ? 'flatten' : 'requote');

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
  const { onFillYes, onFillNo } = resolveFillRules(d);
  const onFill = toLegacy(onFillYes);   // keep legacy column populated for one release

  const saved = await prisma.rewardsPlacement.upsert({
    where:  { userId_marketId: { userId, marketId: d.marketId } },
    create: {
      userId, marketId: d.marketId, venue: d.venue, side: d.side,
      qtyPerSide: d.qtyPerSide, distanceC: d.distanceC,
      onFillYes, onFillNo, onFill,
      newsMode: d.newsMode, maxInventoryUsd: d.maxInventoryUsd, mode: 'paper',   // paper-only, live OFF
    },
    update: {
      venue: d.venue, side: d.side, qtyPerSide: d.qtyPerSide, distanceC: d.distanceC,
      onFillYes, onFillNo, onFill, newsMode: d.newsMode, maxInventoryUsd: d.maxInventoryUsd, mode: 'paper',
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
