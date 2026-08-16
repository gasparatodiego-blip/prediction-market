import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// ── Manual close-override on a COPY-ENGINE (paper) position ──────────────────────
// Always available regardless of engine state. This endpoint only INSERTS a pending
// CopyCloseOverride row; agent21 (the sole writer of paper-positions.json) applies it
// on its next cycle, logs it origin 'user_override', and marks it applied/already_closed.
// Race handling lives in the engine: an override that arrives after the engine already
// closed the position no-ops cleanly (marked 'already_closed'), never double-closes.
//
// positionId format (from /api/copy/paper): `${userId}|${walletAddr}::${cid}|${outcome}`.

const schema = z.object({
  positionId:   z.string().trim().min(3).max(400),
  closePercent: z.number().int().min(1).max(100),   // 100 = full close
});

// Parse `${userId}|${walletAddr}::${cid}|${outcome}` — split on the FIRST '::', then the
// FIRST '|' of each half (userId is a cuid and walletAddr/cid are 0x…, so neither the
// left of '::' nor cid contains a '|'; only outcome text is unbounded and comes last).
function parsePositionId(positionId: string): { userId: string; walletAddr: string; cid: string; outcome: string } | null {
  const sep = positionId.indexOf('::');
  if (sep < 0) return null;
  const configKey = positionId.slice(0, sep);
  const posKey    = positionId.slice(sep + 2);
  const p1 = configKey.indexOf('|');
  const p2 = posKey.indexOf('|');
  if (p1 < 0 || p2 < 0) return null;
  const userId     = configKey.slice(0, p1);
  const walletAddr = configKey.slice(p1 + 1);
  const cid        = posKey.slice(0, p2);
  const outcome    = posKey.slice(p2 + 1);
  if (!userId || !walletAddr || !cid || !outcome) return null;
  return { userId, walletAddr, cid, outcome };
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const { positionId, closePercent } = parsed.data;

  const p = parsePositionId(positionId);
  if (!p) return NextResponse.json({ error: 'malformed positionId' }, { status: 400 });
  // Authorization: a user can only close their OWN copy positions.
  if (p.userId !== userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const override = await prisma.copyCloseOverride.create({
    data: {
      userId, positionId, walletAddr: p.walletAddr.toLowerCase(),
      cid: p.cid, outcome: p.outcome, closePercent, status: 'pending', origin: 'user_override',
    },
  });

  // Honest about latency: the durable close is applied by the engine on its next cycle
  // (≤5 min); the UI overlays this pending intent immediately so the user sees it queued.
  return NextResponse.json({
    ok: true,
    queued: true,
    overrideId: override.id,
    positionId,
    closePercent,
    fullClose: closePercent >= 100,
    note: 'Close queued — applies on the next engine sync (≤5 min). Remaining size stays engine-managed.',
  });
}

// GET → this user's recent close-overrides (status + result), for the UI to reflect
// pending/applied/already_closed state per position.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const overrides = await prisma.copyCloseOverride.findMany({
    where:   { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take:    100,
  });
  return NextResponse.json({ ok: true, overrides });
}
