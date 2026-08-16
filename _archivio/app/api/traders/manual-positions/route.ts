import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// ── Manual-position lane API ────────────────────────────────────────────────────
// A lane the COPY ENGINE NEVER READS OR TOUCHES. Rows live in the ManualPosition
// Postgres table (its own key namespace); agent21-copy-watcher has no code path to
// this table (grep-provable). `source:'manual'` on every row is defense-in-depth,
// redundant with that physical separation. traderId is context only (which trader's
// page it was added from), NEVER a copy link — nothing here mirrors or auto-manages.

const MAX_MANUAL_PER_USER = 200;   // sane cap; a manual lane is not a bulk importer

const addSchema = z.object({
  traderId:    z.string().trim().regex(/^0x[a-fA-F0-9]{6,}$/i, 'invalid trader address'),
  market:      z.string().trim().min(1).max(300),
  conditionId: z.string().trim().max(120).nullable().optional(),
  outcome:     z.string().trim().min(1).max(40).default('—'),
  side:        z.enum(['BUY', 'SELL']),
  entryPrice:  z.number().gt(0).lt(1),        // executable outcome price 0<p<1 — no midpoint, no fabrication
  size:        z.number().gt(0).max(1e9),     // shares
});

// GET → this user's manual positions (optionally filtered to one trader's page).
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const traderId = searchParams.get('traderId');

  const positions = await prisma.manualPosition.findMany({
    where:   { userId: session.user.id, ...(traderId ? { traderId: traderId.toLowerCase() } : {}) },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ ok: true, lane: 'manual', engineManaged: false, positions });
}

// POST → add a manual position. Always tagged source:'manual', status:'open'.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const parsed = addSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const d = parsed.data;

  const count = await prisma.manualPosition.count({ where: { userId } });
  if (count >= MAX_MANUAL_PER_USER) {
    return NextResponse.json({ error: `Manual-position limit reached (${count}/${MAX_MANUAL_PER_USER}).` }, { status: 403 });
  }

  const created = await prisma.manualPosition.create({
    data: {
      userId,
      traderId:    d.traderId.toLowerCase(),
      market:      d.market,
      conditionId: d.conditionId ?? null,
      outcome:     d.outcome,
      side:        d.side,
      entryPrice:  d.entryPrice,
      size:        d.size,
      source:      'manual',   // redundant with table separation — defense in depth
      status:      'open',
    },
  });

  return NextResponse.json({ ok: true, position: created });
}

// PATCH → manual partial/full close of a MANUAL position (this lane's own override,
// entirely independent of the copy engine). { id, closePercent } 1–100.
const closeSchema = z.object({
  id:           z.string().trim().min(1),
  closePercent: z.number().int().min(1).max(100),
});

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const parsed = closeSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const { id, closePercent } = parsed.data;

  const pos = await prisma.manualPosition.findFirst({ where: { id, userId } });
  if (!pos) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (pos.status === 'closed' || pos.closedPct >= 100) {
    return NextResponse.json({ ok: true, alreadyClosed: true, position: pos });   // idempotent, never a double-close
  }

  const remainingPct = Math.max(0, 100 - pos.closedPct);
  const applyPct     = Math.min(closePercent, remainingPct);
  const newClosedPct = Math.min(100, pos.closedPct + applyPct);
  const newSize      = Math.max(0, pos.size * (1 - newClosedPct / 100));
  const fullyClosed  = newClosedPct >= 100;

  const updated = await prisma.manualPosition.update({
    where: { id: pos.id },
    data:  { closedPct: newClosedPct, size: newSize, status: fullyClosed ? 'closed' : 'open' },
  });

  return NextResponse.json({ ok: true, closedPct: newClosedPct, remainingSize: newSize, position: updated });
}

// DELETE → remove a manual position (scoped to this user).
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const res = await prisma.manualPosition.deleteMany({ where: { id, userId } });
  return NextResponse.json({ ok: true, deleted: res.count });
}
