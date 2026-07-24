import { NextRequest, NextResponse } from 'next/server'
import { revokeRow, getLast4, getPublicRow } from '@/lib/venue-maker-keys'
import { appendAudit } from '@/lib/key-custody-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * DELETE /api/settings/keys/:id — REVOKE: delete the row and zero its wrapped DEK.
 * Middleware has already gated this to an admin session.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params?.id
  if (!id) return NextResponse.json({ error: 'Missing key id.' }, { status: 400 })

  // Capture venue + last4 BEFORE deletion so the audit line is accurate.
  const row = await getPublicRow(id)
  const last4 = await getLast4(id)

  const removed = await revokeRow(id)
  if (!removed) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  await appendAudit({
    venue: row?.venue ?? 'unknown',
    action: 'revoked',
    outcome: 'revoked',
    last4,
  })

  return NextResponse.json({ ok: true })
}
