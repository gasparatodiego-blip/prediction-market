import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import prisma from '@/lib/prisma';
// The on-fill rule vocabulary is owned by the maker (it is the module that ACTS on it), not by this
// route. Importing the normalizer here is what keeps the column the engine reads and the value the UI
// writes the same three words — and it maps the legacy 'requote'/'flatten' rows without a migration.
import { normalizeFillRule } from '@/lib/maker/fill-policy';

export const dynamic = 'force-dynamic';

// Persisted liquidity-reward LEGS — the individual placed price levels + their
// follow/pinned preference, keyed (book:kind:price) to mirror the client LegBook +
// fillRules. These were client-only React state; persisting them lets agent34 track
// per-leg drift across sessions.
//
// PRIVACY / ENTITLEMENT:
//   • Auth required. Every query is scoped by userId — one user can NEVER read or
//     mutate another's legs (the @@unique and every where-clause include userId).
//   • Responses pass through redactForTier('rewards-legs') for path parity with the
//     rest of the paid surface (a user's own config is not itself gated).
//   • Leg CONTENTS are never logged — only counts. No console.log of prices/legs.

const leg = z.object({
  book:    z.enum(['yes', 'no']),
  kind:    z.enum(['buy', 'sell']),
  price:   z.number().gt(0).lt(1),
  mode:    z.enum(['follow', 'pinned']).default('follow'),
  offsetC: z.number().min(-100).max(100).default(0),
  // Per-side on-fill rule. The canonical vocabulary is close | opposite | hold (lib/maker/fill-policy);
  // the legacy 'requote' (≡ opposite) and 'flatten' (≡ close) are still ACCEPTED so rows written before
  // the rule became operative keep working, and every value is normalized before it is persisted — the
  // column the maker reads never holds a fourth spelling. RewardsLeg.onFill is a String, so widening the
  // vocabulary needs no schema migration.
  onFill:  z.enum(['close', 'opposite', 'hold', 'requote', 'flatten'])
            .default('opposite')
            .transform((v) => normalizeFillRule(v)),
});

const putSchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  venue:    z.enum(['polymarket', 'kalshi']),
  legs:     z.array(leg).max(200),   // one market's full desired leg set (bulk reconcile)
});

function legKey(l: { book: string; kind: string; price: number }): string {
  return `${l.book}:${l.kind}:${l.price}`;
}

// GET → this user's legs for ?marketId= (or all of the user's legs if omitted).
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;
  const isPaid = await getIsPaid(session);

  const marketId = req.nextUrl.searchParams.get('marketId');
  const legs = await prisma.rewardsLeg.findMany({
    where:   marketId ? { userId, marketId } : { userId },
    orderBy: [{ marketId: 'asc' }, { book: 'asc' }, { kind: 'asc' }, { price: 'asc' }],
  });
  return NextResponse.json(redactForTier({ legs }, 'rewards-legs', isPaid));
}

// PUT → bulk reconcile: make this user's legs for a market EXACTLY the provided set.
// Mirrors the client reconcile effect — upsert the desired levels, delete the rest,
// no orphans, no missing entries. One transaction so a partial failure never leaves
// a half-reconciled market.
export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    // Never echo the body (it is user leg data) — only the validation message.
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const { marketId, venue, legs } = parsed.data;

  // De-dup by (book:kind:price) so two identical levels can't collide on the unique key.
  const desired = new Map<string, typeof legs[number]>();
  for (const l of legs) desired.set(legKey(l), l);
  const keep = new Set(Array.from(desired.keys()));

  const saved = await prisma.$transaction(async (tx) => {
    const existing = await tx.rewardsLeg.findMany({ where: { userId, marketId } });
    // Drop levels the user removed.
    const toDelete = existing.filter((e) => !keep.has(legKey(e))).map((e) => e.id);
    if (toDelete.length) await tx.rewardsLeg.deleteMany({ where: { id: { in: toDelete }, userId } });
    // Upsert every desired level (create new, update prefs on existing).
    for (const l of Array.from(desired.values())) {
      await tx.rewardsLeg.upsert({
        where:  { userId_marketId_book_kind_price: { userId, marketId, book: l.book, kind: l.kind, price: l.price } },
        create: { userId, marketId, venue, book: l.book, kind: l.kind, price: l.price, mode: l.mode, offsetC: l.offsetC, onFill: l.onFill },
        update: { venue, mode: l.mode, offsetC: l.offsetC, onFill: l.onFill },
      });
    }
    return tx.rewardsLeg.findMany({
      where:   { userId, marketId },
      orderBy: [{ book: 'asc' }, { kind: 'asc' }, { price: 'asc' }],
    });
  });

  return NextResponse.json({ legs: saved, count: saved.length });
}

// DELETE → remove this user's legs for ?marketId= (whole market), scoped to the user.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

  const res = await prisma.rewardsLeg.deleteMany({ where: { userId, marketId } });
  return NextResponse.json({ deleted: res.count });
}
