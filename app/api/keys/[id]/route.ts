import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/keys/:id — REVOKE. Sets revokedAt; the row survives.
 *
 * Never a hard delete: a key that once had account access stays auditable after it is
 * retired. "Delete" is the user's word for it; revocation is what actually happens.
 *
 * OWNERSHIP: the update is scoped by { id, userId } in a single updateMany, so another
 * user's row cannot be touched — there is no window between a read and a write where
 * the check could be skipped. A miss is reported as 403 (not 404) without ever
 * revealing whether that id exists.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  const id = params?.id
  if (!id) return NextResponse.json({ error: 'Missing key id.' }, { status: 400 })

  // Scoped by userId. A row belonging to someone else simply does not match.
  const res = await prisma.exchangeKey.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  if (res.count === 0) {
    // Either it is not theirs, does not exist, or is already revoked. Deliberately one
    // response for all three: distinguishing them would let a caller probe for the
    // existence of other users' key ids.
    const alreadyMine = await prisma.exchangeKey.count({ where: { id, userId } })
    if (alreadyMine > 0) {
      return NextResponse.json({ ok: true, alreadyRevoked: true })
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({ ok: true, revoked: true })
}

/**
 * GET /api/keys/:id — the caller's own row only. Never a key, secret, or passphrase.
 * Present so cross-user access is enforced (and testable) on a single-row read too.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  const row = await prisma.exchangeKey.findFirst({
    where: { id: params?.id, userId }, // ownership in the query, not in a later branch
    select: {
      id: true,
      venue: true,
      label: true,
      permissionsAtVerify: true,
      verifiedAt: true,
      createdAt: true,
      revokedAt: true,
    },
  })

  if (!row) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(row)
}
